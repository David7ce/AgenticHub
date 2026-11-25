// costs.mjs — recover token usage from local agent histories without reading prompt text.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { PROJECTS_DIR, resolveRoot } from './paths.mjs';
import { estimateGoLocal, GO_WINDOWS } from './subscription-usage.mjs';

export const COST_LEDGER_VERSION = 2;
export const COST_LEDGER_PATH = join(PROJECTS_DIR, 'working', 'costs.json');
export const COST_REPORT_PATH = join(PROJECTS_DIR, 'working', 'COSTS.md');

const TOKEN_FIELDS = [
  'input_tokens',
  'cache_write_tokens',
  'cache_read_tokens',
  'output_tokens',
  'reasoning_tokens',
  'unknown_tokens',
];

const EMPTY_TOKENS = () => Object.fromEntries(TOKEN_FIELDS.map((field) => [field, 0]));
const require = createRequire(import.meta.url);
let DatabaseSync = null;

function sqliteDatabaseClass() {
  if (DatabaseSync) return DatabaseSync;
  try {
    DatabaseSync = require('node:sqlite').DatabaseSync;
    return DatabaseSync;
  } catch {
    return null;
  }
}

function numeric(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function utcDate(value) {
  if (value === null || value === undefined || value === '') return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}

function utcParts(value) {
  if (value === null || value === undefined || value === '') return { date: null, hour: null };
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime())
    ? { date: null, hour: null }
    : { date: date.toISOString().slice(0, 10), hour: date.getUTCHours() };
}

function epochParts(value) {
  const n = numeric(value);
  return n ? utcParts(n > 1e12 ? n : n * 1000) : { date: null, hour: null };
}

function sourceStatus({
  available = false, records = 0, files = 0, firstDate = null, lastDate = null, note = '', tokens = null,
} = {}) {
  return { available, records, files, firstDate, lastDate, note, tokens };
}

function collectFiles(root, extension = '.jsonl') {
  if (!existsSync(root)) return [];
  const files = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) stack.push(path);
      else if (entry.isFile() && extname(entry.name).toLowerCase() === extension) files.push(path);
    }
  }
  return files.sort();
}

function isWithin(parent, child) {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

/**
 * A stable, non-personal project label for a working directory.
 * Paths outside the workspace (especially random temp worktrees) are not stored.
 */
export function projectLabel(cwd, workspaceRoot = resolveRoot()) {
  if (typeof cwd !== 'string' || !cwd.trim()) return 'unknown-project';
  const resolved = resolve(cwd);
  const root = resolve(workspaceRoot);
  const temp = resolve(tmpdir());
  const inWorkspace = isWithin(root, resolved);
  if (!inWorkspace && isWithin(temp, resolved)) return 'temporary';

  const lower = resolved.toLowerCase();
  const marker = `${sep}.git${sep}agent-worktrees${sep}`;
  const markerAt = lower.indexOf(marker);
  let candidate = markerAt >= 0 ? resolved.slice(0, markerAt) : resolved;
  if (markerAt >= 0 && existsSync(candidate)) {
    // Hub worktrees are nested under their repository's .git directory.
  }

  if (isWithin(root, candidate)) {
    let current = candidate;
    while (isWithin(root, current) && current !== root) {
      if (existsSync(join(current, '.git'))) break;
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
    if (current !== root && existsSync(join(current, '.git'))) candidate = current;
    const rel = relative(root, candidate).split(sep).filter(Boolean).join('/');
    return rel || 'workspace-root';
  }

  return `external/${basename(candidate) || 'unknown'}`;
}

function addObservation(groups, dimensions, tokens, sessionId = null) {
  const { date, hour = null, source, agent, model, project } = dimensions;
  if (!date) return;
  const key = [date, hour ?? '?', source, agent, model, project].join('\u001f');
  let row = groups.get(key);
  if (!row) {
    row = {
      date, hour: Number.isInteger(hour) ? hour : null, source, agent, model, project,
      ...EMPTY_TOKENS(),
      observations: 0,
      sessions: 0,
      _sessions: new Set(),
    };
    groups.set(key, row);
  }
  for (const field of TOKEN_FIELDS) row[field] += numeric(tokens[field]);
  row.observations += 1;
  if (sessionId && !row._sessions.has(sessionId)) {
    row._sessions.add(sessionId);
    row.sessions += 1;
  } else if (!sessionId) {
    row.sessions += 1;
  }
}

function finishGroups(groups) {
  return [...groups.values()]
    .map(({ _sessions, ...row }) => row)
    .sort((a, b) => a.date.localeCompare(b.date)
      || ((a.hour ?? -1) - (b.hour ?? -1))
      || a.source.localeCompare(b.source)
      || a.agent.localeCompare(b.agent)
      || a.model.localeCompare(b.model)
      || a.project.localeCompare(b.project));
}

function dateRange(dates) {
  const valid = dates.filter(Boolean).sort();
  return { firstDate: valid[0] ?? null, lastDate: valid.at(-1) ?? null };
}

function readJsonLines(path) {
  const out = [];
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return out;
  }
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // A partial final line is expected if the agent was writing during scan.
    }
  }
  return out;
}

function usageTokens(usage) {
  return {
    input_tokens: numeric(usage.input_tokens ?? usage.inputTokens),
    cache_write_tokens: numeric(usage.cache_creation_input_tokens ?? usage.cacheCreationInputTokens),
    cache_read_tokens: numeric(usage.cache_read_input_tokens ?? usage.cacheReadInputTokens),
    output_tokens: numeric(usage.output_tokens ?? usage.outputTokens),
    reasoning_tokens: numeric(usage.thinking_tokens ?? usage.thinkingTokens ?? usage.reasoning_tokens ?? usage.reasoningTokens),
    unknown_tokens: 0,
  };
}

