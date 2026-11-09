import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  forwardSpendArgs,
  groupedRows,
  mergeSpend,
  readClaudeSpend,
  readOpenCodeSpend,
  readOpenCodeSpendViaWsl,
  renderSpend,
  toCsv,
} from '../spend.mjs';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'hub-spend-'));
  const dbPath = join(dir, 'opencode.db');
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE project (id TEXT, name TEXT, worktree TEXT);
    CREATE TABLE session_v2 (id TEXT, project_id TEXT, directory TEXT, parent_id TEXT);
    CREATE TABLE session_message (session_id TEXT, type TEXT, time_created INTEGER, data TEXT);
  `);
  db.prepare('INSERT INTO project VALUES (?,?,?)').run('p1', null, '/mnt/d/Workspaces/AgentHub');
  db.prepare('INSERT INTO project VALUES (?,?,?)').run('p2', null, '/mnt/d/Workspaces/other');
  db.prepare('INSERT INTO session_v2 VALUES (?,?,?,?)').run('s1', 'p1', '/mnt/d/Workspaces/AgentHub', null);
  db.prepare('INSERT INTO session_v2 VALUES (?,?,?,?)').run('s2', 'p2', '/mnt/d/Workspaces/other', null);
  db.prepare('INSERT INTO session_v2 VALUES (?,?,?,?)').run('s3', 'p1', '/mnt/d/Workspaces/AgentHub', 's1');
  const msg = (session, time, tokens, cost = 0) => db.prepare(
    'INSERT INTO session_message VALUES (?,?,?,?)',
  ).run(session, 'assistant', time, JSON.stringify({
    cost,
    model: { id: 'deepseek-v4.1-flash', providerID: 'opencode-go' },
    tokens,
  }));
  msg('s1', Date.UTC(2026, 10, 8, 10), { input: 100, output: 10, reasoning: 2, cache: { read: 1000, write: 0 } });
  msg('s1', Date.UTC(2026, 10, 8, 11), { input: 200, output: 20, reasoning: 3, cache: { read: 2000, write: 0 } });
  msg('s2', Date.UTC(2026, 10, 8, 12), { input: 50, output: 5, reasoning: 1, cache: { read: 500, write: 0 } });
  msg('s3', Date.UTC(2026, 10, 9, 9), { input: 7, output: 1, reasoning: 0, cache: { read: 70, write: 0 } });
  db.prepare('INSERT INTO session_message VALUES (?,?,?,?)').run('s1', 'assistant', Date.UTC(2026, 10, 8, 13), '{"tokens":null}');
  db.close();
  return { dir, dbPath };
}

test('OpenCode spend is exact by project and day', () => {
  const { dir, dbPath } = fixture();
  try {
    const result = readOpenCodeSpend({
      dbPath, from: '2026-11-08', to: '2026-11-08', utc: true,
    });
    assert.equal(result.ok, true);
    assert.equal(result.rows.length, 2);
    const hub = result.rows.find((row) => row.project === 'AgentHub');
    assert.equal(hub.runs, 2);
    assert.equal(hub.input, 300);
    assert.equal(hub.output, 30);
    assert.equal(hub.cacheRead, 3000);
    assert.equal(result.rows.find((row) => row.project === 'other').input, 50);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('subagents are excluded with includeSubagents=false', () => {
  const { dir, dbPath } = fixture();
  try {
    const all = readOpenCodeSpend({ dbPath, from: '2026-11-09', to: '2026-11-09', utc: true });
    const roots = readOpenCodeSpend({
      dbPath, from: '2026-11-09', to: '2026-11-09', utc: true, includeSubagents: false,
    });
    assert.equal(all.rows.length, 1);
    assert.equal(roots.rows.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a missing database degrades to a warning, not a throw', () => {
  const result = readOpenCodeSpend({ dbPath: join(tmpdir(), 'does-not-exist-opencode.db') });
  assert.equal(result.ok, false);
  assert.match(result.reason, /no OpenCode database/);
});

test('Claude spend is cost-only and explicitly unknown project', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hub-spend-log-'));
  const logPath = join(dir, 'runs.jsonl');
  try {
    writeFileSync(logPath, [
      JSON.stringify({ time: '2026-11-08T10:00:00Z', agent: 'claude', model: 'sonnet', cost: { amount: 0.25 } }),
      JSON.stringify({ time: '2026-11-08T11:00:00Z', agent: 'claude', model: 'sonnet', cost: { amount: 0.5 } }),
      JSON.stringify({ time: '2026-11-08T12:00:00Z', agent: 'opencode', cost: { amount: 0 } }),
    ].join('\n'));
    const result = readClaudeSpend({ logPath, from: '2026-11-08', to: '2026-11-08', utc: true });
    assert.equal(result.rows.length, 1);
    assert.equal(result.rows[0].project, 'unknown');
    assert.equal(result.rows[0].coverage, 'cost-only');
    assert.equal(result.rows[0].costReportedUsd, 0.75);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('mergeSpend keeps warnings and sorts newest first', () => {
  const merged = mergeSpend(
    { ok: true, rows: [{ date: '2026-11-07', project: 'A', agent: 'opencode', model: 'm' }] },
    { ok: false, reason: 'db missing', rows: [] },
    { ok: true, rows: [{ date: '2026-11-08', project: 'B', agent: 'opencode', model: 'm' }] },
  );
  assert.equal(merged.rows[0].date, '2026-11-08');
  assert.deepEqual(merged.warnings, ['db missing']);
});

test('render and CSV expose cache separately', () => {
  const rows = [{
    date: '2026-11-08', project: 'AgentHub', projectPath: '/x', agent: 'opencode',
    model: 'm', runs: 1, input: 10, output: 2, reasoning: 1,
    cacheRead: 100, cacheWrite: 0, costReportedUsd: 0, coverage: 'tokens+cost',
  }];
  const text = renderSpend(rows, { color: false });
  assert.match(text, /cacheR/);
  assert.match(text, /AgentHub/);
  assert.doesNotMatch(text, /\x1b\[/);
  const csv = toCsv(rows);
  assert.match(csv, /cacheRead/);
  assert.match(csv, /AgentHub/);
});

const spendRow = (date, project, input, extra = {}) => ({
  date, project, projectPath: `/p/${project}`, agent: 'opencode', model: 'm', provider: 'x',
  runs: 1, input, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, costReportedUsd: 0,
  coverage: 'tokens+cost', ...extra,
});

test('--by day keeps one row per day (the field is date, the flag says day)', () => {
  const rows = [spendRow('2026-11-08', 'A', 10), spendRow('2026-11-07', 'A', 5), spendRow('2026-11-08', 'B', 1)];
  const byDay = groupedRows(rows, ['day']);
  assert.equal(byDay.length, 2);
  assert.deepEqual(byDay.map((r) => [r.date, r.input]), [['2026-11-08', 11], ['2026-11-07', 5]]);
  const byDayProject = groupedRows(rows, ['day', 'project']);
  assert.equal(byDayProject.length, 3);
});

test('columns not grouped on show * instead of the first row value', () => {
  const rows = [spendRow('2026-11-08', 'A', 10), spendRow('2026-11-08', 'B', 1, { agent: 'claude' })];
  const [only] = groupedRows(rows, ['day']);
  assert.equal(only.project, '*');
  assert.equal(only.agent, '*');
  assert.equal(only.projectPath, null);
  const [byProject] = groupedRows([spendRow('2026-11-08', 'A', 1), spendRow('2026-11-07', 'A', 2)], ['project']);
  assert.equal(byProject.date, '*');
  assert.equal(byProject.input, 3);
});

test('forwardSpendArgs passes range and filter flags only', () => {
  assert.deepEqual(
    forwardSpendArgs(['spend', '--days', '3', '--json', '--by', 'day', '--utc', '--project', 'A', '--no-subagents', '--db', 'x']),
    ['--days', '3', '--utc', '--project', 'A', '--no-subagents'],
  );
});

test('readOpenCodeSpendViaWsl runs the WSL side and parses its rows', () => {
  let call;
  const fake = (cmd, args) => {
    call = { cmd, args };
    return { status: 0, stdout: JSON.stringify({ ok: true, rows: [spendRow('2026-11-08', 'A', 1)] }), stderr: '' };
  };
  const result = readOpenCodeSpendViaWsl({ hubctlWslPath: '/mnt/d/h/hubctl.mjs', args: ['--days', '2'], spawn: fake });
  assert.equal(call.cmd, 'wsl.exe');
  assert.deepEqual(call.args.slice(-5), ['/mnt/d/h/hubctl.mjs', 'spend', '--opencode-only', '--days', '2']);
  assert.equal(result.ok, true);
  assert.equal(result.rows.length, 1);

  const failed = readOpenCodeSpendViaWsl({ hubctlWslPath: '/x', spawn: () => ({ status: 1, stdout: '', stderr: 'boom\nlast line' }) });
  assert.equal(failed.ok, false);
  assert.match(failed.reason, /via WSL failed: last line/);
  const garbage = readOpenCodeSpendViaWsl({ hubctlWslPath: '/x', spawn: () => ({ status: 0, stdout: 'nope', stderr: '' }) });
  assert.equal(garbage.ok, false);
});

test('Claude runs with a cwd get a project; fanout worktrees count as their repo', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hub-spend-cwd-'));
  const logPath = join(dir, 'runs.jsonl');
  try {
    writeFileSync(logPath, [
      JSON.stringify({ time: '2026-11-08T10:00:00Z', agent: 'claude', model: 'sonnet', cwd: 'D:\\W\\repo', cost: { amount: 0.25 } }),
      JSON.stringify({ time: '2026-11-08T11:00:00Z', agent: 'claude', model: 'sonnet', cwd: 'D:\\W\\repo\\.git\\agent-worktrees\\r1-claude', cost: { amount: 0.5 } }),
      JSON.stringify({ time: '2026-11-08T12:00:00Z', agent: 'claude', model: 'sonnet', cost: { amount: 1 } }),
    ].join('\n'));
    const result = readClaudeSpend({ logPath, from: '2026-11-08', to: '2026-11-08', utc: true });
    const byProject = Object.fromEntries(result.rows.map((r) => [r.project, r.costReportedUsd]));
    assert.deepEqual(byProject, { 'repo': 0.75, unknown: 1 });
    const only = readClaudeSpend({ logPath, from: '2026-11-08', to: '2026-11-08', utc: true, project: 'repo' });
    assert.equal(only.rows.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
