// spend.mjs — tokens by project and day, read from the local sources.
//
// OpenCode is exact: every assistant message carries its own token counts and
// timestamp in opencode.db. Claude runs expose cost only. Codex rollouts are a
// later phase; this module labels what it can and never invents the rest.
//
// Read-only: the SQLite handle is opened with `readOnly: true`, and only the
// project/session/message tables are queried. Never account or credential.

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';

const DAY_MS = 86_400_000;
const require = createRequire(import.meta.url);

export function defaultDbPath() {
  return process.env.OPENCODE_DB
    ? resolve(process.env.OPENCODE_DB)
    : join(homedir(), '.local', 'share', 'opencode', 'opencode.db');
}

export function dayKey(ms, utc) {
  const date = new Date(ms);
  if (utc) return date.toISOString().slice(0, 10);
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
}

function dayStart(iso, utc) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(iso))) throw new Error(`invalid date: ${iso}`);
  const [y, m, d] = iso.split('-').map(Number);
  return utc ? Date.UTC(y, m - 1, d) : new Date(y, m - 1, d).getTime();
}

function addDays(iso, offset) {
  const [y, m, d] = iso.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d + offset));
  return date.toISOString().slice(0, 10);
}

export function rangeFor({ days = 7, date = null, from = null, to = null, utc = false } = {}) {
  if (date) {
    const start = dayStart(date, utc);
    return { from: start, to: start + DAY_MS, fromDay: date, toDay: date };
  }
  const today = dayKey(Date.now(), utc);
  const end = to ?? today;
  const startDay = from ?? addDays(end, -(Math.max(1, days) - 1));
  return {
    from: dayStart(startDay, utc),
    to: dayStart(addDays(end, 1), utc),
    fromDay: startDay,
    toDay: end,
  };
}

export function projectLabel(worktree, directory) {
  const raw = String(worktree ?? directory ?? '').replace(/\\/g, '/');
  if (!raw) return { label: 'unknown', path: null };
  // A fanout worktree (<repo>/.git/agent-worktrees/<run>) belongs to its repo.
  const clean = raw.replace(/\/+$/, '').replace(/\/\.git\/agent-worktrees\/.*$/, '');
  const parts = clean.split('/').filter(Boolean);
  const label = /hub-bench|agenthub-collab|\/tmp\/|AppData\/Local\/Temp/i.test(clean)
    ? 'bench'
    : parts[parts.length - 1] || clean;
  return { label, path: clean };
}

function parseTokens(data) {
  let parsed;
  try { parsed = JSON.parse(data); } catch { return null; }
  const tokens = parsed?.tokens;
  if (!tokens || typeof tokens !== 'object') return null;
  const num = (v) => (Number.isFinite(v) ? v : 0);
  return {
    input: num(tokens.input),
    output: num(tokens.output),
    reasoning: num(tokens.reasoning),
    cacheRead: num(tokens.cache?.read),
    cacheWrite: num(tokens.cache?.write),
    cost: num(parsed?.cost),
    model: parsed?.model?.id ?? parsed?.model ?? null,
    provider: parsed?.model?.providerID ?? null,
  };
}

/**
 * Aggregate OpenCode assistant messages. Returns a warning instead of throwing
 * when the database or its schema is unavailable, so the rest of hubctl keeps
 * working.
 */
export function readOpenCodeSpend({
  dbPath = defaultDbPath(),
  days = 7,
  date = null,
  from = null,
  to = null,
  utc = false,
  by = ['day', 'project'],
  project = null,
  includeSubagents = true,
} = {}) {
  if (!existsSync(dbPath)) return { ok: false, reason: `no OpenCode database at ${dbPath}`, rows: [] };
  let DatabaseSync;
  try { ({ DatabaseSync } = require('node:sqlite')); } catch {
    return { ok: false, reason: 'node:sqlite is not available in this Node build', rows: [] };
  }
  const range = rangeFor({ days, date, from, to, utc });
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const sql = `
      SELECT m.session_id, m.time_created, m.data,
             s.directory, s.parent_id, p.worktree
      FROM session_message m
      JOIN session_v2 s ON s.id = m.session_id
      LEFT JOIN project p ON p.id = s.project_id
      WHERE m.type = 'assistant'
        AND json_extract(m.data, '$.tokens') IS NOT NULL
        AND m.time_created >= ?
        AND m.time_created < ?
        ${includeSubagents ? '' : 'AND s.parent_id IS NULL'}
    `;
    const statement = db.prepare(sql);
    const raw = statement.all(range.from, range.to);
    const groups = new Map();
    for (const row of raw) {
      const tokens = parseTokens(row.data);
      if (!tokens) continue;
      const where = projectLabel(row.worktree, row.directory);
      if (project && project !== where.label && project !== where.path) continue;
      const day = dayKey(row.time_created, utc);
      const key = JSON.stringify([day, where.label, 'opencode', tokens.model ?? '—']);
      if (!groups.has(key)) {
        groups.set(key, {
          date: day,
          project: where.label,
          projectPath: where.path,
          agent: 'opencode',
          model: tokens.model ?? '—',
          provider: tokens.provider,
          runs: 0,
          input: 0,
          output: 0,
          reasoning: 0,
          cacheRead: 0,
          cacheWrite: 0,
          costReportedUsd: 0,
          coverage: 'tokens+cost',
        });
      }
      const group = groups.get(key);
      group.runs += 1;
      group.input += tokens.input;
      group.output += tokens.output;
      group.reasoning += tokens.reasoning;
      group.cacheRead += tokens.cacheRead;
      group.cacheWrite += tokens.cacheWrite;
      group.costReportedUsd += tokens.cost;
    }
    return { ok: true, rows: [...groups.values()], range };
  } catch (error) {
    return { ok: false, reason: `OpenCode database not readable: ${error.message}`, rows: [] };
  } finally {
    try { db?.close(); } catch {}
  }
}