/** Claude Code: message usage snapshots repeat while streaming, so dedupe by session + message id. */
export function collectClaudeUsage({
  projectsDir = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'projects'),
  workspaceRoot = resolveRoot(),
} = {}) {
  const files = collectFiles(projectsDir);
  const messages = new Map();
  for (const file of files) {
    for (const record of readJsonLines(file)) {
      const message = record.message;
      const usage = message?.usage;
      const model = message?.model;
      if (!usage || typeof model !== 'string' || !model || model === '<synthetic>') continue;
      const messageId = message.id || record.requestId;
      if (!messageId) continue;
      const sessionId = record.sessionId || basename(file, '.jsonl');
      const key = `${sessionId}\u001f${messageId}`;
      const previous = messages.get(key);
      const timestamp = utcParts(record.timestamp);
      messages.set(key, {
        sessionId,
        date: timestamp.date || previous?.date || null,
        hour: timestamp.hour ?? previous?.hour ?? null,
        cwd: record.cwd || previous?.cwd,
        model,
        tokens: usageTokens(usage),
      });
    }
  }

  const groups = new Map();
  const dates = [];
  const sessionIds = new Set();
  for (const item of messages.values()) {
    if (!item.date) continue;
    dates.push(item.date);
    sessionIds.add(item.sessionId);
    addObservation(groups, {
      date: item.date,
      hour: item.hour,
      source: 'claude-code',
      agent: 'claude',
      model: item.model,
      project: projectLabel(item.cwd, workspaceRoot),
    }, item.tokens, item.sessionId);
  }
  return {
    rows: finishGroups(groups),
    status: sourceStatus({
      available: files.length > 0,
      records: messages.size,
      files: files.length,
      ...dateRange(dates),
      note: `${sessionIds.size} sesiones; mensajes sin contenido, deduplicados por id y hora UTC del mensaje`,
    }),
  };
}

function decodeModel(value) {
  if (typeof value !== 'string' || !value) return 'unknown-model';
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === 'object') {
      const id = parsed.id || parsed.model || 'unknown-model';
      const provider = parsed.providerID || parsed.provider;
      return provider ? `${id} (${provider})` : id;
    }
  } catch {
    // Older OpenCode databases may store a plain model id.
  }
  return value;
}

function tableColumns(db, table) {
  try {
    return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name));
  } catch {
    return new Set();
  }
}

/** OpenCode: read only session aggregates from its local SQLite database. */
export function collectOpenCodeUsage({
  dbPath = join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'opencode', 'opencode.db'),
  workspaceRoot = resolveRoot(),
} = {}) {
  if (!existsSync(dbPath)) {
    return { rows: [], status: sourceStatus({ note: 'No se encontró la base de sesiones local.' }) };
  }
  const Database = sqliteDatabaseClass();
  if (!Database) {
    return { rows: [], status: sourceStatus({ available: true, note: 'Este Node no ofrece node:sqlite; no se leyeron sesiones.' }) };
  }
  let db;
  try {
    db = new Database(dbPath, { readOnly: true });
    const columns = tableColumns(db, 'session_v2');
    if (!columns.has('id') || !columns.has('time_created')) {
      return { rows: [], status: sourceStatus({ available: true, note: 'La base no contiene una tabla session_v2 compatible.' }) };
    }
    const wanted = [
      'id', 'directory', 'agent', 'model', 'time_created',
      'tokens_input', 'tokens_output', 'tokens_reasoning', 'tokens_cache_read', 'tokens_cache_write',
    ];
    const select = wanted.filter((column) => columns.has(column));
    const rowsInDb = db.prepare(`SELECT ${select.join(', ')} FROM session_v2 ORDER BY time_created`).all();
    const groups = new Map();
    const dates = [];
    const sessions = new Map();
    for (const session of rowsInDb) {
      const { date, hour } = epochParts(session.time_created);
      if (!date) continue;
      dates.push(date);
      const dimensions = {
        date,
        hour,
        source: 'opencode',
        agent: 'opencode',
        model: decodeModel(session.model),
        project: projectLabel(session.directory, workspaceRoot),
      };
      const tokens = {
        input_tokens: numeric(session.tokens_input),
        cache_write_tokens: numeric(session.tokens_cache_write),
        cache_read_tokens: numeric(session.tokens_cache_read),
        output_tokens: numeric(session.tokens_output),
        reasoning_tokens: numeric(session.tokens_reasoning),
        unknown_tokens: 0,
      };
      addObservation(groups, dimensions, tokens, String(session.id));
      sessions.set(String(session.id), { dimensions, tokens, measured: EMPTY_TOKENS() });
    }
    const rows = finishGroups(groups);
    const attribution = openCodeAttribution(db, sessions, dates);
    return {
      rows,
      attribution: attribution && { ...attribution, covered: rows },
      status: sourceStatus({
        available: true,
        records: rowsInDb.length,
        files: 1,
        ...dateRange(dates),
        note: 'Agregados por sesión; fecha y hora UTC son su inicio. El coste monetario no se lee.',
      }),
    };
  } catch (error) {
    return { rows: [], status: sourceStatus({ available: true, note: `No se pudo leer la base: ${error.message}` }) };
  } finally {
    db?.close();
  }
}

/** Read response metadata only; don't assign a switched session's whole total to its final model. */
function openCodeAttribution(db, sessions, dates) {
  const columns = tableColumns(db, 'session_message');
  if (!['session_id', 'type', 'time_created', 'data'].every((k) => columns.has(k)) || !dates.length) return null;
  const messages = db.prepare(`
    SELECT session_id, time_created,
      json_extract(data, '$.model.id') model, json_extract(data, '$.model.providerID') provider,
      json_extract(data, '$.tokens.input') input_tokens, json_extract(data, '$.tokens.output') output_tokens,
      json_extract(data, '$.tokens.reasoning') reasoning_tokens, json_extract(data, '$.tokens.cache.read') cache_read_tokens,
      json_extract(data, '$.tokens.cache.write') cache_write_tokens
    FROM session_message WHERE type = 'assistant' AND json_valid(data) AND json_type(data, '$.tokens') = 'object'
  `);
  const groups = new Map();
  for (const msg of messages.iterate()) {
    const s = sessions.get(String(msg.session_id));
    if (!s || !TOKEN_FIELDS.some((f) => numeric(msg[f]) > 0)) continue;
    const model = msg.model && msg.provider ? `${msg.model} (${msg.provider})` : 'unknown-model';
    for (const f of TOKEN_FIELDS) s.measured[f] += numeric(msg[f]);
    const at = epochParts(msg.time_created);
    addObservation(groups, { ...s.dimensions, ...(at.date ? at : {}), model }, msg, String(msg.session_id));
  }
  for (const [id, s] of sessions) {
    const remainder = Object.fromEntries(TOKEN_FIELDS.map((f) => [f, Math.max(0, s.tokens[f] - s.measured[f])]));
    if (!TOKEN_FIELDS.some((f) => remainder[f] > 0)) continue;
    // Totals without response metadata cannot tell which model was billed.
    addObservation(groups, { ...s.dimensions, model: 'unknown-model' }, remainder, id);
  }
  const first = dates.reduce((a, b) => a < b ? a : b);
  return { first, rows: finishGroups(groups) };
}

