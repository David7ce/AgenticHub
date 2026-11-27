import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  collectAgentHubCoverage,
  collectClaudeUsage,
  collectCodexUsage,
  collectOpenCodeUsage,
  collectUsage,
  mergeCostLedger,
  projectLabel,
  readCostLedger,
  summarizeUsage,
  subscriptionHistory,
  renderCostsMarkdown,
  writeCostLedger,
} from '../lib/costs.mjs';
import { renderCostsPage } from '../page/costs-render.mjs';

const event = (sessionId, id, timestamp, cwd, usage, model = 'claude-opus-test') => JSON.stringify({
  type: 'assistant',
  sessionId,
  timestamp,
  cwd,
  message: { id, model, usage },
});

test('Claude transcripts dedupe streamed message snapshots and store no text', () => {
  const dir = mkdtempSync(join(tmpdir(), 'projects-costs-claude-'));
  const workspace = join(dir, 'workspace');
  const repo = join(workspace, 'Owner', 'Repo');
  mkdirSync(join(repo, '.git'), { recursive: true });
  const transcripts = join(dir, 'claude', 'projects', 'session');
  mkdirSync(transcripts, { recursive: true });
  const path = join(transcripts, 'session.jsonl');
  writeFileSync(path, [
    event('s1', 'm1', '2026-11-01T10:00:00.000Z', repo, {
      input_tokens: 2, output_tokens: 3, cache_read_input_tokens: 11, cache_creation_input_tokens: 5,
    }),
    event('s1', 'm1', '2026-11-01T10:00:01.000Z', repo, {
      input_tokens: 2, output_tokens: 3, cache_read_input_tokens: 11, cache_creation_input_tokens: 5,
    }),
    event('s1', 'm2', '2026-11-01T11:01:00.000Z', repo, {
      input_tokens: 7, output_tokens: 13, cache_read_input_tokens: 17, cache_creation_input_tokens: 19,
    }),
    event('s1', 'synthetic', '2026-11-01T10:02:00.000Z', repo, {
      input_tokens: 99, output_tokens: 99,
    }, '<synthetic>'),
    '',
  ].join('\n'));
  try {
    const result = collectClaudeUsage({ projectsDir: join(dir, 'claude', 'projects'), workspaceRoot: workspace });
    assert.equal(result.rows.length, 2);
    assert.equal(result.status.records, 2);
    assert.equal(result.status.files, 1);
    assert.deepEqual(result.rows.map((row) => row.hour), [10, 11]);
    const totals = result.rows.reduce((sum, row) => {
      for (const key of ['input_tokens', 'cache_write_tokens', 'cache_read_tokens', 'output_tokens']) sum[key] += row[key];
      return sum;
    }, { input_tokens: 0, cache_write_tokens: 0, cache_read_tokens: 0, output_tokens: 0 });
    assert.deepEqual(
      totals,
      { input_tokens: 9, cache_write_tokens: 24, cache_read_tokens: 28, output_tokens: 16 },
    );
    assert.equal(result.rows[0].project, 'Owner/Repo');
    const json = JSON.stringify(result);
    assert.equal(json.includes('prompt'), false);
    assert.equal(json.includes('assistant'), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('OpenCode session DB maps provider/model and keeps token categories separate', () => {
  const dir = mkdtempSync(join(tmpdir(), 'projects-costs-opencode-'));
  const workspace = join(dir, 'workspace');
  const repo = join(workspace, 'Owner', 'Repo');
  mkdirSync(join(repo, '.git'), { recursive: true });
  const dbPath = join(dir, 'opencode.db');
  const db = new DatabaseSync(dbPath);
  db.exec(`CREATE TABLE session_v2 (
    id TEXT, directory TEXT, agent TEXT, model TEXT, time_created INTEGER,
    tokens_input INTEGER, tokens_output INTEGER, tokens_reasoning INTEGER,
    tokens_cache_read INTEGER, tokens_cache_write INTEGER
  )`);
  db.prepare('INSERT INTO session_v2 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    'session-1', repo, 'build', JSON.stringify({ id: 'model-a', providerID: 'provider-a' }),
    Date.parse('2026-11-02T12:00:00Z'), 2, 5, 3, 7, 11,
  );
  db.exec('CREATE TABLE session_message (session_id TEXT, type TEXT, time_created INTEGER, data TEXT)');
  const response = db.prepare('INSERT INTO session_message VALUES (?, ?, ?, ?)');
  for (const [hour, id, providerID] of [[13, 'm-go', 'opencode-go'], [14, 'm-gpt', 'openai']]) {
    response.run('session-1', 'assistant', Date.parse(`2026-11-02T${hour}:00:00Z`), JSON.stringify({
      model: { id, providerID }, tokens: { input: 1, output: 1 }, content: 'must not be copied',
    }));
  }
  db.close();
  try {
    const result = collectOpenCodeUsage({ dbPath, workspaceRoot: workspace });
    assert.equal(result.rows.length, 1);
    assert.equal(result.rows[0].hour, 12);
    assert.equal(result.rows[0].model, 'model-a (provider-a)');
    assert.equal(result.rows[0].project, 'Owner/Repo');
    assert.deepEqual(
      Object.fromEntries(['input_tokens', 'cache_write_tokens', 'cache_read_tokens', 'output_tokens', 'reasoning_tokens'].map((k) => [k, result.rows[0][k]])),
      { input_tokens: 2, cache_write_tokens: 11, cache_read_tokens: 7, output_tokens: 5, reasoning_tokens: 3 },
    );
    const detailed = subscriptionHistory({ rows: result.rows, openCodeAttribution: result.attribution });
    assert.deepEqual(detailed.map(({ hour, model, output_tokens }) => [hour, model, output_tokens]), [
      // The 3 output tokens no reply explains are split by the replies' share (tie: 2 + 1).
      [13, 'm-go (opencode-go)', 1], [14, 'm-gpt (openai)', 1], [12, 'm-go (opencode-go)', 2], [12, 'm-gpt (openai)', 1],
    ]);
    assert.ok(!JSON.stringify(detailed).includes('must not be copied'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Codex records only its recoverable per-thread total, not guessed categories', () => {
  const dir = mkdtempSync(join(tmpdir(), 'projects-costs-codex-'));
  const workspace = join(dir, 'workspace');
  const repo = join(workspace, 'Owner', 'Repo');
  mkdirSync(join(repo, '.git'), { recursive: true });
  const dbPath = join(dir, 'state_1.sqlite');
  const db = new DatabaseSync(dbPath);
  db.exec(`CREATE TABLE threads (
    id TEXT, cwd TEXT, model TEXT, model_provider TEXT, created_at INTEGER, tokens_used INTEGER
  )`);
  db.prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?)').run(
    'thread-1', repo, 'codex-model', 'openai', 1793534400, 23,
  );
  db.close();
  try {
    const result = collectCodexUsage({ codexDir: dir, workspaceRoot: workspace });
    assert.equal(result.rows.length, 1);
    assert.equal(result.rows[0].unknown_tokens, 23);
    assert.ok(Number.isInteger(result.rows[0].hour));
    assert.equal(result.rows[0].input_tokens, 0);
    assert.equal(result.rows[0].project, 'Owner/Repo');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an OpenCode session without a model takes the one its replies used, never a guess', () => {
  const dir = mkdtempSync(join(tmpdir(), 'projects-costs-opencode-model-'));
  const dbPath = join(dir, 'opencode.db');
  const db = new DatabaseSync(dbPath);
  db.exec(`CREATE TABLE session_v2 (
    id TEXT, directory TEXT, agent TEXT, model TEXT, time_created INTEGER,
    tokens_input INTEGER, tokens_output INTEGER, tokens_reasoning INTEGER,
    tokens_cache_read INTEGER, tokens_cache_write INTEGER
  )`);
  const session = db.prepare('INSERT INTO session_v2 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  session.run('one-model', dir, null, null, Date.parse('2026-11-22T00:41:00Z'), 10, 1, 0, 5, 0);
  session.run('two-models', dir, null, null, Date.parse('2026-11-22T01:00:00Z'), 4, 1, 0, 0, 0);
  session.run('no-replies', dir, null, null, Date.parse('2026-11-22T02:00:00Z'), 3, 1, 0, 0, 0);
  db.exec('CREATE TABLE session_message (session_id TEXT, type TEXT, time_created INTEGER, data TEXT)');
  const message = db.prepare('INSERT INTO session_message VALUES (?, ?, ?, ?)');
  const reply = (id, model, providerID, at) => message.run(id, 'assistant', Date.parse(at), JSON.stringify({
    model: { id: model, providerID }, content: 'must not be copied',
  }));
  reply('one-model', 'deepseek-flash', 'opencode-go', '2026-11-22T00:41:01Z');
  reply('one-model', 'deepseek-flash', 'opencode-go', '2026-11-22T00:41:02Z');
  reply('two-models', 'a', 'opencode-go', '2026-11-22T01:00:01Z');
  reply('two-models', 'b', 'openai', '2026-11-22T01:00:02Z');
  message.run('one-model', 'user', Date.parse('2026-11-22T00:41:00Z'), JSON.stringify({ text: 'hi' }));
  db.close();
  try {
    const { rows } = collectOpenCodeUsage({ dbPath, workspaceRoot: dir });
    assert.deepEqual(rows.map((row) => [row.hour, row.model]), [
      [0, 'deepseek-flash (opencode-go)'], [1, 'unknown-model'], [2, 'unknown-model'],
    ]);
    assert.ok(!JSON.stringify(rows).includes('must not be copied'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('OpenCode tokens no reply explains are an estimate: the one model, or split by each model share', () => {
  const dir = mkdtempSync(join(tmpdir(), 'projects-costs-opencode-rest-'));
  const dbPath = join(dir, 'opencode.db');
  const db = new DatabaseSync(dbPath);
  db.exec(`CREATE TABLE session_v2 (
    id TEXT, directory TEXT, agent TEXT, model TEXT, time_created INTEGER,
    tokens_input INTEGER, tokens_output INTEGER, tokens_reasoning INTEGER,
    tokens_cache_read INTEGER, tokens_cache_write INTEGER
  )`);
  const session = db.prepare('INSERT INTO session_v2 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  session.run('single', dir, null, null, Date.parse('2026-11-25T18:00:00Z'), 100, 10, 0, 0, 0);
  session.run('mixed', dir, null, null, Date.parse('2026-11-25T19:00:00Z'), 100, 10, 0, 0, 0);
  session.run('silent', dir, null, JSON.stringify({ id: 'big', providerID: 'opencode-go' }), Date.parse('2026-11-25T20:00:00Z'), 30, 3, 0, 0, 0);
  db.exec('CREATE TABLE session_message (session_id TEXT, type TEXT, time_created INTEGER, data TEXT)');
  const message = db.prepare('INSERT INTO session_message VALUES (?, ?, ?, ?)');
  const reply = (id, model, providerID, at, input, output) => message.run(id, 'assistant', Date.parse(at), JSON.stringify({
    model: { id: model, providerID }, tokens: { input, output },
  }));
  reply('single', 'flash', 'opencode-go', '2026-11-25T18:01:00Z', 60, 6);
  reply('mixed', 'a', 'opencode-go', '2026-11-25T19:01:00Z', 45, 5);
  reply('mixed', 'b', 'openai', '2026-11-25T19:02:00Z', 15, 1);
  db.close();
  try {
    const { attribution } = collectOpenCodeUsage({ dbPath, workspaceRoot: dir });
    const pick = (row) => [row.hour, row.model, row.input_tokens, row.output_tokens, row.inferred === true];
    assert.deepEqual(attribution.rows.map(pick).sort((x, y) => x[0] - y[0] || String(x[1]).localeCompare(y[1]) || x[4] - y[4]), [
      [18, 'flash (opencode-go)', 60, 6, false],
      [18, 'flash (opencode-go)', 40, 4, true],
      [19, 'a (opencode-go)', 45, 5, false],
      [19, 'a (opencode-go)', 30, 3, true],
      [19, 'b (openai)', 15, 1, false],
      [19, 'b (openai)', 10, 1, true],
      [20, 'big (opencode-go)', 30, 3, true],
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an OpenCode session whose label changed is not kept twice in the ledger', () => {
  const now = '2026-11-27T00:00:00.000Z';
  const base = {
    date: '2026-11-25', hour: 18, source: 'opencode', agent: 'opencode', project: 'root',
    input_tokens: 0, cache_write_tokens: 0, cache_read_tokens: 0, output_tokens: 0, reasoning_tokens: 0,
    unknown_tokens: 0, observations: 1, sessions: 1,
  };
  const previous = {
    schemaVersion: 2, generatedAt: null, sources: {}, rows: [
      // Earlier snapshots of the same session, each under the model it had then.
      { ...base, model: 'deepseek (opencode-go)', input_tokens: 900 },
      { ...base, model: 'mimo (opencode)', input_tokens: 950 },
      // A bucket the current scan no longer sees (session deleted): kept.
      { ...base, hour: 3, model: 'deepseek (opencode-go)', input_tokens: 40 },
    ],
  };
  const incoming = { sources: {}, rows: [{ ...base, model: 'gpt (openai)', input_tokens: 1000 }] };
  const merged = mergeCostLedger(previous, incoming, now);
  assert.deepEqual(merged.rows.map((row) => [row.hour, row.model, row.input_tokens]), [
    [3, 'deepseek (opencode-go)', 40],
    [18, 'gpt (openai)', 1000],
  ]);
});

test('retained OpenCode buckets with no current session keep their model labels', () => {
  const row = (model, output_tokens, hour = 0) => ({
    date: '2026-11-24', hour, source: 'opencode', agent: 'opencode', project: 'root', model,
    input_tokens: 0, cache_write_tokens: 0, cache_read_tokens: 0, output_tokens, reasoning_tokens: 0, unknown_tokens: 0,
  });
  const result = subscriptionHistory({
    rows: [row('deepseek (opencode-go)', 20), row('haiku (opencode-go)', 5)],
    openCodeAttribution: { first: '2026-11-16', rows: [], covered: [row('other (opencode-go)', 1, 9)] },
  });
  assert.deepEqual(result.map(({ model, output_tokens }) => [model, output_tokens]).sort(), [
    ['deepseek (opencode-go)', 20], ['haiku (opencode-go)', 5],
  ]);
});

const rolloutLine = (timestamp, type, payload) => JSON.stringify({ timestamp, type, payload });
const tokenCount = (timestamp, total) => rolloutLine(timestamp, 'event_msg', {
  type: 'token_count',
  info: { total_token_usage: total, last_token_usage: total },
});

test('Codex rollouts give each call its own hour and breakdown, without double counting the thread total', () => {
  const dir = mkdtempSync(join(tmpdir(), 'projects-costs-codex-rollout-'));
  const workspace = join(dir, 'workspace');
  const repo = join(workspace, 'Owner', 'Repo');
  mkdirSync(join(repo, '.git'), { recursive: true });
  const sessions = join(dir, 'sessions', '2026', '11', '25');
  mkdirSync(sessions, { recursive: true });
  writeFileSync(join(sessions, 'rollout-t1.jsonl'), [
    rolloutLine('2026-11-25T23:58:00.000Z', 'session_meta', { id: 't1', cwd: repo, model_provider: 'openai' }),
    rolloutLine('2026-11-25T23:58:01.000Z', 'turn_context', { model: 'gpt-test' }),
    rolloutLine('2026-11-25T23:58:02.000Z', 'response_item', { type: 'message', content: 'token_count in text must be ignored' }),
    tokenCount('2026-11-25T23:59:00.000Z', {
      input_tokens: 1000, cached_input_tokens: 800, output_tokens: 50, reasoning_output_tokens: 5, total_tokens: 1050,
    }),
    // Codex repeats the same cumulative reading; it must not count twice.
    tokenCount('2026-11-25T23:59:01.000Z', {
      input_tokens: 1000, cached_input_tokens: 800, output_tokens: 50, reasoning_output_tokens: 5, total_tokens: 1050,
    }),
    tokenCount('2026-11-26T00:10:00.000Z', {
      input_tokens: 1600, cached_input_tokens: 1300, output_tokens: 90, reasoning_output_tokens: 9, total_tokens: 1690,
    }),
  ].join('\n'));
  const db = new DatabaseSync(join(dir, 'state_1.sqlite'));
  db.exec('CREATE TABLE threads (id TEXT, cwd TEXT, model TEXT, model_provider TEXT, created_at INTEGER, tokens_used INTEGER)');
  const insert = db.prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?)');
  insert.run('t1', repo, 'gpt-test', 'openai', Date.parse('2026-11-25T23:58:00Z') / 1000, 1690);
  insert.run('t2', repo, 'gpt-test', 'openai', Date.parse('2026-11-24T10:00:00Z') / 1000, 40);
  db.close();
  try {
    const result = collectCodexUsage({ codexDir: dir, workspaceRoot: workspace });
    const pick = (row) => [row.date, row.hour, row.model, row.input_tokens, row.cache_read_tokens,
      row.output_tokens, row.reasoning_tokens, row.unknown_tokens];
    assert.deepEqual(result.rows.map(pick), [
      ['2026-11-24', 10, 'gpt-test (openai)', 0, 0, 0, 0, 40],
      ['2026-11-25', 23, 'gpt-test (openai)', 200, 800, 50, 5, 0],
      ['2026-11-26', 0, 'gpt-test (openai)', 100, 500, 40, 4, 0],
    ]);
    assert.ok(result.rows.every((row) => row.project === 'Owner/Repo'));
    assert.match(result.status.note, /desglose/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a Codex breakdown replaces the old per-thread totals in the ledger', () => {
  const now = '2026-11-27T00:00:00.000Z';
  const base = {
    source: 'codex', agent: 'codex', model: 'gpt-test (openai)', project: 'Owner/Repo',
    input_tokens: 0, cache_write_tokens: 0, cache_read_tokens: 0, output_tokens: 0, reasoning_tokens: 0,
    unknown_tokens: 0, observations: 1, sessions: 1,
  };
  const previous = {
    schemaVersion: 2, generatedAt: null, sources: {}, rows: [
      { ...base, date: '2026-11-20', hour: 9, unknown_tokens: 77 },
      { ...base, date: '2026-11-25', hour: 23, unknown_tokens: 1690 },
    ],
  };
  const incoming = {
    sources: { codex: { available: true, records: 2 } },
    rows: [
      { ...base, date: '2026-11-25', hour: 23, input_tokens: 200, cache_read_tokens: 800, output_tokens: 50 },
      { ...base, date: '2026-11-26', hour: 0, input_tokens: 100, cache_read_tokens: 500, output_tokens: 40 },
    ],
  };
  const merged = mergeCostLedger(previous, incoming, now);
  assert.deepEqual(merged.rows.map((row) => [row.date, row.hour, row.unknown_tokens, row.cache_read_tokens]), [
    ['2026-11-20', 9, 77, 0],
    ['2026-11-25', 23, 0, 800],
    ['2026-11-26', 0, 0, 500],
  ]);
});

test('only an unambiguous Go label can provisionally attribute retained aggregates', () => {
  const base = { date: '2026-11-02', source: 'opencode', agent: 'opencode', project: 'p' };
  const go = { ...base, hour: 12, model: 'deepseek (opencode-go)', output_tokens: 20 };
  const result = subscriptionHistory({
    rows: [go, { ...go, hour: 13 }, { ...go, hour: 13, model: 'gpt (openai)', output_tokens: 10 }],
    openCodeAttribution: { first: base.date, rows: [], covered: [{ ...go, output_tokens: 5 }] },
  });
  assert.deepEqual(result.map(({ model, output_tokens, inferred }) => [model, output_tokens, inferred]), [
    ['deepseek (opencode-go)', 15, true], ['unknown-model', 30, undefined],
  ]);
});

test('Agent Hub audit coverage is reported without treating missing token fields as zero spend', () => {
  const dir = mkdtempSync(join(tmpdir(), 'projects-costs-hub-'));
  const path = join(dir, 'runs.jsonl');
  writeFileSync(path, [
    JSON.stringify({ time: '2026-11-03T10:00:00Z', agent: 'claude', prompt: 'do not retain' }),
    JSON.stringify({ time: '2026-11-03T11:00:00Z', agent: 'opencode', cost: { amount: 0.1 } }),
  ].join('\n'));
  try {
    const result = collectAgentHubCoverage(path);
    assert.equal(result.status.records, 2);
    assert.match(result.status.note, /no tokens/i);
    assert.equal(JSON.stringify(result).includes('do not retain'), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Agent Hub per-turn usage is attributed, never added to the provider totals', () => {
  const dir = mkdtempSync(join(tmpdir(), 'projects-costs-hub-usage-'));
  const path = join(dir, 'runs.jsonl');
  writeFileSync(path, [
    JSON.stringify({
      time: '2026-11-25T10:00:00Z', agent: 'opencode', sessionId: 'ses_one', cost: { amount: 0.02 },
      usage: {
        input_tokens: 100, cache_write_tokens: 0, cache_read_tokens: 5_000,
        output_tokens: 20, reasoning_tokens: 3, confidence: 'delta',
      },
    }),
    JSON.stringify({
      time: '2026-11-25T11:00:00Z', agent: 'claude',
      usage: { input_tokens: 0, cache_read_tokens: 0, output_tokens: 0, confidence: 'unavailable' },
    }),
  ].join('\n'));
  try {
    const result = collectAgentHubCoverage(path);
    assert.equal(result.status.tokens.turns, 1, 'an unavailable reading is not a turn with tokens');
    assert.equal(result.status.tokens.input_tokens, 100);
    assert.equal(result.status.tokens.cache_read_tokens, 5_000);
    assert.match(result.status.note, /atribución/i);
    const ledger = collectUsage({
      projectsDir: join(dir, 'none'),
      dbPath: join(dir, 'none.db'),
      codexDir: join(dir, 'none'),
      agentHubLogPath: path,
    });
    assert.equal(ledger.rows.length, 0, 'the audit line never becomes a provider row');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('project labels hide temporary paths and find the nearest repository root', () => {
  const dir = mkdtempSync(join(tmpdir(), 'projects-costs-paths-'));
  const workspace = join(dir, 'workspace');
  const repo = join(workspace, 'Owner', 'Project');
  mkdirSync(join(repo, '.git'), { recursive: true });
  try {
    assert.equal(projectLabel(join(repo, 'src'), workspace), 'Owner/Project');
    assert.equal(projectLabel(join(tmpdir(), 'random-user-path'), workspace), 'temporary');
    assert.equal(projectLabel('', workspace), 'unknown-project');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ledger merge is idempotent, monotonic, and retains buckets missing after transcript rotation', () => {
  const now = '2026-11-04T00:00:00.000Z';
  const row = {
    date: '2026-11-03', source: 'claude-code', agent: 'claude', model: 'opus', project: 'Owner/Repo',
    input_tokens: 3, cache_write_tokens: 5, cache_read_tokens: 7, output_tokens: 11, reasoning_tokens: 0, unknown_tokens: 0,
    observations: 2, sessions: 1,
  };
  const empty = { schemaVersion: 1, generatedAt: null, sources: {}, rows: [] };
  const incoming = { rows: [row], sources: { claudeCode: { available: true, records: 2 } } };
  const once = mergeCostLedger(empty, incoming, now);
  const twice = mergeCostLedger(once, incoming, now);
  assert.equal(twice.rows.length, 1);
  assert.equal(twice.rows[0].cache_read_tokens, 7);
  const lowerSnapshot = mergeCostLedger(twice, {
    rows: [{ ...row, cache_read_tokens: 2, output_tokens: 4 }],
    sources: { claudeCode: { available: true, records: 1 } },
  }, now);
  assert.equal(lowerSnapshot.rows[0].cache_read_tokens, 7);
  assert.equal(lowerSnapshot.rows[0].output_tokens, 11);
  assert.equal(mergeCostLedger(twice, { rows: [], sources: {} }, now).rows.length, 1);
});

test('daily v1 buckets migrate to hours without double-counting and retain unassignable remainder', () => {
  const v1 = {
    schemaVersion: 1,
    generatedAt: '2026-11-04T00:00:00Z',
    sources: {},
    rows: [{
      date: '2026-11-03', hour: 10, source: 'claude-code', agent: 'claude', model: 'opus', project: 'Owner/Repo',
      input_tokens: 0, cache_write_tokens: 0, cache_read_tokens: 30, output_tokens: 0, reasoning_tokens: 0, unknown_tokens: 0,
      observations: 3, sessions: 1,
    }],
  };
  const dir = mkdtempSync(join(tmpdir(), 'projects-costs-v1-'));
  const ledgerPath = join(dir, 'costs.json');
  writeFileSync(ledgerPath, JSON.stringify(v1));
  try {
    const migrated = readCostLedger(ledgerPath);
    assert.equal(migrated.schemaVersion, 2);
    assert.equal(migrated.rows[0].legacyDaily, true);
    const hourly = [
      { ...v1.rows[0], hour: 9, cache_read_tokens: 10, observations: 1, legacyDaily: undefined },
      { ...v1.rows[0], hour: 10, cache_read_tokens: 15, observations: 1, legacyDaily: undefined },
    ];
    const incoming = { rows: hourly, sources: {} };
    const first = mergeCostLedger(migrated, incoming);
    const unknown = first.rows.find((row) => row.hour === null);
    assert.equal(unknown.cache_read_tokens, 5);
    const again = mergeCostLedger(first, incoming);
    assert.equal(again.rows.find((row) => row.hour === null).cache_read_tokens, 5);
    assert.equal(again.rows.reduce((sum, row) => sum + row.cache_read_tokens, 0), 30);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ledger normalizes prior OpenCode roles without duplicating their tokens', () => {
  const base = {
    date: '2026-11-03', source: 'opencode', model: 'model-a', project: 'Owner/Repo',
    output_tokens: 0, reasoning_tokens: 0, unknown_tokens: 0,
  };
  const previous = {
    schemaVersion: 1, generatedAt: null, sources: {},
    rows: [
      { ...base, agent: 'build', input_tokens: 3, cache_write_tokens: 5, cache_read_tokens: 7, observations: 1, sessions: 1 },
      { ...base, agent: 'plan', input_tokens: 11, cache_write_tokens: 13, cache_read_tokens: 17, observations: 2, sessions: 2 },
    ],
  };
  const updated = {
    rows: [{
      ...base, agent: 'opencode', input_tokens: 14, cache_write_tokens: 18, cache_read_tokens: 24,
      observations: 3, sessions: 3,
    }],
    sources: {},
  };
  const result = mergeCostLedger(previous, updated, '2026-11-04T00:00:00Z');
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].input_tokens, 14);
  assert.equal(result.rows[0].cache_read_tokens, 24);
  assert.equal(result.rows[0].agent, 'opencode');
});

test('ledger read/write and markdown expose token categories, not paths or money', () => {
  const dir = mkdtempSync(join(tmpdir(), 'projects-costs-ledger-'));
  const ledgerPath = join(dir, 'costs.json');
  const reportPath = join(dir, 'COSTS.md');
  const previous = readCostLedger(join(dir, 'missing.json'));
  const ledger = mergeCostLedger(previous, {
    rows: [{
      date: '2026-11-03', hour: 10, source: 'claude-code', agent: 'claude', model: 'opus', project: 'Owner/Repo',
      input_tokens: 1, cache_write_tokens: 2, cache_read_tokens: 3, output_tokens: 4, reasoning_tokens: 0, unknown_tokens: 0,
      observations: 1, sessions: 1,
    }],
    sources: { claudeCode: { available: true, records: 1, firstDate: '2026-11-03', lastDate: '2026-11-03', note: 'fixture' } },
  }, '2026-11-04T00:00:00.000Z');
  try {
    writeCostLedger(ledger, { ledgerPath, reportPath });
    assert.deepEqual(readCostLedger(ledgerPath), ledger);
    const report = renderCostsMarkdown(ledger);
    assert.match(report, /Lectura caché/);
    assert.match(report, /Owner\/Repo/);
    assert.doesNotMatch(report, /\$[0-9]/);
    assert.doesNotMatch(report, /D:\\\\|C:\\\\Users/);
    assert.equal(summarizeUsage(ledger).agents.find((row) => row.agent === 'claude').tokens.cache_read_tokens, 3);
    const page = renderCostsPage(ledger);
    assert.match(page, /dailyChart/);
    assert.match(page, /hourlyChart/);
    assert.match(page, /"hour":10/);
    assert.match(page, /2026-11-03/);
    assert.equal((page.match(/<\/script>/g) || []).length, 6, 'shared scripts, two page scripts and the data block');
    assert.doesNotMatch(page, /\/\*COSTS_(?:DATA|SCRIPT|STYLES)\*\//);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('summary_work_tokens_match_page', () => {
  const base = { date: '2026-11-23', hour: 1, project: 'p', model: 'm', input_tokens: 0, output_tokens: 0, cache_write_tokens: 0, cache_read_tokens: 0, reasoning_tokens: 0, unknown_tokens: 0 };
  const ledger = { schemaVersion: 2, generatedAt: null, sources: {}, rows: [
    { ...base, agent: 'claude', source: 'claude', input_tokens: 1, output_tokens: 2, cache_write_tokens: 3, unknown_tokens: 4, cache_read_tokens: 1000 },
    { ...base, agent: 'opencode', source: 'opencode', output_tokens: 5 },
  ] };
  const agents = Object.fromEntries(summarizeUsage(ledger).agents.map((row) => [row.agent, row.work_tokens]));
  assert.deepEqual(agents, { claude: 10, opencode: 5, codex: 0 });
});

test('reply-based OpenCode history is marked as timed per step', () => {
  const row = { date: '2026-11-20', hour: 4, source: 'opencode', agent: 'opencode', project: 'p', model: 'm (opencode-go)', output_tokens: 1 };
  const result = subscriptionHistory({ rows: [], openCodeAttribution: { first: '2026-11-20', rows: [row], covered: [] } });
  assert.deepEqual(result.map((r) => r.stepHours), [true]);
});