/**
 * Claude runs from the hub audit. Records written since 2026-11-25 carry the
 * turn's tokens in `usage` (read from the agent's own store); older ones have
 * only the reported cost, and a turn whose store could not be read stays
 * `cost-only` rather than being counted as zero.
 */
export function readClaudeSpend({
  logPath, days = 7, date = null, from = null, to = null, utc = false, project = null,
} = {}) {
  if (!logPath || !existsSync(logPath)) return { ok: true, rows: [], range: null };
  const range = rangeFor({ days, date, from, to, utc });
  const groups = new Map();
  for (const line of readFileSync(logPath, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry.agent !== 'claude') continue;
    const when = Date.parse(entry.time ?? entry.ts ?? '');
    if (!Number.isFinite(when) || when < range.from || when >= range.to) continue;
    const amount = Number(entry.cost?.amount);
    const day = dayKey(when, utc);
    const model = entry.model ?? '—';
    // Records written since 2026-11-08 carry cwd; older ones stay `unknown`.
    const where = entry.cwd ? projectLabel(entry.cwd) : { label: 'unknown', path: null };
    if (project && project !== where.label && project !== where.path) continue;
    const key = JSON.stringify([day, where.label, 'claude', model]);
    if (!groups.has(key)) {
      groups.set(key, {
        date: day, project: where.label, projectPath: where.path, agent: 'claude', model,
        provider: 'anthropic', runs: 0, input: 0, output: 0, reasoning: 0,
        cacheRead: 0, cacheWrite: 0, costReportedUsd: 0, coverage: 'cost-only',
      });
    }
    const group = groups.get(key);
    group.runs += 1;
    if (Number.isFinite(amount)) group.costReportedUsd += amount;
    const usage = entry.usage;
    if (usage && usage.confidence && usage.confidence !== 'unavailable') {
      group.input += int(usage.input_tokens);
      group.output += int(usage.output_tokens);
      group.reasoning += int(usage.reasoning_tokens);
      group.cacheRead += int(usage.cache_read_tokens);
      group.cacheWrite += int(usage.cache_write_tokens);
      group.coverage = 'tokens+cost';
    }
  }
  const rows = [...groups.values()];
  return { ok: true, rows, range };
}

// The hub is canonical on Windows but opencode.db lives in WSL, and SQLite
// cannot open a live WAL database across \\wsl.localhost ("database is
// locked"; immutable=1 would silently skip the -wal pages). So Windows asks
// WSL to read its own database and hand back the rows as JSON.
export const SPEND_FORWARD_FLAGS = ['--days', '--date', '--from', '--to', '--project'];
export const SPEND_FORWARD_SWITCHES = ['--utc', '--no-subagents'];

export function forwardSpendArgs(argv) {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    if (SPEND_FORWARD_FLAGS.includes(argv[i]) && i + 1 < argv.length) out.push(argv[i], argv[++i]);
    else if (SPEND_FORWARD_SWITCHES.includes(argv[i])) out.push(argv[i]);
  }
  return out;
}

export function readOpenCodeSpendViaWsl({ hubctlWslPath, args = [], spawn = spawnSync } = {}) {
  // bash -c 'script' $0 $@ : node is not always on the non-interactive PATH.
  const script = 'exec "$(command -v node || echo "$HOME/.local/node/bin/node")" "$0" "$@"';
  const result = spawn(
    'wsl.exe',
    ['-e', 'bash', '-lc', script, hubctlWslPath, 'spend', '--opencode-only', ...args],
    { encoding: 'utf8', timeout: 120_000, windowsHide: true },
  );
  if (result.error || result.status !== 0) {
    const detail = String(result.stderr || result.error?.message || `exit ${result.status}`).trim().split('\n').pop();
    return { ok: false, reason: `OpenCode spend via WSL failed: ${detail}`, rows: [] };
  }
  try {
    const parsed = JSON.parse(result.stdout);
    return { ok: parsed.ok !== false, reason: parsed.reason, rows: parsed.rows ?? [], range: parsed.range ?? null };
  } catch {
    return { ok: false, reason: 'OpenCode spend via WSL did not return JSON', rows: [] };
  }
}