/** Reconcile response-based history with the older aggregate, without adding both. */
export function subscriptionHistory(ledger) {
  const { rows = [], openCodeAttribution } = ledger ?? {};
  if (!openCodeAttribution) return rows;
  const legacy = rows.filter((r) => r.source !== 'opencode' || r.date < openCodeAttribution.first);
  if (!openCodeAttribution.covered) return [...legacy, ...openCodeAttribution.rows];
  const groupCoarse = (items) => {
    const groups = new Map();
    for (const row of items) {
      const dimensions = { ...row, model: 'unknown-model' };
      addObservation(groups, dimensions, row);
      if (TOKEN_FIELDS.some((f) => numeric(row[f]) > 0)) {
        const coarse = groups.get(rowKey(dimensions));
        (coarse.models ??= new Set()).add(row.model);
      }
    }
    return groups;
  };
  const covered = groupCoarse(openCodeAttribution.covered);
  const previous = groupCoarse(rows.filter((r) => r.source === 'opencode' && r.date >= openCodeAttribution.first));
  for (const [key, row] of previous) {
    for (const f of TOKEN_FIELDS) row[f] = Math.max(0, row[f] - numeric(covered.get(key)?.[f]));
    if (!TOKEN_FIELDS.some((f) => row[f] > 0)) {
      previous.delete(key);
      continue;
    }
    // A unanimous older session label is useful as an estimate, but mixed
    // labels (including API/unknown) do not prove which subscription paid.
    const models = new Set([...(row.models ?? []), ...(covered.get(key)?.models ?? [])]);
    const [model] = models;
    if (models.size === 1 && / \(opencode-go\)$/.test(model)) {
      row.model = model;
      row.inferred = true;
    }
    delete row.models;
  }
  return [...legacy, ...openCodeAttribution.rows, ...finishGroups(previous)];
}

function findCodexDatabases(codexDir) {
  if (!existsSync(codexDir)) return [];
  return readdirSync(codexDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /^state_.*\.sqlite$/i.test(entry.name))
    .map((entry) => join(codexDir, entry.name))
    .sort();
}

/** Codex currently exposes only a per-thread total in its local state database. */
export function collectCodexUsage({
  codexDir = join(homedir(), '.codex'),
  workspaceRoot = resolveRoot(),
} = {}) {
  const databases = findCodexDatabases(codexDir);
  const groups = new Map();
  const dates = [];
  let records = 0;
  let files = 0;
  const Database = sqliteDatabaseClass();
  if (!Database) {
    return {
      rows: [],
      status: sourceStatus({ note: 'Este Node no ofrece node:sqlite; no se leyeron hilos Codex.' }),
    };
  }
  for (const dbPath of databases) {
    let db;
    try {
      db = new Database(dbPath, { readOnly: true });
      const columns = tableColumns(db, 'threads');
      if (!columns.has('id') || !columns.has('tokens_used')) continue;
      const wanted = ['id', 'cwd', 'model', 'model_provider', 'created_at_ms', 'created_at', 'tokens_used'];
      const select = wanted.filter((column) => columns.has(column));
      const threads = db.prepare(`SELECT ${select.join(', ')} FROM threads`).all();
      files += 1;
      for (const thread of threads) {
        const { date, hour } = epochParts(thread.created_at_ms ?? thread.created_at);
        if (!date) continue;
        records += 1;
        dates.push(date);
        addObservation(groups, {
          date,
          hour,
          source: 'codex',
          agent: 'codex',
          model: thread.model ? `${thread.model} (${thread.model_provider || 'unknown-provider'})` : 'unknown-model',
          project: projectLabel(thread.cwd, workspaceRoot),
        }, { ...EMPTY_TOKENS(), unknown_tokens: numeric(thread.tokens_used) }, String(thread.id));
      }
    } catch {
      // Some installations have state databases without the current threads schema.
    } finally {
      db?.close();
    }
  }
  const rollouts = [
    join(codexDir, 'sessions'),
    join(codexDir, 'archived_sessions'),
  ].flatMap((dir) => collectFiles(dir));
  return {
    rows: finishGroups(groups),
    status: sourceStatus({
      available: databases.length > 0 || rollouts.length > 0,
      records,
      files: files + rollouts.length,
      ...dateRange(dates),
      note: rollouts.length
        ? `${rollouts.length} transcripciones encontradas; se leen los totales por thread de SQLite, no el desglose de los rollouts.`
        : records
          ? 'Total de tokens por thread, asignado a su hora UTC de inicio; input/output no recuperables por separado.'
          : 'Base local disponible, pero no hay threads guardados para recuperar tokens.',
    }),
  };
}

/**
 * Hub audit log: per-turn attribution. Since 2026-11-25 each line carries
 * `usage` (the turn's tokens, read from the agent's own store). These numbers
 * are NOT added to the provider totals: both describe the same tokens, and the
 * provider scan is the volume of record. They join by `sessionId`; the audit
 * line is what says which task, label and tree a turn belonged to.
 */
export function collectAgentHubCoverage(logPath = join(PROJECTS_DIR, 'logs', 'runs.jsonl')) {
  if (!existsSync(logPath)) {
    return { status: sourceStatus({ note: 'No existe el registro local de ejecuciones.' }) };
  }
  const records = readJsonLines(logPath);
  const dates = records.map((record) => utcDate(record.time)).filter(Boolean);
  const withUsage = records.filter((record) => record.usage && record.usage.confidence
    && record.usage.confidence !== 'unavailable');
  const tokens = { ...EMPTY_TOKENS(), turns: withUsage.length };
  for (const record of withUsage) {
    for (const field of TOKEN_FIELDS) tokens[field] += numeric(record.usage[field]);
  }
  return {
    status: sourceStatus({
      available: true,
      records: records.length,
      files: 1,
      ...dateRange(dates),
      tokens,
      note: withUsage.length
        ? `${withUsage.length} ejecuciones traen tokens por turno; es atribución, no volumen: no se suma al escaneo del proveedor (se unen por sessionId).`
        : 'El log contiene ejecuciones/costes, pero no tokens; no se incluye en los totales.',
    }),
  };
}

// ---------------------------------------------------------------- limits

const HOUR = 3_600_000;
const WINDOW_5H = 5;
const WINDOW_WEEK = 168;

/**
 * Tokens that cost allowance: input + output + cache writes, plus totals a
 * source cannot split (Codex reports one undisclosed total per thread).
 * Cache reads are shown apart.
 */
export function workTokens(row) {
  return numeric(row.input_tokens) + numeric(row.output_tokens) + numeric(row.cache_write_tokens)
    + numeric(row.unknown_tokens);
}

