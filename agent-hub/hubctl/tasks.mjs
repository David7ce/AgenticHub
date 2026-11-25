// tasks.mjs — the thin work queue behind `hubctl tasks`.
//
// One SQLite file, no daemon, no dependency graph. A claim is one atomic
// transaction, so two workers never take the same task. The worker itself lives
// in hubctl.mjs and delegates every launch to hub-acp.mjs: consent, write scope,
// budget and the audit line stay in one place.
import { DatabaseSync } from 'node:sqlite';

export const STATES = ['queued', 'running', 'review', 'done', 'blocked', 'cancelled'];
const TERMINAL = new Set(['review', 'done', 'blocked', 'cancelled']);

function iso(date = new Date()) {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

// ACP reports cost as `{ amount, currency }`; older paths report a number.
export function costAmount(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (value && typeof value === 'object' && Number.isFinite(value.amount)) return value.amount;
  return null;
}

export function openTaskDb(path) {  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id          TEXT PRIMARY KEY,
      title       TEXT NOT NULL,
      repo        TEXT NOT NULL,
      worktree    TEXT,
      agent       TEXT NOT NULL,
      model       TEXT,
      prompt      TEXT NOT NULL,
      acceptance  TEXT,
      state       TEXT NOT NULL DEFAULT 'queued',
      budget      REAL,
      attempts    INTEGER NOT NULL DEFAULT 0,
      created_at  TEXT NOT NULL,
      started_at  TEXT,
      finished_at TEXT,
      evidence    TEXT,
      result      TEXT,
      exit_code   INTEGER,
      cost        REAL,
      error       TEXT,
      parent      TEXT
    );
    CREATE INDEX IF NOT EXISTS tasks_state ON tasks(state, created_at);
  `);
  return db;
}

export function newTaskId(date = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  const stamp =
    `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-` +
    `${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
  // 8 hex chars, not 4: the stamp only has second resolution, and 16 bits of
  // randomness collided for ~1.6 % of 50-id batches generated in the same
  // second (measured), which is both a flaky test and a possible UNIQUE clash.
  const rand = Math.random().toString(16).slice(2, 10).padEnd(8, '0');
  return `t-${stamp}-${rand}`;
}

function assertState(state) {
  if (!STATES.includes(state)) throw new Error(`unknown task state: ${state}`);
}

export function addTask(db, fields) {
  const now = iso();
  const prompt = String(fields.prompt ?? '');
  if (!prompt.trim()) throw new Error('a task needs a prompt');
  if (!fields.repo) throw new Error('a task needs a repo');
  if (!fields.agent) throw new Error('a task needs an agent');
  const title = (fields.title ?? prompt.split('\n')[0]).trim().slice(0, 80);
  const id = fields.id ?? newTaskId();
  db.prepare(
    `INSERT INTO tasks (id, title, repo, agent, model, prompt, acceptance, state, budget, parent, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?)`,
  ).run(
    id,
    title,
    fields.repo,
    fields.agent,
    fields.model ?? null,
    prompt,
    fields.acceptance ?? null,
    fields.budget ?? null,
    fields.parent ?? null,
    now,
  );
  return getTask(db, id);
}

export function getTask(db, id) {
  return db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) ?? null;
}

export function listTasks(db, { state = null, limit = 100 } = {}) {
  const rows = state
    ? db.prepare('SELECT * FROM tasks WHERE state = ? ORDER BY rowid LIMIT ?').all(state, limit)
    : db.prepare('SELECT * FROM tasks ORDER BY rowid LIMIT ?').all(limit);
  return rows;
}

/**
 * Claim the oldest queued task in one write transaction. Returns null when the
 * queue is empty. BEGIN IMMEDIATE takes the write lock up front, so another
 * `hubctl tasks run` in a second terminal sees the row as running, not queued.
 */
export function claimNext(db, now = iso()) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const next = db.prepare(
      "SELECT id FROM tasks WHERE state = 'queued' ORDER BY rowid LIMIT 1",
    ).get();
    if (!next) {
      db.exec('ROLLBACK');
      return null;
    }
    const changed = db.prepare(
      "UPDATE tasks SET state = 'running', started_at = ?, attempts = attempts + 1 WHERE id = ? AND state = 'queued'",
    ).run(now, next.id);
    if (changed.changes !== 1) {
      db.exec('ROLLBACK');
      return null;
    }
    const row = getTask(db, next.id);
    db.exec('COMMIT');
    return row;
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
    throw error;
  }
}

