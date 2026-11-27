// costs.mjs — recover token usage from local agent histories without reading prompt text.
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { PROJECTS_DIR, resolveRoot } from './paths.mjs';
import { collectFiles, numeric, readJsonLines, workTokens } from './usage-records.mjs';
import { estimateGoLocal } from './subscription-usage.mjs';
import { DEFAULT_CACHE_WEIGHT, roomRows } from './usage-limits.mjs';

// Preserve the existing CLI/test API while keeping account limits separate.
export { workTokens } from './usage-records.mjs';
export { cacheWeight, claudeReference, claudeWindows, collectLimits,
  DEFAULT_CACHE_WEIGHT, findLimitHits, fitCacheWeight, LIMITS_CONFIG_PATH, limitsForRun, quotaTokens,
} from './usage-limits.mjs';

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

/**
 * Some sessions (e.g. hub probes) store no model on session_v2, but every reply
 * names the model that answered. Only the model fields are read, through
 * json_extract, so message text never leaves SQLite. A session gets a model
 * only when all its replies agree; mixed sessions stay unknown here and are
 * split per reply by openCodeAttribution.
 */
function openCodeReplyModels(db) {
  const bySession = new Map();
  try {
    const rows = db.prepare(`SELECT session_id,
        json_extract(data, '$.model.id') AS id,
        json_extract(data, '$.model.providerID') AS provider
      FROM session_message WHERE type = 'assistant'
      GROUP BY 1, 2, 3`).all();
    for (const row of rows) {
      if (!row.id) continue;
      const models = bySession.get(String(row.session_id)) ?? new Set();
      models.add(row.provider ? `${row.id} (${row.provider})` : String(row.id));
      bySession.set(String(row.session_id), models);
    }
  } catch {
    // Older databases have no session_message table or no JSON data column.
  }
  return bySession;
}