/**
 * The published cache read is a fraction of the fresh-input price, and a plan
 * window rations it at a fraction too — but nobody publishes that fraction per
 * plan. 0.1 is the order of magnitude the providers quote; `fitCacheWeight()`
 * replaces it with the owner's own number once a limit hit is on record.
 */
export const DEFAULT_CACHE_WEIGHT = 0.1;

/** The weight to use for an agent: the owner's `local/limits.json` wins. */
export function cacheWeight(config = {}, agent = 'claude') {
  const raw = config?.[agent]?.cacheWeight ?? config?.cacheWeight;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : DEFAULT_CACHE_WEIGHT;
}

/**
 * Tokens a plan actually rations: work tokens plus the cache reads at their
 * weight. This is an estimate, and the page says so; it is not a bill.
 */
export function quotaTokens(tokens, weight = DEFAULT_CACHE_WEIGHT) {
  return workTokens(tokens) + Math.round(weight * numeric(tokens.cache_read_tokens));
}

/** Per-hour work and cache reads for one agent, from hourly rows only. */
function agentHours(rows, agent = 'claude') {
  const hours = new Map();
  for (const row of rows) {
    if (row.agent !== agent || !Number.isInteger(row.hour) || !row.date) continue;
    const start = Date.parse(`${row.date}T00:00:00Z`) + row.hour * HOUR;
    if (!Number.isFinite(start)) continue;
    const current = hours.get(start) ?? { work: 0, cache: 0 };
    current.work += workTokens(row);
    current.cache += numeric(row.cache_read_tokens);
    hours.set(start, current);
  }
  return hours;
}

function sumField(hours, from, to, field) {
  let total = 0;
  for (const [start, value] of hours) if (start >= from && start < to) total += value[field];
  return total;
}

function heaviest(hours, span) {
  let best = { tokens: 0, start: null };
  for (const start of hours.keys()) {
    const tokens = sumField(hours, start, start + span * HOUR, 'work');
    if (tokens > best.tokens) best = { tokens, start: new Date(start).toISOString() };
  }
  return best;
}

/**
 * Claude's rolling 5-hour and 7-day usage, and the heaviest such windows on
 * record. `tokens` stays the work-only figure the tables always showed; `quota`
 * is the same window with cache reads at `weight`.
 */
export function claudeWindows(rows, now = new Date(), weight = DEFAULT_CACHE_WEIGHT) {
  const hours = agentHours(rows);
  const end = now.getTime();
  const window = (span) => {
    const from = end - span * HOUR;
    const work = sumField(hours, from, end, 'work');
    const cache = sumField(hours, from, end, 'cache');
    return {
      tokens: work,
      cache,
      quota: work + Math.round(weight * cache),
      start: new Date(from).toISOString(),
      end: new Date(end).toISOString(),
    };
  };
  return {
    window5h: window(WINDOW_5H),
    week: window(WINDOW_WEEK),
    record5h: heaviest(hours, WINDOW_5H),
    recordWeek: heaviest(hours, WINDOW_WEEK),
  };
}

/**
 * Solve the cache weight from real limit hits: with a known ceiling C and the
 * work and cache read in the window that hit it, w = (C - work) / cache.
 * One sample is a fit; more samples give a median and the residuals say whether
 * the model holds. No ceiling or no usable sample is an error, not a guess.
 */
export function fitCacheWeight({
  rows = [], hits = [], ceiling = null, agent = 'claude', windowHours = WINDOW_5H,
} = {}) {
  if (!numeric(ceiling)) return { error: 'no plan ceiling to fit against (projects/local/limits.json)' };
  if (!hits.length) return { error: 'no limit hit on record yet' };
  const hours = agentHours(rows, agent);
  const span = windowHours * HOUR;
  const samples = [];
  for (const hit of hits) {
    const at = Date.parse(hit);
    if (!Number.isFinite(at)) continue;
    const work = sumField(hours, at - span, at, 'work');
    const cache = sumField(hours, at - span, at, 'cache');
    if (cache <= 0) continue;
    const weight = (numeric(ceiling) - work) / cache;
    if (Number.isFinite(weight) && weight >= 0 && weight <= 1) samples.push(weight);
  }
  if (!samples.length) return { error: 'the hits have no cache reads in their window to weigh' };
  samples.sort((a, b) => a - b);
  const median = samples[Math.floor(samples.length / 2)];
  const weight = Math.round(median * 1_000) / 1_000;
  const residuals = hits
    .map((hit) => Date.parse(hit))
    .filter(Number.isFinite)
    .map((at) => {
      const predicted = sumField(hours, at - span, at, 'work')
        + Math.round(weight * sumField(hours, at - span, at, 'cache'));
      return {
        at: new Date(at).toISOString(),
        predicted,
        error: Math.round(((predicted - numeric(ceiling)) / numeric(ceiling)) * 1_000) / 1_000,
      };
    });
  return { weight, samples: samples.length, ceiling: numeric(ceiling), residuals };
}

// The short system message Claude Code writes when a plan limit stops a session.
// Anchored to the whole message: prose or prompts that merely quote it never match.
const LIMIT_HIT = /^(?:claude ai usage limit reached\|\d+|(?:\d+-hour|weekly|opus weekly|session) limit reached\s*[∙·]\s*resets\b.{0,60}|you've hit your (?:usage )?limit\b.{0,80})$/i;
const LIMIT_HIT_MAX = 160;

/** Only Claude Code's own error record counts — never user prompts, prose or subagent transcripts. */
function isLimitRecord(record) {
  if (record?.type !== 'assistant' || record.isSidechain) return false;
  if (record.isApiErrorMessage !== true && record.message?.model !== '<synthetic>') return false;
  const text = messageText(record.message).trim();
  return text.length <= LIMIT_HIT_MAX && LIMIT_HIT.test(text);
}

function messageText(message) {
  const content = message?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text).join('\n');
}

/** Times Claude Code hit a plan limit. The text is only tested, never kept. */
export function findLimitHits(
  projectsDir = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'projects'),
) {
  const hits = new Set();
  for (const file of collectFiles(projectsDir)) {
    for (const record of readJsonLines(file)) {
      if (!record?.timestamp || !record.message) continue;
      if (isLimitRecord(record)) hits.add(record.timestamp);
    }
  }
  return [...hits].sort();
}

/**
 * Claude's plan reference: the owner's own numbers in local/limits.json win;
 * otherwise the first observed limit hit gives the 5-hour ceiling actually
 * reached. Null until either exists: no public quota is invented.
 */