export function setTaskWorktree(db, id, worktree) {
  db.prepare('UPDATE tasks SET worktree = ? WHERE id = ?').run(worktree, id);
  return getTask(db, id);
}

/**
 * Attach evidence without changing state: `hubctl verify` proves a diff runs,
 * but moving `review` to `done` is still the human's call.
 */
export function attachEvidence(db, id, evidence) {
  const { changes } = db.prepare('UPDATE tasks SET evidence = ? WHERE id = ?').run(String(evidence), id);
  return changes > 0;
}

/**
 * Close a running task. `done` requires evidence: a path to the diff, the test
 * output, or the review that accepted it. The queue never marks work done on
 * the agent's own word.
 */
export function finishTask(db, id, patch = {}) {
  const state = patch.state ?? 'review';
  assertState(state);
  if (state === 'done' && !String(patch.evidence ?? '').trim()) {
    throw new Error('done needs --evidence (a diff, a test run, or the review that accepted it)');
  }
  const closed = TERMINAL.has(state) ? iso() : null;
  db.prepare(
    `UPDATE tasks
        SET state = ?, finished_at = ?, evidence = COALESCE(?, evidence),
            result = COALESCE(?, result), exit_code = COALESCE(?, exit_code),
            cost = COALESCE(?, cost), error = COALESCE(?, error)
      WHERE id = ?`,
  ).run(
    state,
    closed,
    patch.evidence ?? null,
    patch.result ?? null,
    patch.exitCode ?? null,
    costAmount(patch.cost),
    patch.error ?? null,
    id,
  );
  // A clean worktree is removed by the worker; the row must not keep a path to
  // a directory that no longer exists. Only an explicit key changes it.
  if (Object.prototype.hasOwnProperty.call(patch, 'worktree')) {
    db.prepare('UPDATE tasks SET worktree = ? WHERE id = ?').run(patch.worktree ?? null, id);
  }
  return getTask(db, id);
}

export function retryTask(db, id) {
  const task = getTask(db, id);
  if (!task) throw new Error(`no such task: ${id}`);
  if (!['blocked', 'cancelled', 'review'].includes(task.state)) {
    throw new Error(`only blocked, cancelled or review tasks can be retried (is ${task.state})`);
  }
  db.prepare(
    "UPDATE tasks SET state = 'queued', started_at = NULL, finished_at = NULL, error = NULL WHERE id = ?",
  ).run(id);
  return getTask(db, id);
}

export function taskCounts(db) {
  const rows = db.prepare('SELECT state, COUNT(*) AS n FROM tasks GROUP BY state').all();
  return Object.fromEntries(rows.map((row) => [row.state, row.n]));
}

/**
 * Read-only counts for `hubctl status`. Returns null when the queue file does
 * not exist yet, so status never creates it as a side effect.
 */
export function readTaskCounts(path) {
  try {
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      return taskCounts(db);
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

const QUEUE_ORDER = ['queued', 'running', 'review', 'blocked'];

/** One line for status: only the states that mean something is still open. */
export function renderQueueLine(counts) {
  if (!counts) return null;
  const parts = QUEUE_ORDER.filter((state) => counts[state]).map((state) => `${counts[state]} ${state}`);
  return parts.length ? parts.join(' · ') : null;
}

function age(isoText) {
  if (!isoText) return '-';
  const ms = Date.now() - Date.parse(isoText);
  if (!Number.isFinite(ms)) return '-';
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

export function renderTask(task) {
  const cost = task.cost == null ? '-' : `$${Number(task.cost).toFixed(3)}`;
  const repo = String(task.repo).replace(/[\\/]+$/, '').split(/[\\/]/).pop();
  return [
    task.id.padEnd(22),
    String(task.state).padEnd(9),
    String(task.agent).padEnd(9),
    String(repo).padEnd(14).slice(0, 14),
    String(task.title).slice(0, 48).padEnd(48),
    cost.padStart(7),
    age(task.created_at).padStart(4),
  ].join('  ');
}

export function renderTasks(tasks) {
  if (!tasks.length) return 'no tasks\n';
  const header = [
    'ID'.padEnd(22),
    'STATE'.padEnd(9),
    'AGENT'.padEnd(9),
    'REPO'.padEnd(14),
    'TITLE'.padEnd(48),
    'COST'.padStart(7),
    'AGE'.padStart(4),
  ].join('  ');
  return `${header}\n${tasks.map(renderTask).join('\n')}\n`;
}
