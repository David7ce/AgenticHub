// usage-capture.mjs — per-turn token usage for the audit line.
//
// ACP only reports `cost` and, when the adapter sends it, the context window
// (`used`/`size`) in `usage_update`. The token breakdown lives in each agent's
// own local store, so a turn is measured as the difference between two reads
// of that store, keyed by the session id the hub already holds:
//
//   opencode  SQLite `session_v2` row              cumulative columns, delta
//   codex     `~/.codex/sessions/**/rollout-*.jsonl`  per-turn or cumulative count
//   claude    `~/.claude/projects/**/<id>.jsonl`   per-message usage, exact
//
// Claude is the exception: its ACP adapter keeps its own session id, which does
// not match the Claude Code transcript. When the id misses, the transcript that
// declares this tree's `cwd` and was touched during the turn is used, and the
// reading is marked `time-window`. If nothing matches, the answer is
// `unavailable`, never zero: a silent zero would look like a free turn.
//
// Nothing here may fail a run. Every reader catches and returns a reason.

import { createRequire } from 'node:module';
import { closeSync, existsSync, openSync, readFileSync, readdirSync, readSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
let DatabaseSync = null;

function sqliteClass() {
  if (DatabaseSync) return DatabaseSync;
  try {
    DatabaseSync = require('node:sqlite').DatabaseSync;
    return DatabaseSync;
  } catch {
    return null;
  }
}

const num = (value) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
};

/** The token fields the audit line and `workspaces-panel/tool/lib/costs.mjs` share. */
export function emptyUsage(source, confidence = 'unavailable') {
  return {
    input_tokens: 0,
    cache_write_tokens: 0,
    cache_read_tokens: 0,
    output_tokens: 0,
    reasoning_tokens: 0,
    source,
    confidence,
  };
}

function unavailable(source, reason) {
  return { ...emptyUsage(source), reason: String(reason?.message ?? reason).slice(0, 200) };
}

// ── claude ──────────────────────────────────────────────────────────────────
//
// `~/.claude/projects/<slug>/<sessionId>.jsonl`; one line per message, each
// carrying `message.usage` and the `cwd` it belongs to. Streaming repeats a
// message, so the last snapshot per message id wins.
//
// The adapter's ACP session id is not the Claude Code one, so the exact hit is
// tried first and a match on the transcript's own `cwd` is the fallback. The
// project directory name is never derived here: the slug rule is Claude's to
// change, and this file must not grow a second path translator.

function claudeRoot(options) {
  const config = options.claudeConfigDir
    ?? process.env.HUB_USAGE_CLAUDE_DIR
    ?? process.env.CLAUDE_CONFIG_DIR
    ?? join(homedir(), '.claude');
  return join(config, 'projects');
}

function claudeFiles(options) {
  const root = claudeRoot(options);
  if (!existsSync(root)) return [];
  const out = [];
  let dirs;
  try {
    dirs = readdirSync(root);
  } catch {
    return out;
  }
  for (const dir of dirs) {
    const full = join(root, dir);
    let names;
    try {
      names = readdirSync(full);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue;
      const path = join(full, name);
      try {
        out.push({ path, mtime: statSync(path).mtimeMs });
      } catch {
        // A file removed between the two calls is not a candidate.
      }
    }
  }
  return out;
}

function exactClaudeFile(sessionId, options, files = null) {
  if (!sessionId) return null;
  const name = `${sessionId}.jsonl`;
  return (files ?? claudeFiles(options)).find((entry) => entry.path.endsWith(name))?.path ?? null;
}