export function claudeReference(config = {}, hits = [], rows = []) {
  const own = config?.claude ?? {};
  if (numeric(own.window5h) || numeric(own.week)) {
    return {
      plan: own.plan ?? null,
      window5h: numeric(own.window5h) || null,
      week: numeric(own.week) || null,
      source: own.source || 'manual',
    };
  }
  const first = [...hits].sort()[0];
  if (!first) return null;
  const at = Date.parse(first);
  // Work tokens only: deriving a ceiling from the hit and then weighing the
  // same cache reads into it would be circular.
  const window5h = sumField(agentHours(rows), at - WINDOW_5H * HOUR, at, 'work');
  if (!window5h) return null; // a hit outside the ledger's hourly data says nothing about the ceiling
  return {
    plan: own.plan ?? null,
    window5h,
    week: null,
    source: `observed ${first.slice(0, 10)}`,
  };
}

export const LIMITS_CONFIG_PATH = join(PROJECTS_DIR, 'local', 'limits.json');
const HUBCTL = join(dirname(PROJECTS_DIR), 'agent-hub', 'hubctl', 'hubctl.mjs');

/** `hubctl usage --json`: Codex plan windows (asked to the account) and Go % per model. */
function hubctlUsage() {
  const result = spawnSync(process.execPath, [HUBCTL, 'usage', '--json', '--days', '30'], {
    encoding: 'utf8', timeout: 60_000, windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`hubctl usage exited ${result.status}: ${(result.stderr || '').trim().slice(0, 200)}`);
  return JSON.parse(result.stdout);
}

function readLimitsConfig(path = LIMITS_CONFIG_PATH) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return {};
  }
}

/**
 * The limits reading `costs --write` stores in the ledger. Codex and Go come
 * from hubctl (a failure leaves them null with the reason); Claude's part is
 * always computed locally from the ledger rows and the transcripts.
 */
export function collectLimits({
  rows = [],
  now = new Date(),
  runUsage = hubctlUsage,
  readConfig = readLimitsConfig,
  findHits = findLimitHits,
} = {}) {
  const config = readConfig() ?? {};
  let usage = null;
  let error = null;
  try {
    usage = runUsage();
  } catch (failure) {
    error = String(failure?.message ?? failure);
  }
  const summary = usage?.codex?.summary;
  const hits = findHits();
  return {
    measuredAt: now.toISOString(),
    codex: usage ? (summary ? {
      plan: summary.plan ?? null,
      source: usage.codex.source ?? null,
      measuredAt: summary.measuredAt ?? null,
      windows: (summary.windows ?? []).map((w) => ({
        label: w.label, usedPercent: w.usedPercent, resetsAt: w.resetsAt ?? null, windowMins: w.windowMins ?? null,
      })),
    } : null) : null,
    go: usage ? (usage.opencode?.models ?? []).map((m) => ({
      model: m.model, pct: Number.isFinite(m.pct) ? m.pct : null,
      cost: Number.isFinite(m.cost) ? m.cost : null, limit: m.limit ?? null,
    })) : null,
    goPlan: config.opencode?.plan ?? null,
    claude: {
      plan: config.claude?.plan ?? null,
      ...claudeWindows(rows, now, cacheWeight(config)),
      hits: hits.length,
      reference: claudeReference(config, hits, rows),
      // How much of a plan window cache reads eat. `fitted` only when the owner
      // wrote a ceiling in local/limits.json AND a hit is on record; otherwise
      // the published order of magnitude, labelled as a prior.
      quota: quotaWeight(config, rows, hits),
    },
    error,
  };
}

function quotaWeight(config, rows, hits) {
  const prior = cacheWeight(config);
  const own = config?.claude ?? {};
  const manual = Number(own.cacheWeight);
  if (Number.isFinite(manual) && manual >= 0 && manual <= 1) {
    return { weight: prior, source: 'manual', samples: 0 };
  }
  if (!numeric(own.window5h)) {
    return { weight: prior, source: 'prior', samples: 0, error: 'no plan ceiling in local/limits.json' };
  }
  const fitted = fitCacheWeight({ rows, hits, ceiling: own.window5h, agent: 'claude' });
  if (fitted.error) return { weight: prior, source: 'prior', samples: 0, error: fitted.error };
  return {
    weight: fitted.weight,
    source: 'fitted',
    samples: fitted.samples,
    ceiling: fitted.ceiling,
    residuals: fitted.residuals,
  };
}

/**
 * The limits reading for one `costs` run. A dry run stays local: it computes
 * Claude's part but does not ask the Codex account (that is `--write`'s job).
 */
export function limitsForRun({ write = false, ...options } = {}) {
  if (write) return collectLimits(options);
  return collectLimits({
    ...options,
    runUsage: () => { throw new Error('Codex/Go not read in a dry run; use --write'); },
  });
}

// ---------------------------------------------------------------- view

const HIGH = 0.8;
const STALE_MS = 6 * HOUR;
const AGENTS = ['claude', 'codex', 'opencode'];

function roomState(pct, resetsAt, now) {
  if (resetsAt && Date.parse(resetsAt) <= now.getTime()) return 'reset';
  if (pct === null || pct === undefined) return 'none';
  return pct >= HIGH ? 'high' : 'ok';
}

