import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  captureUsage,
  contextFromUsage,
  emptyUsage,
  snapshotUsage,
} from '../usage-capture.mjs';

const require = createRequire(import.meta.url);
const tmp = () => mkdtempSync(join(tmpdir(), 'usage-capture-'));

function claudeLine({ id, at, cwd = 'D:\\repo', input = 1, write = 2, read = 3, output = 4, thinking = 5 }) {
  return `${JSON.stringify({
    cwd,
    message: {
      id,
      model: 'claude-opus-5-5',
      usage: {
        input_tokens: input,
        cache_creation_input_tokens: write,
        cache_read_input_tokens: read,
        output_tokens: output,
        output_tokens_details: { thinking_tokens: thinking },
      },
    },
    timestamp: new Date(at).toISOString(),
  })}\n`;
}

test('a Claude turn is only the messages appended after the snapshot', () => {
  const dir = tmp();
  const cwd = 'D:\\repo';
  const sessionId = 'aaaaaaaa-1111-2222-3333-444444444444';
  // The project directory is Claude's to name: the reader finds the file by
  // session id, not by deriving the slug.
  const projectDir = join(dir, 'projects', 'a-slug-we-do-not-compute');
  mkdirSync(projectDir, { recursive: true });
  const file = join(projectDir, `${sessionId}.jsonl`);
  const startedMs = Date.now() - 60_000;

  writeFileSync(file, claudeLine({ id: 'old', at: startedMs - 30_000, input: 100, read: 900 }));
  const base = snapshotUsage('claude', { sessionId, cwd, options: { claudeConfigDir: dir } });
  assert.equal(base.path, file);

  appendFileSync(file, claudeLine({ id: 'new-1', at: startedMs + 1_000, input: 10, write: 20, read: 30, output: 40 }));
  appendFileSync(file, claudeLine({ id: 'new-1', at: startedMs + 1_100, input: 10, write: 20, read: 30, output: 40 })); // streamed repeat
  appendFileSync(file, claudeLine({ id: 'new-2', at: startedMs + 2_000, input: 1, write: 2, read: 3, output: 4 }));

  const usage = captureUsage({
    agent: 'claude', sessionId, cwd, base, startedMs, options: { claudeConfigDir: dir },
  });
  assert.equal(usage.confidence, 'exact');
  assert.equal(usage.source, 'claude-transcript');
  assert.equal(usage.input_tokens, 11, 'the deduped messages of this turn only');
  assert.equal(usage.cache_write_tokens, 22);
  assert.equal(usage.cache_read_tokens, 33);
  assert.equal(usage.output_tokens, 44);
  assert.equal(usage.reasoning_tokens, 10);
});

test('an unknown Claude session falls back to the transcript of the same tree', () => {
  const dir = tmp();
  const cwd = 'D:\\repo';
  const startedMs = Date.now() - 2_000;
  const projectDir = join(dir, 'projects', 'a-slug-we-do-not-compute');
  mkdirSync(projectDir, { recursive: true });
  // Another tree's transcript is present and newer: it must not be chosen.
  const otherDir = join(dir, 'projects', 'another-slug');
  mkdirSync(otherDir, { recursive: true });
  writeFileSync(
    join(otherDir, 'dddddddd-1111-2222-3333-444444444444.jsonl'),
    claudeLine({ id: 'other', at: startedMs + 900, cwd: 'D:\\elsewhere', input: 999 }),
  );
  const file = join(projectDir, 'bbbbbbbb-1111-2222-3333-444444444444.jsonl');
  writeFileSync(file, claudeLine({ id: 'only', at: startedMs + 500, cwd, input: 7, read: 11 }));

  const usage = captureUsage({
    agent: 'claude', sessionId: 'unknown', cwd, base: null, startedMs,
    options: { claudeConfigDir: dir },
  });
  assert.equal(usage.confidence, 'time-window');
  assert.equal(usage.input_tokens, 7);
  assert.equal(usage.cache_read_tokens, 11);
});

test('no Claude transcript is unavailable, never a silent zero', () => {
  const usage = captureUsage({
    agent: 'claude',
    sessionId: 'missing',
    cwd: 'D:\\nowhere',
    base: null,
    startedMs: Date.now(),
    options: { claudeConfigDir: tmp() },
  });
  assert.equal(usage.confidence, 'unavailable');
  assert.ok(usage.reason);
  assert.equal(usage.input_tokens, 0);
});

test('an OpenCode session is measured as the delta of its cumulative row', () => {
  const dir = tmp();
  const dbPath = join(dir, 'opencode.db');
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(dbPath);
  db.exec(`CREATE TABLE session_v2 (
    id TEXT PRIMARY KEY,
    tokens_input INTEGER, tokens_output INTEGER, tokens_reasoning INTEGER,
    tokens_cache_read INTEGER, tokens_cache_write INTEGER
  )`);
  db.prepare('INSERT INTO session_v2 VALUES (?,?,?,?,?,?)')
    .run('ses_one', 100, 10, 1, 1_000, 50);
  const base = snapshotUsage('opencode', { sessionId: 'ses_one', options: { opencodeDb: dbPath } });
  // Before: the snapshot is the row as it was.
  assert.equal(base.row.tokens_input, 100);

  db.prepare('UPDATE session_v2 SET tokens_input=?, tokens_output=?, tokens_reasoning=?, tokens_cache_read=?, tokens_cache_write=? WHERE id=?')
    .run(160, 16, 2, 1_600, 80, 'ses_one');
  db.close();

  const usage = captureUsage({
    agent: 'opencode', sessionId: 'ses_one', base, options: { opencodeDb: dbPath },
  });
  assert.equal(usage.confidence, 'delta');
  assert.equal(usage.input_tokens, 60);
  assert.equal(usage.output_tokens, 6);
  assert.equal(usage.reasoning_tokens, 1);
  assert.equal(usage.cache_read_tokens, 600);
  assert.equal(usage.cache_write_tokens, 30);
});