export function mergeSpend(...results) {
  const rows = results.flatMap((result) => result?.rows ?? []);
  rows.sort((a, b) => b.date.localeCompare(a.date) || a.project.localeCompare(b.project) ||
    a.agent.localeCompare(b.agent) || a.model.localeCompare(b.model));
  return {
    rows,
    warnings: results.filter((r) => r && r.ok === false).map((r) => r.reason),
  };
}

// `--by` speaks in user terms (day); rows store the day as `date`.
const BY_FIELD = { day: 'date', date: 'date', project: 'project', agent: 'agent', model: 'model' };

export function groupedRows(rows, by) {
  const keys = [...new Set(by.map((k) => BY_FIELD[k] ?? k))];
  const groups = new Map();
  for (const row of rows) {
    const key = JSON.stringify(keys.map((k) => row[k] ?? '—'));
    if (!groups.has(key)) {
      // Columns that are not grouped on mix several values: show `*`, never
      // the first row's value, which would misattribute the totals.
      const group = { date: '*', project: '*', projectPath: null, agent: '*', model: '*', provider: null };
      for (const k of keys) group[k] = row[k];
      if (keys.includes('project')) group.projectPath = row.projectPath;
      if (keys.includes('model')) group.provider = row.provider;
      groups.set(key, {
        ...group,
        runs: 0, input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0,
        costReportedUsd: 0, costEstimatedUsd: 0,
        coverage: row.coverage,
      });
    }
    const group = groups.get(key);
    group.runs += row.runs;
    for (const field of ['input', 'output', 'reasoning', 'cacheRead', 'cacheWrite', 'costReportedUsd', 'costEstimatedUsd']) {
      group[field] += row[field] ?? 0;
    }
    if (row.coverage === 'tokens+cost') group.coverage = 'tokens+cost';
  }
  return [...groups.values()].sort((a, b) =>
    b.date.localeCompare(a.date) || String(a.project ?? '').localeCompare(String(b.project ?? '')) ||
    String(a.agent ?? '').localeCompare(String(b.agent ?? '')) ||
    String(a.model ?? '').localeCompare(String(b.model ?? '')));
}

/** A token count from an audit line: a missing or unreadable field is zero here. */
function int(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function n(value) {
  return Number(value ?? 0).toLocaleString('en-US');
}

function money(value, estimated = 0) {
  if (!Number(value) && Number(estimated) > 0) return `~$${Number(estimated).toFixed(4)}`;
  return `$${Number(value ?? 0).toFixed(4)}`;
}

export function renderSpend(rows, { color = true, by = ['day', 'project'] } = {}) {
  const paint = color
    ? { bold: (s) => `\x1b[1m${s}\x1b[0m`, dim: (s) => `\x1b[2m${s}\x1b[0m` }
    : { bold: (s) => s, dim: (s) => s };
  const grouped = groupedRows(rows, by);
  const lines = [
    paint.bold('AGENTHUB SPEND'),
    paint.dim('tokens por proyecto y día · Claude: coste, y tokens cuando la línea de auditoría los trae'),
    '',
  ];
  if (!grouped.length) {
    lines.push(paint.dim('  no hay actividad en el rango'));
    return lines.join('\n');
  }
  const headers = ['día', 'proyecto', 'agente', 'modelo', 'runs', 'input', 'output', 'reason', 'cacheR', 'cacheW', 'coste'];
  const widths = [11, 22, 9, 26, 5, 10, 9, 8, 10, 9, 10];
  const line = (cells) => '  ' + cells.map((cell, i) => String(cell).padEnd(widths[i])).join(' ');
  lines.push(paint.dim(line(headers)));
  for (const row of grouped) {
    lines.push(line([
      row.date, String(row.project ?? '—').slice(0, widths[1]), row.agent ?? '—',
      String(row.model ?? '—').slice(0, widths[3]), row.runs,
      n(row.input), n(row.output), n(row.reasoning), n(row.cacheRead), n(row.cacheWrite),
      money(row.costReportedUsd, row.costEstimatedUsd),
    ]));
  }
  lines.push('', paint.dim('cacheR/cacheW van aparte: no se suman al input. Go reporta $0; el coste es el del proveedor.'));
  return lines.join('\n');
}

export function toCsv(rows, by = ['day', 'project']) {
  const grouped = groupedRows(rows, by);
  const header = ['date', 'project', 'projectPath', 'agent', 'model', 'runs', 'input', 'output', 'reasoning', 'cacheRead', 'cacheWrite', 'costReportedUsd', 'coverage'];
  const escape = (value) => {
    const text = String(value ?? '');
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return [header.join(','), ...grouped.map((row) => header.map((key) => escape(row[key])).join(','))].join('\n');
}