function roomRows(limits, now) {
  if (!limits) return [];
  const rows = [];
  const missing = (agent, label) => ({
    id: `${agent}-${label}`, agent, label, pct: null, source: 'unavailable', state: 'none',
  });
  const accounted = (agent, label, w, measuredAt, source = 'measured') => {
    if (!Number.isFinite(w?.usedPercent)) return missing(agent, label);
    const pct = w.usedPercent / 100;
    const resetsAt = w.resetsAt ?? null;
    const state = roomState(pct, resetsAt, now);
    return {
      id: `${agent}-${label}`, agent, label, pct: state === 'reset' ? null : pct,
      resetsAt, measuredAt, source, state,
    };
  };
  const codexWindows = limits.codex?.windows ?? [];
  const codexLabel = (w) => w.windowMins === 10080 || /^(weekly|semanal)$/i.test(w.label) ? 'week'
    : (w.windowMins >= 28 * 1440 && w.windowMins <= 31 * 1440) || /^(monthly|mensual)$/i.test(w.label) ? 'month' : w.label;
  for (const w of codexWindows) {
    rows.push(accounted('codex', codexLabel(w), w, limits.codex.measuredAt ?? limits.measuredAt));
  }
  if (limits.subscription) {
    for (const label of ['week', 'month']) {
      if (!rows.some((r) => r.agent === 'codex' && r.label === label)) rows.push(missing('codex', label));
    }
    for (const [, label] of GO_WINDOWS) {
      const manual = limits.subscription.goManual;
      const w = manual?.windows?.find((window) => window.label === label);
      rows.push(accounted('opencode', label, w, manual?.measuredAt, 'manual'));
    }
  }
  const go = new Map();
  for (const m of (limits.subscription ? [] : limits.go ?? [])) {
    const merged = go.get(m.model) ?? { model: m.model, pct: null, cost: 0, limit: m.limit };
    if (Number.isFinite(m.pct)) merged.pct = (merged.pct ?? 0) + m.pct;
    merged.cost += Number.isFinite(m.cost) ? m.cost : 0;
    go.set(m.model, merged);
  }
  for (const m of go.values()) {
    const pct = m.limit === null ? null : m.pct;
    rows.push({
      id: `opencode-${m.model}`, agent: 'opencode', label: m.model, pct, recordPct: null,
      used: m.cost, limit: m.limit, resetsAt: null, source: m.limit === null ? 'free' : 'estimated',
      state: roomState(pct, null, now), detail: '',
    });
  }
  const c = limits.claude;
  if (c) {
    const ref = c.reference;
    for (const [id, label, used, record, refLimit, end] of [
      ['claude-5h', '5h', c.window5h, c.record5h, ref?.window5h, c.window5h?.end],
      ['claude-week', '7d', c.week, c.recordWeek, ref?.week, c.week?.end],
    ]) {
      const account = limits.subscription?.claude;
      const snapshot = account?.windows?.find((w) => w.label === (label === '7d' ? 'week' : label));
      if (snapshot) {
        rows.push(accounted('claude', label, snapshot, account.measuredAt));
        continue;
      }
      // A plan window rations cache reads too, so the percentage is against
      // quota tokens; the work-only figure stays visible for comparison.
      const quota = used.quota ?? used.tokens;
      const pct = refLimit ? quota / refLimit : null;
      const recordPct = record?.tokens ? used.tokens / record.tokens : null;
      rows.push({
        id, agent: 'claude', label, pct, recordPct, used: used.tokens, quota, limit: refLimit ?? null,
        record: record?.tokens ?? 0, resetsAt: null, windowEnd: end ?? null,
        source: refLimit ? 'estimated' : 'record', refSource: ref?.source ?? null, plan: c.plan ?? null,
        // Being at your own record is not being near a limit: only a plan reference can alarm.
        state: pct === null ? (recordPct === null ? 'none' : 'ok') : roomState(pct, null, now), detail: '',
      });
    }
    if (limits.subscription) rows.push(missing('claude', 'month'));
  }
  return rows;
}

/** What the page needs from the server side: room left per plan window and data freshness. */
export function buildCostsView(ledger, now = new Date()) {
  const generated = Date.parse(ledger?.generatedAt ?? '');
  const room = roomRows(ledger?.limits, now);
  const goModels = ledger?.limits?.subscription?.goModels ?? [];
  const codexRows = (ledger?.rows ?? []).filter((r) => r.agent === 'codex' && r.source === 'codex');
  const codexDays = codexRows.map((r) => r.date).filter(Boolean).sort();
  const codexModels = new Map();
  for (const row of codexRows) codexModels.set(row.model, (codexModels.get(row.model) ?? 0) + workTokens(row));
  return {
    now: now.toISOString(),
    dataAt: ledger?.generatedAt ?? null,
    limitsAt: ledger?.limits?.measuredAt ?? null,
    stale: !Number.isFinite(generated) || now.getTime() - generated > STALE_MS,
    noLimits: !ledger?.limits,
    limitsError: ledger?.limits?.error ?? null,
    goModels,
    goLocal: estimateGoLocal(subscriptionHistory(ledger), goModels, now),
    openAiViaChatGpt: ledger?.limits?.subscription?.openAiViaChatGpt === true,
    codexAccount: ledger?.limits?.subscription?.codexAccount ?? null,
    codexLocal: codexDays.length ? {
      tokens: codexRows.reduce((sum, row) => sum + workTokens(row), 0),
      first: codexDays[0], last: codexDays.at(-1), sessions: ledger?.sources?.codex?.records ?? null,
      models: [...codexModels].sort((a, b) => b[1] - a[1]),
    } : null,
    hasSubscriptions: Boolean(ledger?.limits?.subscription),
    detectedPlans: {
      codex: ledger?.limits?.codex?.plan ?? null,
    },
    configuredPlans: {
      opencode: ledger?.limits?.goPlan ?? null,
      claude: ledger?.limits?.claude?.plan ?? null,
    },
    room,
    agents: AGENTS,
  };
}

export function collectUsage(options = {}) {
  const claude = collectClaudeUsage(options);
  const opencode = collectOpenCodeUsage(options);
  const codex = collectCodexUsage(options);
  const hub = collectAgentHubCoverage(options.agentHubLogPath);
  return {
    rows: [...claude.rows, ...opencode.rows, ...codex.rows]
      .sort((a, b) => a.date.localeCompare(b.date)
        || ((a.hour ?? -1) - (b.hour ?? -1))
        || a.source.localeCompare(b.source)
        || a.agent.localeCompare(b.agent)
        || a.model.localeCompare(b.model)
        || a.project.localeCompare(b.project)),
    sources: {
      claudeCode: claude.status,
      openCode: opencode.status,
      codex: codex.status,
      agentHub: hub.status,
    },
    openCodeAttribution: opencode.attribution ?? null,
  };
}

function rowKey(row) {
  return [row.date, row.hour ?? '?', row.source, row.agent, row.model, row.project].join('\u001f');
}

function dayKey(row) {
  return [row.date, row.source, row.agent, row.model, row.project].join('\u001f');
}

function validPreviousLedger(value) {
  return value
    && (value.schemaVersion === 1 || value.schemaVersion === COST_LEDGER_VERSION)
    && Array.isArray(value.rows)
    && value.sources
    && typeof value.sources === 'object';
}

export function readCostLedger(path = COST_LEDGER_PATH) {
  if (!existsSync(path)) {
    return { schemaVersion: COST_LEDGER_VERSION, generatedAt: null, sources: {}, rows: [] };
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`El ledger ${path} no es JSON válido: ${error.message}`);
  }
  if (!validPreviousLedger(parsed)) {
    throw new Error(`El ledger ${path} no tiene un esquema compatible.`);
  }
  return parsed.schemaVersion === 1
    ? {
      ...parsed,
      schemaVersion: COST_LEDGER_VERSION,
      rows: parsed.rows.map((row) => ({ ...row, hour: null, legacyDaily: true })),
    }
    : parsed;
}