/** The `cwd` a transcript declares, read from its head so a big file stays cheap. */
function claudeFileCwd(path) {
  let fd;
  try {
    fd = openSync(path, 'r');
    const buffer = Buffer.alloc(64 * 1024);
    const bytes = readSync(fd, buffer, 0, buffer.length, 0);
    for (const line of buffer.subarray(0, bytes).toString('utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const record = JSON.parse(line);
        if (typeof record.cwd === 'string') return record.cwd;
      } catch {
        break; // the buffer cut the first line: no cwd to read
      }
    }
  } catch {
    // Unreadable: not a candidate.
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  return null;
}

function sameCwd(a, b) {
  return typeof a === 'string' && typeof b === 'string'
    && a.replace(/[\\/]+$/, '').toLowerCase() === b.replace(/[\\/]+$/, '').toLowerCase();
}

/** Transcripts of this tree touched during the turn, newest first. */
function freshClaudeFiles(cwd, startedMs, files = null) {
  return (files ?? [])
    .filter((entry) => entry.mtime >= startedMs - 5_000)
    .sort((a, b) => b.mtime - a.mtime)
    .filter((entry) => sameCwd(claudeFileCwd(entry.path), cwd));
}

/** Read a file from `offset`, so a turn never re-reads a 20 MB transcript. */
function readFrom(path, offset = 0) {
  let fd;
  try {
    fd = openSync(path, 'r');
    const size = statSync(path).size;
    const start = Math.min(Math.max(0, offset), size);
    const length = size - start;
    if (!length) return '';
    const buffer = Buffer.alloc(length);
    const bytes = readSync(fd, buffer, 0, length, start);
    return buffer.subarray(0, bytes).toString('utf8');
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function readClaudeMessages(path, { offset = 0, atLineStart = true, sinceMs = null } = {}) {
  let body = readFrom(path, offset);
  if (body === null) return new Map();
  if (!atLineStart) body = body.slice(body.indexOf('\n') + 1); // a partial line at the snapshot
  const perMessage = new Map();
  for (const line of body.split(/\r?\n/)) {
    if (!line) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue; // a partial final line while the agent is still writing
    }
    const usage = record?.message?.usage;
    const model = record?.message?.model;
    if (!usage || typeof model !== 'string' || !model || model === '<synthetic>') continue;
    const at = Date.parse(record.timestamp ?? '');
    if (sinceMs !== null && (!Number.isFinite(at) || at < sinceMs)) continue;
    const id = record.message.id || record.requestId || record.uuid;
    if (!id) continue;
    perMessage.set(id, usage);
  }
  return perMessage;
}

function sumClaude(perMessage) {
  const totals = emptyUsage('claude-transcript', 'exact');
  for (const usage of perMessage.values()) {
    totals.input_tokens += num(usage.input_tokens ?? usage.inputTokens);
    totals.cache_write_tokens += num(usage.cache_creation_input_tokens ?? usage.cacheCreationInputTokens);
    totals.cache_read_tokens += num(usage.cache_read_input_tokens ?? usage.cacheReadInputTokens);
    totals.output_tokens += num(usage.output_tokens ?? usage.outputTokens);
    const thinking = usage.output_tokens_details?.thinking_tokens
      ?? usage.thinking_tokens
      ?? usage.thinkingTokens
      ?? usage.reasoning_tokens;
    totals.reasoning_tokens += num(thinking);
  }
  return totals;
}

function snapshotClaude({ sessionId, options }) {
  const path = exactClaudeFile(sessionId, options);
  if (!path) return { path: null, offset: 0, atLineStart: true };
  try {
    const size = statSync(path).size;
    if (!size) return { path, offset: 0, atLineStart: true };
    // Whole-file offset, plus whether it ends on a line boundary: a message
    // still being written is finished on the next turn, not split here.
    let fd;
    try {
      const last = Buffer.alloc(1);
      fd = openSync(path, 'r');
      readSync(fd, last, 0, 1, size - 1);
      return { path, offset: size, atLineStart: last.toString('utf8') === '\n' };
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  } catch {
    return { path, offset: 0, atLineStart: true };
  }
}

function captureClaude({ cwd, sessionId, base, startedMs, options }) {
  let path = base?.path ?? null;
  let offset = base?.path ? base.offset : 0;
  let atLineStart = base?.path ? base.atLineStart !== false : true;
  let confidence = 'exact';

  if (!path) {
    // New session: the file appears during the turn. Prefer an exact id hit,
    // then the transcript of this same tree touched in the turn.
    const files = claudeFiles(options);
    path = exactClaudeFile(sessionId, options, files);
    if (!path) {
      path = freshClaudeFiles(cwd, startedMs, files)[0]?.path ?? null;
      confidence = 'time-window';
    }
    offset = 0;
    atLineStart = true;
  }

  if (!path) return unavailable('claude-transcript', 'no transcript for this turn');

  const messages = readClaudeMessages(path, {
    offset,
    atLineStart,
    sinceMs: offset > 0 ? null : startedMs - 2_000,
  });
  const totals = sumClaude(messages);
  totals.confidence = messages.size ? confidence : 'unavailable';
  if (!messages.size) totals.reason = 'no messages in the transcript for this turn';
  return totals;
}

// ── opencode ────────────────────────────────────────────────────────────────
//
// `session_v2` keeps cumulative totals per session. The turn is after − before;
// a session the hub just created has no "before", so its whole total is the
// turn and is labelled `session-total`.

function opencodeDbPath(options) {
  if (options.opencodeDb) return options.opencodeDb;
  if (process.env.HUB_USAGE_OPENCODE_DB) return process.env.HUB_USAGE_OPENCODE_DB;
  const data = process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share');
  return join(data, 'opencode', 'opencode.db');
}

function opencodeRow(dbPath, sessionId) {
  const Database = sqliteClass();
  if (!Database || !existsSync(dbPath) || !sessionId) return null;
  let db;
  try {
    db = new Database(dbPath, { readOnly: true });
    const columns = new Set(db.prepare('PRAGMA table_info(session_v2)').all().map((column) => column.name));
    if (!columns.has('id')) return null;
    const wanted = [
      'tokens_input', 'tokens_output', 'tokens_reasoning',
      'tokens_cache_read', 'tokens_cache_write',
    ].filter((column) => columns.has(column));
    if (!wanted.length) return null;
    return db.prepare(`SELECT ${wanted.join(', ')} FROM session_v2 WHERE id = ?`).get(sessionId) ?? null;
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

const OPENCODE_FIELDS = [
  ['input_tokens', 'tokens_input'],
  ['output_tokens', 'tokens_output'],
  ['reasoning_tokens', 'tokens_reasoning'],
  ['cache_read_tokens', 'tokens_cache_read'],
  ['cache_write_tokens', 'tokens_cache_write'],
];

function snapshotOpencode({ sessionId, options }) {
  const dbPath = opencodeDbPath(options);
  const row = opencodeRow(dbPath, sessionId);
  return { dbPath, row };
}

function captureOpencode({ sessionId, base, options }) {
  const dbPath = base?.dbPath ?? opencodeDbPath(options);
  const after = opencodeRow(dbPath, sessionId);
  if (!after) return unavailable('opencode-session', 'no session row to read');
  const before = base?.row ?? null;
  const totals = emptyUsage('opencode-session', before ? 'delta' : 'session-total');
  for (const [field, column] of OPENCODE_FIELDS) {
    totals[field] = Math.max(0, num(after[column]) - num(before?.[column]));
  }
  return totals;
}

// ── codex ───────────────────────────────────────────────────────────────────
//
// A rollout file is named `rollout-<timestamp>-<threadId>.jsonl`, so the session
// id finds it without reading anything else. Its `token_count` events are
// cumulative; `input_tokens` includes the cached reads, which are split out.

function codexRoot(options) {
  return options.codexDir
    ?? process.env.HUB_USAGE_CODEX_DIR
    ?? process.env.CODEX_HOME
    ?? join(homedir(), '.codex');
}

function findRollout(root, sessionId) {
  if (!sessionId) return null;
  const dirs = [join(root, 'sessions'), join(root, 'archived_sessions')];
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    const stack = [dir];
    while (stack.length) {
      const current = stack.pop();
      let entries;
      try {
        entries = readdirSync(current, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        const path = join(current, entry.name);
        if (entry.isDirectory()) stack.push(path);
        else if (entry.isFile() && entry.name.endsWith(`${sessionId}.jsonl`)) return path;
      }
    }
  }
  return null;
}

function lastCodexTotal(path) {
  if (!path) return null;
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  let last = null;
  for (const line of text.split('\n')) {
    if (!line.includes('"token_count"')) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    const info = event?.payload?.info;
    // `last_token_usage` would be the turn itself when the agent writes it;
    // otherwise the cumulative total is the only reliable reading.
    if (info?.last_token_usage) last = { usage: info.last_token_usage, cumulative: false };
    else if (info?.total_token_usage) last = { usage: info.total_token_usage, cumulative: true };
  }
  return last;
}

function snapshotCodex({ sessionId, options }) {
  const path = findRollout(codexRoot(options), sessionId);
  return { path, last: path ? lastCodexTotal(path) : null };
}

function captureCodex({ sessionId, base, options }) {
  const path = base?.path ?? findRollout(codexRoot(options), sessionId);
  if (!path) return unavailable('codex-rollout', 'no rollout for this session');
  const after = lastCodexTotal(path);
  if (!after) return unavailable('codex-rollout', 'the rollout has no token_count');

  const before = base?.last ?? null;
  // Both readings cumulative: subtract. A standalone last_token_usage is the
  // turn already; it is only trusted when nothing cumulative is available.
  let usage = after.usage;
  if (after.cumulative && before?.cumulative) {
    usage = {};
    for (const [key, value] of Object.entries(after.usage)) {
      usage[key] = Math.max(0, num(value) - num(before.usage?.[key]));
    }
  }
  // Codex writes `last_token_usage` per turn when it has it: that is the turn
  // already. Only a cumulative total needs the two readings subtracted.
  const confidence = !after.cumulative
    ? 'turn'
    : before?.cumulative ? 'delta' : 'session-total';
  const totals = emptyUsage('codex-rollout', confidence);
  const cached = num(usage.cached_input_tokens);
  totals.input_tokens = Math.max(0, num(usage.input_tokens) - cached);
  totals.cache_read_tokens = cached;
  totals.cache_write_tokens = num(usage.cache_write_input_tokens);
  totals.output_tokens = num(usage.output_tokens);
  totals.reasoning_tokens = num(usage.reasoning_output_tokens);
  return totals;
}

// ── context window (ACP) ────────────────────────────────────────────────────

/** `usage_update` carries the context window when the adapter reports it. */
export function contextFromUsage(usage) {
  if (!usage || typeof usage !== 'object') return { context_peak: null, context_size: null };
  const used = num(usage.used ?? usage.contextUsed ?? usage.context_used);
  const size = num(usage.size ?? usage.contextSize ?? usage.context_size);
  return {
    context_peak: used || null,
    context_size: size || null,
  };
}

// ── public API ──────────────────────────────────────────────────────────────

/**
 * Read the agent's store before the prompt. Best-effort: a missing store just
 * means the after-read is labelled `session-total` or `time-window` instead of
 * `delta` or `exact`.
 */
export function snapshotUsage(agent, { sessionId, cwd, options = {} } = {}) {
  try {
    if (!sessionId) return null;
    if (agent === 'claude') return snapshotClaude({ sessionId, options });
    if (agent === 'opencode') return snapshotOpencode({ sessionId, options });
    if (agent === 'codex') return snapshotCodex({ sessionId, options });
    return null;
  } catch {
    return null;
  }
}

/**
 * The turn's usage, never throwing. `state` supplies the live context window
 * tracked from `usage_update`; `base` is snapshotUsage()'s result.
 */
export function captureUsage({ agent, sessionId, cwd, base = null, startedMs, state = null, options = {} }) {
  let usage;
  try {
    if (!sessionId) usage = unavailable(`${agent}-usage`, 'the turn has no session id');
    else if (agent === 'claude') usage = captureClaude({ cwd, sessionId, base, startedMs, options });
    else if (agent === 'opencode') usage = captureOpencode({ sessionId, base, options });
    else if (agent === 'codex') usage = captureCodex({ sessionId, base, options });
    else usage = unavailable(`${agent}-usage`, 'no local token store for this agent');
  } catch (error) {
    usage = unavailable(`${agent}-usage`, error);
  }
  const context = contextFromUsage(state?.usage);
  return {
    ...usage,
    // `state` carries the turn's high-water mark (0 when no update arrived);
    // the last `usage_update` is the fallback. Absent means absent: null.
    context_peak: state?.contextPeak || context.context_peak || null,
    context_size: state?.contextSize || context.context_size || null,
  };
}