test('a session the hub just created reports its whole total as the turn', () => {
  const dir = tmp();
  const dbPath = join(dir, 'opencode.db');
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(dbPath);
  db.exec(`CREATE TABLE session_v2 (
    id TEXT PRIMARY KEY,
    tokens_input INTEGER, tokens_output INTEGER, tokens_reasoning INTEGER,
    tokens_cache_read INTEGER, tokens_cache_write INTEGER
  )`);
  // The snapshot runs before the agent has written the row: nothing to subtract.
  const base = snapshotUsage('opencode', { sessionId: 'ses_new', options: { opencodeDb: dbPath } });
  assert.equal(base.row, null);
  db.prepare('INSERT INTO session_v2 VALUES (?,?,?,?,?,?)')
    .run('ses_new', 100, 10, 1, 1_000, 50);
  db.close();

  const usage = captureUsage({
    agent: 'opencode', sessionId: 'ses_new', base, options: { opencodeDb: dbPath },
  });
  assert.equal(usage.confidence, 'session-total');
  assert.equal(usage.input_tokens, 100);
  assert.equal(usage.cache_read_tokens, 1_000);
});

test('a Codex rollout is measured between two cumulative readings, cached split out', () => {
  const dir = tmp();
  const sessionId = 'cccccccc-1111-2222-3333-444444444444';
  const day = join(dir, 'sessions', '2026', '11', '25');
  mkdirSync(day, { recursive: true });
  const file = join(day, `rollout-2026-11-25T10-00-00-${sessionId}.jsonl`);
  const event = (total) => `${JSON.stringify({
    type: 'event_msg',
    payload: { type: 'token_count', info: { total_token_usage: total } },
  })}\n`;

  writeFileSync(file, event({
    input_tokens: 1_000, cached_input_tokens: 800, output_tokens: 50, reasoning_output_tokens: 5,
  }));
  const base = snapshotUsage('codex', { sessionId, options: { codexDir: dir } });
  assert.ok(base.last?.cumulative);

  appendFileSync(file, event({
    input_tokens: 1_600, cached_input_tokens: 1_300, output_tokens: 90, reasoning_output_tokens: 9,
  }));

  const usage = captureUsage({ agent: 'codex', sessionId, base, options: { codexDir: dir } });
  assert.equal(usage.confidence, 'delta');
  assert.equal(usage.source, 'codex-rollout');
  assert.equal(usage.input_tokens, 100, '600 new input minus 500 new cached reads');
  assert.equal(usage.cache_read_tokens, 500);
  assert.equal(usage.output_tokens, 40);
  assert.equal(usage.reasoning_tokens, 4);
});

test('a Codex last_token_usage is the turn itself, never subtracted twice', () => {
  const dir = tmp();
  const sessionId = 'eeeeeeee-1111-2222-3333-444444444444';
  const day = join(dir, 'sessions', '2026', '11', '25');
  mkdirSync(day, { recursive: true });
  const file = join(day, `rollout-2026-11-25T12-00-00-${sessionId}.jsonl`);
  const line = (info) => `${JSON.stringify({
    type: 'event_msg', payload: { type: 'token_count', info },
  })}\n`;

  writeFileSync(file, line({ last_token_usage: {
    input_tokens: 900, cached_input_tokens: 800, output_tokens: 30,
  } }));
  const base = snapshotUsage('codex', { sessionId, options: { codexDir: dir } });
  assert.equal(base.last.cumulative, false);

  const usage = captureUsage({ agent: 'codex', sessionId, base, options: { codexDir: dir } });
  assert.equal(usage.confidence, 'turn');
  assert.equal(usage.input_tokens, 100);
  assert.equal(usage.cache_read_tokens, 800);
  assert.equal(usage.output_tokens, 30);
});

test('the context window comes from the live high-water mark, not the last update', () => {
  assert.deepEqual(contextFromUsage({ used: 120_000, size: 1_000_000 }), {
    context_peak: 120_000,
    context_size: 1_000_000,
  });
  const usage = captureUsage({
    agent: 'opencode',
    sessionId: 'ses_none',
    state: { usage: { used: 10, size: 100 }, contextPeak: 42_000, contextSize: 1_000_000 },
    options: { opencodeDb: join(tmp(), 'missing.db') },
  });
  assert.equal(usage.context_peak, 42_000);
  assert.equal(usage.context_size, 1_000_000);
  assert.equal(usage.confidence, 'unavailable');
});

test('a broken store never throws and never claims numbers', () => {
  const usage = captureUsage({
    agent: 'opencode',
    sessionId: 'ses_x',
    options: { opencodeDb: 'D:\\no\\such\\file\\opencode.db' },
  });
  assert.equal(usage.confidence, 'unavailable');
  assert.deepEqual(Object.keys(emptyUsage('x')).sort(), Object.keys(usage).filter((k) => k !== 'reason' && k !== 'context_peak' && k !== 'context_size').sort());
});