/** Merge by date+hour+source+agent+model+project; never delete older buckets after source retention/purge. */
export function mergeCostLedger(previous, incoming, generatedAt = new Date().toISOString()) {
  if (!validPreviousLedger(previous)) throw new Error('Ledger previo incompatible.');
  const rows = new Map();
  for (const original of previous.rows) {
    // Earlier snapshots stored OpenCode's session role (build/plan/general) as
    // the agent. Canonicalize it and sum those disjoint role buckets once.
    const row = {
      ...original,
      hour: Number.isInteger(original.hour) ? original.hour : null,
      ...(original.source === 'opencode' ? { agent: 'opencode' } : {}),
    };
    const key = rowKey(row);
    const existing = rows.get(key);
    if (!existing) {
      rows.set(key, row);
      continue;
    }
    for (const field of TOKEN_FIELDS) existing[field] = numeric(existing[field]) + numeric(row[field]);
    existing.observations = numeric(existing.observations) + numeric(row.observations);
    existing.sessions = numeric(existing.sessions) + numeric(row.sessions);
  }

  // v1 stored only daily aggregates. When a current scan can reconstruct
  // hourly entries for that day/source/project, retain only any old remainder
  // that cannot be explained by the new hourly data, labelled hour=null.
  const freshByDay = new Map();
  for (const row of incoming.rows) {
    const key = dayKey(row);
    let total = freshByDay.get(key);
    if (!total) {
      total = { ...EMPTY_TOKENS(), observations: 0, sessions: 0 };
      freshByDay.set(key, total);
    }
    for (const field of TOKEN_FIELDS) total[field] += numeric(row[field]);
    total.observations += numeric(row.observations);
    total.sessions += numeric(row.sessions);
  }
  for (const [key, row] of [...rows.entries()]) {
    if (row.hour !== null || !row.legacyDaily) continue;
    const fresh = freshByDay.get(dayKey(row));
    if (!fresh) continue;
    const remainder = { ...row };
    for (const field of TOKEN_FIELDS) remainder[field] = Math.max(0, numeric(row[field]) - numeric(fresh[field]));
    remainder.observations = Math.max(0, numeric(row.observations) - numeric(fresh.observations));
    remainder.sessions = Math.max(0, numeric(row.sessions) - numeric(fresh.sessions));
    const hasRemainder = TOKEN_FIELDS.some((field) => remainder[field] > 0)
      || remainder.observations > 0 || remainder.sessions > 0;
    if (hasRemainder) rows.set(key, { ...remainder, legacyDaily: false });
    else rows.delete(key);
  }
  for (const fresh of incoming.rows) {
    const key = rowKey(fresh);
    const old = rows.get(key);
    if (!old) {
      rows.set(key, { ...fresh });
      continue;
    }
    const merged = { ...old };
    for (const field of TOKEN_FIELDS) merged[field] = Math.max(numeric(old[field]), numeric(fresh[field]));
    merged.observations = Math.max(numeric(old.observations), numeric(fresh.observations));
    merged.sessions = Math.max(numeric(old.sessions), numeric(fresh.sessions));
    rows.set(key, merged);
  }
  return {
    schemaVersion: COST_LEDGER_VERSION,
    generatedAt,
    sources: { ...previous.sources, ...incoming.sources },
    openCodeAttribution: incoming.openCodeAttribution ?? previous.openCodeAttribution ?? null,
    rows: [...rows.values()].sort((a, b) => a.date.localeCompare(b.date)
      || ((a.hour ?? -1) - (b.hour ?? -1))
      || a.source.localeCompare(b.source)
      || a.agent.localeCompare(b.agent)
      || a.model.localeCompare(b.model)
      || a.project.localeCompare(b.project)),
  };
}

function sumRows(rows) {
  const totals = { ...EMPTY_TOKENS(), observations: 0, sessions: 0 };
  for (const row of rows) {
    for (const field of TOKEN_FIELDS) totals[field] += numeric(row[field]);
    totals.observations += numeric(row.observations);
    totals.sessions += numeric(row.sessions);
  }
  return totals;
}

function groupRows(rows, keyFn) {
  const groups = new Map();
  for (const row of rows) {
    const key = keyFn(row);
    let total = groups.get(key);
    if (!total) {
      total = { ...EMPTY_TOKENS(), observations: 0, sessions: 0 };
      groups.set(key, total);
    }
    for (const field of TOKEN_FIELDS) total[field] += numeric(row[field]);
    total.observations += numeric(row.observations);
    total.sessions += numeric(row.sessions);
  }
  return [...groups.entries()].sort((a, b) => b[1].cache_read_tokens - a[1].cache_read_tokens || a[0].localeCompare(b[0]));
}

export function summarizeUsage(ledger) {
  const totals = sumRows(ledger.rows);
  const byAgent = new Map(['claude', 'opencode', 'codex'].map((agent) => [agent, { ...EMPTY_TOKENS() }]));
  const dates = [];
  let hourlyBuckets = 0;
  let unknownHourBuckets = 0;
  for (const row of ledger.rows) {
    dates.push(row.date);
    const agent = byAgent.get(row.agent);
    if (agent) for (const field of TOKEN_FIELDS) agent[field] += numeric(row[field]);
    if (Number.isInteger(row.hour)) hourlyBuckets += 1;
    else unknownHourBuckets += 1;
  }
  return {
    generatedAt: ledger.generatedAt,
    latestDate: dates.filter(Boolean).sort().at(-1) ?? null,
    totals,
    agents: [...byAgent.entries()].map(([agent, tokens]) => ({ agent, tokens, work_tokens: workTokens(tokens) })),
    hourlyBuckets,
    unknownHourBuckets,
  };
}

const number = (value) => new Intl.NumberFormat('es-ES').format(numeric(value));
const tokenCells = (totals) => [
  number(totals.input_tokens),
  number(totals.cache_write_tokens),
  number(totals.cache_read_tokens),
  number(totals.output_tokens),
  number(totals.reasoning_tokens),
  number(totals.unknown_tokens),
].join(' | ');