function sessionModel(session, replyModels) {
  const model = decodeModel(session.model);
  if (model !== 'unknown-model') return model;
  const replies = replyModels.get(String(session.id));
  return replies?.size === 1 ? [...replies][0] : model;
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
    const replyModels = openCodeReplyModels(db);
    for (const session of rowsInDb) {
      const { date, hour } = epochParts(session.time_created);
      if (!date) continue;
      dates.push(date);
      const dimensions = {
        date,
        hour,
        source: 'opencode',
        agent: 'opencode',
        model: sessionModel(session, replyModels),
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
function estimateShares(replyModels, sessionModel) {
  const known = [...(replyModels ?? new Map())].filter(([model, work]) => model !== 'unknown-model' && work > 0);
  if (known.length) return known.map(([model, weight]) => ({ model, weight }));
  return sessionModel && sessionModel !== 'unknown-model' ? [{ model: sessionModel, weight: 1 }] : null;
}

/** Integer split proportional to weights that still sums to `total` (largest remainder). */
function splitInteger(total, weights) {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (!total || !sum) return weights.map(() => 0);
  const exact = weights.map((w) => (total * w) / sum);
  const out = exact.map(Math.floor);
  let left = total - out.reduce((a, b) => a + b, 0);
  const order = exact.map((v, i) => [v - Math.floor(v), i]).sort((a, b) => b[0] - a[0]);
  for (let k = 0; left > 0; k += 1, left -= 1) out[order[k % order.length][1]] += 1;
  return out;
}

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
    (s.replyModels ??= new Map()).set(model, (s.replyModels.get(model) ?? 0) + workTokens(msg));
    for (const f of TOKEN_FIELDS) s.measured[f] += numeric(msg[f]);
    const at = epochParts(msg.time_created);
    addObservation(groups, { ...s.dimensions, ...(at.date ? at : {}), model }, msg, String(msg.session_id));
  }
  const estimated = new Map();
  for (const [id, s] of sessions) {
    const remainder = Object.fromEntries(TOKEN_FIELDS.map((f) => [f, Math.max(0, s.tokens[f] - s.measured[f])]));
    if (!TOKEN_FIELDS.some((f) => remainder[f] > 0)) continue;
    // The session total also counts calls stored as no reply (titles,
    // compaction, aborted turns). That rest is an estimate, flagged inferred:
    // all of it to the one model the replies used, or to the session's model
    // when there are no replies, or split by each model's share of the
    // replies' work when the session switched models.
    const shares = estimateShares(s.replyModels, s.dimensions.model);
    if (!shares) {
      addObservation(groups, { ...s.dimensions, model: 'unknown-model' }, remainder, id);
      continue;
    }
    const parts = shares.map(() => ({ ...EMPTY_TOKENS() }));
    for (const f of TOKEN_FIELDS) splitInteger(remainder[f], shares.map((x) => x.weight)).forEach((v, i) => { parts[i][f] = v; });
    shares.forEach(({ model }, i) => {
      if (TOKEN_FIELDS.some((f) => parts[i][f] > 0)) addObservation(estimated, { ...s.dimensions, model }, parts[i], id);
    });
  }
  const first = dates.reduce((a, b) => a < b ? a : b);
  const inferred = finishGroups(estimated).map((row) => ({ ...row, inferred: true }));
  return { first, rows: [...finishGroups(groups), ...inferred] };
}

/** Reconcile response-based history with the older aggregate, without adding both. */
export function subscriptionHistory(ledger) {
  const { rows = [], openCodeAttribution } = ledger ?? {};
  if (!openCodeAttribution) return rows;
  const legacy = rows.filter((r) => r.source !== 'opencode' || r.date < openCodeAttribution.first);
  if (!openCodeAttribution.covered) return [...legacy, ...openCodeAttribution.rows.map((row) => ({ ...row, stepHours: true }))];
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
  const recent = rows.filter((r) => r.source === 'opencode' && r.date >= openCodeAttribution.first);
  // Buckets with no current session (deleted from OpenCode) have nothing to
  // reconcile against. When all their labels share one provider, that
  // provider billed them: keep the rows with their own model labels. Mixed
  // providers still go through the coarse path below and stay unattributed.
  const coarseKey = (r) => rowKey({ ...r, model: 'unknown-model' });
  const providers = new Map();
  for (const r of recent) {
    const provider = /\(([^()]+)\)$/.exec(r.model ?? '')?.[1] ?? '?';
    (providers.get(coarseKey(r)) ?? providers.set(coarseKey(r), new Set()).get(coarseKey(r))).add(provider);
  }
  const keepsLabels = (r) => !covered.has(coarseKey(r)) && providers.get(coarseKey(r)).size === 1
    && !providers.get(coarseKey(r)).has('?');
  const retained = recent.filter(keepsLabels);
  const previous = groupCoarse(recent.filter((r) => !keepsLabels(r)));
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
  // Reply-based rows carry each reply's own time; session totals only their start.
  const replies = openCodeAttribution.rows.map((row) => ({ ...row, stepHours: true }));
  return [...legacy, ...retained, ...replies, ...finishGroups(previous)];
}

function findCodexDatabases(codexDir) {
  if (!existsSync(codexDir)) return [];
  return readdirSync(codexDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /^state_.*\.sqlite$/i.test(entry.name))
    .map((entry) => join(codexDir, entry.name))
    .sort();
}

const CODEX_FIELDS = ['input_tokens', 'cached_input_tokens', 'cache_write_input_tokens', 'output_tokens', 'reasoning_output_tokens'];

/**
 * Reads only the metadata lines of one Codex rollout: the thread id, cwd and
 * provider, the model in use, and the cumulative token counter. Each change of
 * the counter is one model call, attributed to its own timestamp. Message
 * lines are never parsed, so no prompt or answer is held in memory as data.
 */
function parseCodexRollout(text) {
  let threadId = null;
  let cwd = '';
  let provider = 'unknown-provider';
  let model = null;
  let previous = null;
  const calls = [];
  for (const line of text.split('\n')) {
    if (!line.includes('"session_meta"') && !line.includes('"turn_context"') && !line.includes('"token_count"')) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    const payload = event.payload ?? {};
    if (event.type === 'session_meta') {
      threadId = payload.id ?? threadId;
      cwd = payload.cwd ?? cwd;
      provider = payload.model_provider || provider;
    } else if (event.type === 'turn_context') {
      model = payload.model ?? model;
    } else if (payload.type === 'token_count' && payload.info?.total_token_usage) {
      const total = payload.info.total_token_usage;
      const dropped = previous && CODEX_FIELDS.some((field) => numeric(total[field]) < numeric(previous[field]));
      // The counter is cumulative; if it ever goes back, trust this call's own usage.
      const base = dropped ? null : previous;
      const source = dropped ? payload.info.last_token_usage ?? {} : total;
      const delta = Object.fromEntries(CODEX_FIELDS.map((field) => [
        field, Math.max(0, numeric(source[field]) - numeric(base?.[field])),
      ]));
      previous = total;
      if (CODEX_FIELDS.every((field) => delta[field] === 0)) continue;
      calls.push({ at: Date.parse(event.timestamp ?? ''), model, delta });
    }
  }
  return { threadId, cwd, provider, calls };
}

/**
 * Codex: rollouts give the per-call breakdown and hour; the state database's
 * per-thread total is only the fallback for threads whose rollout is gone.
 */
export function collectCodexUsage({
  codexDir = join(homedir(), '.codex'),
  workspaceRoot = resolveRoot(),
} = {}) {
  const databases = findCodexDatabases(codexDir);
  const groups = new Map();
  const dates = [];
  let records = 0;
  let files = 0;
  const rollouts = [
    join(codexDir, 'sessions'),
    join(codexDir, 'archived_sessions'),
  ].flatMap((dir) => collectFiles(dir));
  const covered = new Set();
  let calls = 0;
  for (const path of rollouts) {
    let parsed;
    try {
      parsed = parseCodexRollout(readFileSync(path, 'utf8'));
    } catch {
      continue;
    }
    if (parsed.calls.length === 0) continue;
    if (parsed.threadId) covered.add(String(parsed.threadId));
    for (const call of parsed.calls) {
      const { date, hour } = epochParts(call.at);
      if (!date) continue;
      calls += 1;
      dates.push(date);
      addObservation(groups, {
        date,
        hour,
        source: 'codex',
        agent: 'codex',
        model: call.model ? `${call.model} (${parsed.provider})` : 'unknown-model',
        project: projectLabel(parsed.cwd, workspaceRoot),
      }, {
        ...EMPTY_TOKENS(),
        // input_tokens includes the cached reads; keep those in their own column.
        input_tokens: Math.max(0, call.delta.input_tokens - call.delta.cached_input_tokens),
        cache_read_tokens: call.delta.cached_input_tokens,
        cache_write_tokens: call.delta.cache_write_input_tokens,
        output_tokens: call.delta.output_tokens,
        reasoning_tokens: call.delta.reasoning_output_tokens,
      }, parsed.threadId ? String(parsed.threadId) : path);
    }
  }
  records += calls;
  const Database = sqliteDatabaseClass();
  for (const dbPath of Database ? databases : []) {
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
        if (covered.has(String(thread.id))) continue;
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
  const fallback = records - calls;
  return {
    rows: finishGroups(groups),
    status: sourceStatus({
      available: databases.length > 0 || rollouts.length > 0,
      records,
      files: files + rollouts.length,
      ...dateRange(dates),
      note: calls
        ? `${covered.size} hilos con desglose por llamada (${calls} llamadas, hora UTC de cada una) desde los rollouts`
          + (fallback ? `; ${fallback} hilos sin rollout, solo con su total en la hora de inicio.` : '.')
        : records
          ? 'Total de tokens por thread, asignado a su hora UTC de inicio; input/output no recuperables por separado.'
          : !Database && databases.length
            ? 'Este Node no ofrece node:sqlite y no hay rollouts con contadores.'
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

const STALE_MS = 6 * 3_600_000;
const AGENTS = ['claude', 'codex', 'opencode'];

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

  // Codex used to be stored as one total per thread at its start hour. Once a
  // scan brings the per-call breakdown, those totals describe the same tokens:
  // drop the total-only Codex buckets from the first day the breakdown covers.
  const known = TOKEN_FIELDS.filter((field) => field !== 'unknown_tokens');
  const breakdownDates = incoming.rows
    .filter((row) => row.source === 'codex' && known.some((field) => numeric(row[field]) > 0))
    .map((row) => row.date)
    .sort();
  if (breakdownDates.length) {
    for (const [key, row] of [...rows.entries()]) {
      if (row.source !== 'codex' || row.date < breakdownDates[0]) continue;
      if (known.every((field) => numeric(row[field]) === 0)) rows.delete(key);
    }
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
  // OpenCode stores one total per session under the session's current model,
  // and that label changes when the model is switched mid-session. A bucket
  // the fresh scan still sees is therefore replaced, not merged per model:
  // otherwise every past label would keep its own copy of the same session.
  const bucketOf = (row) => [row.date, row.hour ?? '?', row.source, row.agent, row.project].join('\u001f');
  const freshOpenCode = new Set(incoming.rows.filter((row) => row.source === 'opencode').map(bucketOf));
  for (const [key, row] of [...rows.entries()]) {
    if (row.source === 'opencode' && freshOpenCode.has(bucketOf(row))) rows.delete(key);
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

Referencia de Claude: ${limits.claude.reference ? `${number(limits.claude.reference.window5h)} tokens/5 h (${limits.claude.reference.source})` : 'sin referencia del plan todavía (se rellena al primer límite alcanzado o en `workspace-panel/local/limits.json`)'}.
Peso de la caché en la cuota: ${limits.claude.quota?.weight ?? DEFAULT_CACHE_WEIGHT} (${limits.claude.quota?.source === 'fitted' ? `ajustado con ${limits.claude.quota.samples} límite(s) alcanzado(s)` : limits.claude.quota?.source === 'manual' ? 'puesto a mano en `local/limits.json`' : `valor de partida; se ajustará al primer límite alcanzado (${limits.claude.quota?.error ?? 'sin datos'})`}).
`;

  return `# Uso histórico de tokens de agentes

Generado: ${ledger.generatedAt ?? 'sin escaneo'}.

Cuenta tokens reportados localmente; **no calcula dólares** ni convierte suscripciones de cuota fija en facturas. Las categorías se mantienen separadas porque caché y razonamiento pueden solaparse; no se publica un total único “facturable”.

**Gráficas diarias y horarias:** [abrir el panel local](../dist/ai-usage.html), regenerado por \`node workspace-panel/tool/cli.mjs build\`.
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
- OpenCode: cada respuesta del SQLite local con su modelo y hora; lo que el total de la sesión no explica con respuestas (títulos, compactación) se estima para el modelo de la sesión o se reparte por modelos, marcado como provisional. La columna monetaria se ignora.
- Codex: cada llamada de los rollouts con su hora y desglose; el total por hilo del estado local solo cubre hilos sin rollout.
- Agent Hub: \`logs/runs.jsonl\` trae tokens por turno solo en algunas ejecuciones; es atribución, no se suma a los proveedores.
- Los proyectos fuera del workspace se etiquetan como \`temporary\` o \`external/<carpeta>\`; no se persisten rutas absolutas, prompts ni respuestas.
- \`costs --write\` reconcilia cada día/hora/fuente/agente/modelo/proyecto tomando el máximo observado por categoría, no sumando cada escaneo. Conserva buckets anteriores aunque el proveedor rote o purgue transcripts; los registros heredados sin hora permanecen aparte. Las franjas de OpenCode que el escaneo aún ve se sustituyen, porque una sesión cambia de etiqueta al cambiar de modelo.
`;
}

export function writeCostLedger(ledger, {
  ledgerPath = COST_LEDGER_PATH,
  reportPath = COST_REPORT_PATH,
} = {}) {
  writeFileSync(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`, 'utf8');
  writeFileSync(reportPath, renderCostsMarkdown(ledger), 'utf8');
}