export function renderCostsMarkdown(ledger) {
  const totals = sumRows(ledger.rows);
  const rows = (groups, label) => {
    if (!groups.length) return `\nSin datos recuperables por ${label}.\n`;
    return [
      '',
      `| ${label} | Entrada | Escritura caché | Lectura caché | Salida | Razonamiento | Sin desglose |`,
      '|---|---:|---:|---:|---:|---:|---:|',
      ...groups.map(([key, value]) => `| ${key} | ${tokenCells(value)} |`),
      '',
    ].join('\n');
  };
  const sourceRows = Object.entries(ledger.sources).map(([key, value]) =>
    `| ${key} | ${value.available ? 'sí' : 'no'} | ${number(value.records)} | ${value.firstDate ?? '—'} → ${value.lastDate ?? '—'} | ${value.note || ''} |`);
  const agentGroups = groupRows(ledger.rows, (row) => `${row.agent} · ${row.model}`);
  const projectGroups = groupRows(ledger.rows, (row) => row.project).slice(0, 8);
  const dailyGroups = groupRows(ledger.rows, (row) => `${row.date} · ${row.agent}`)
    .sort((a, b) => a[0].localeCompare(b[0]));
  const unknownHourTotals = sumRows(ledger.rows.filter((row) => !Number.isInteger(row.hour)));
  const percent = (p) => (Number.isFinite(p) ? `${(p * 100).toFixed(p < 0.1 ? 1 : 0)}%` : '—');
  const limits = ledger.limits;
  const limitsSection = !limits ? '' : `
## Límites

Lectura de ${limits.measuredAt}${limits.error ? ` (Codex/Go: ${limits.error})` : ''}. Medido = lo dice la cuenta; estimado = precios publicados o referencia del plan; récord = tu ventana más intensa en el ledger.

| Ventana | Usado | Fuente | Nota |
|---|---:|---|---|
${[
    ...(limits.codex?.windows ?? []).map((w) => `| Codex · ${w.label} | ${w.usedPercent}% | medido | reinicia ${w.resetsAt ?? '—'} |`),
    ...roomRows(limits, new Date(limits.measuredAt)).filter((r) => r.agent === 'opencode' || (r.agent === 'claude' && r.source === 'measured'))
      .map((r) => `| ${r.agent === 'opencode' ? 'OpenCode Go' : 'Claude'} · ${{ week: 'semanal', month: 'mensual', '7d': 'semanal' }[r.label] ?? r.label} | ${r.source === 'free' ? 'gratis' : percent(r.pct)} | ${{ measured: 'medido', manual: 'copiado de consola', unavailable: 'sin lectura' }[r.source] ?? 'estimado'} | ${r.resetsAt ? `reinicia ${r.resetsAt}` : r.limit ? `$${(r.used ?? 0).toFixed(2)} de $${r.limit}` : ''} |`),
    ...[['5 h', limits.claude.window5h, limits.claude.record5h, limits.claude.reference?.window5h],
      ['7 días', limits.claude.week, limits.claude.recordWeek, limits.claude.reference?.week]].map(([label, used, record, ref]) =>
      `| Claude · ${label} | ${ref ? percent(used.quota / ref) : '—'} | ${ref ? 'estimado' : 'récord'} | ${number(used.tokens)} de trabajo + caché a peso ${limits.claude.quota?.weight ?? DEFAULT_CACHE_WEIGHT} = ${number(used.quota)} de cuota; ${record.tokens ? `${percent(used.tokens / record.tokens)} del récord` : 'sin récord'} |`),
  ].join('\n')}

Referencia de Claude: ${limits.claude.reference ? `${number(limits.claude.reference.window5h)} tokens/5 h (${limits.claude.reference.source})` : 'sin referencia del plan todavía (se rellena al primer límite alcanzado o en `projects/local/limits.json`)'}.
Peso de la caché en la cuota: ${limits.claude.quota?.weight ?? DEFAULT_CACHE_WEIGHT} (${limits.claude.quota?.source === 'fitted' ? `ajustado con ${limits.claude.quota.samples} límite(s) alcanzado(s)` : limits.claude.quota?.source === 'manual' ? 'puesto a mano en `local/limits.json`' : `valor de partida; se ajustará al primer límite alcanzado (${limits.claude.quota?.error ?? 'sin datos'})`}).
`;

  return `# Uso histórico de tokens de agentes

Generado: ${ledger.generatedAt ?? 'sin escaneo'}.

Cuenta tokens reportados localmente; **no calcula dólares** ni convierte suscripciones de cuota fija en facturas. Las categorías se mantienen separadas porque caché y razonamiento pueden solaparse; no se publica un total único “facturable”.

**Gráficas diarias y horarias:** [abrir el panel local](../dist/ai-usage.html), regenerado por \`node projects/tool/cli.mjs build\`.
${limitsSection}
## Cobertura de fuentes

| Fuente | Disponible | Registros | Rango local | Nota |
|---|---:|---:|---|---|
${sourceRows.join('\n')}

## Por agente y modelo
${rows(agentGroups, 'Agente · modelo')}

## Proyectos con más lectura de caché
${rows(projectGroups, 'Proyecto')}

## Diario por agente
${rows(dailyGroups, 'Fecha · agente')}

## Totales recuperables y hora

| Entrada | Escritura caché | Lectura caché | Salida | Razonamiento | Sin desglose |
|---:|---:|---:|---:|---:|---:|
| ${tokenCells(totals)} |

Buckets horarios: ${number(ledger.rows.filter((row) => Number.isInteger(row.hour)).length)}; registros sin hora conocida: ${number(unknownHourTotals.observations)}. Los agregados OpenCode/Codex se asignan a la hora de inicio de sesión/hilo.

## Límites del histórico

- Claude Code: solo los transcripts que aún existen en \`~/.claude/projects\`; el más antiguo recuperable se indica arriba. Los archivos ya purgados no se pueden reconstruir.
- OpenCode: totales por sesión del SQLite local; se asignan a la hora de inicio y se ignora la columna monetaria.
- Codex: si existe, el estado local solo expone un total por hilo; no se atribuye a entrada/salida sin desglose.
- Agent Hub: \`logs/runs.jsonl\` registra ejecuciones y a veces coste, pero actualmente no tokens; se cuenta la cobertura, no se mezcla con los proveedores.
- Los proyectos fuera del workspace se etiquetan como \`temporary\` o \`external/<carpeta>\`; no se persisten rutas absolutas, prompts ni respuestas.
- \`costs --write\` reconcilia cada día/hora/fuente/agente/modelo/proyecto tomando el máximo observado por categoría, no sumando cada escaneo. Conserva buckets anteriores aunque el proveedor rote o purgue transcripts; los registros heredados sin hora permanecen aparte.
`;
}

export function writeCostLedger(ledger, {
  ledgerPath = COST_LEDGER_PATH,
  reportPath = COST_REPORT_PATH,
} = {}) {
  writeFileSync(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`, 'utf8');
  writeFileSync(reportPath, renderCostsMarkdown(ledger), 'utf8');
}
