// context-limit.test.mjs — the context ceiling cuts a turn like the budget does.
//
// A turn past the ceiling is cancelled, not thrown: the answer may already be
// there, but the audit line has to say why the turn stopped and how big the
// window got. That is what makes "this session is too fat" visible instead of
// showing up as a bigger bill next week.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const hub = resolve(here, '../hub-acp.mjs');
const fixture = resolve(here, '../../mcp/tests/fixtures/fake-acp-agent.mjs');

function sandbox(limits = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'hub-context-limit-'));
  const cwd = join(dir, 'tree');
  const results = join(dir, 'results');
  const empty = join(dir, 'empty-store');
  const registry = join(dir, 'registry.json');
  const consent = join(dir, 'consent.json');
  mkdirSync(cwd, { recursive: true });
  mkdirSync(results, { recursive: true });
  mkdirSync(empty, { recursive: true });
  writeFileSync(registry, JSON.stringify({
    agents: { fake: { command: process.execPath, args: [fixture] } },
  }));
  writeFileSync(consent, JSON.stringify({
    fake: { enabled: true, overseerAck: true, expires: '2099-01-01T00:00:00Z', limits },
  }));
  return {
    dir, cwd, registry,
    env: {
      ...process.env,
      AGENT_HUB_RESULTS: results,
      AGENT_HUB_INFLIGHT: join(results, 'inflight'),
      AGENT_HUB_LOG: join(dir, 'runs.jsonl'),
      AGENT_HUB_LOCKS: join(dir, 'locks'),
      AGENT_HUB_CONSENT: consent,
      HUB_CANCEL_WAIT_MS: '500',
      HUB_USAGE_CLAUDE_DIR: empty,
      HUB_USAGE_OPENCODE_DB: join(empty, 'none.db'),
      HUB_USAGE_CODEX_DIR: empty,
    },
  };
}

function run(box, args) {
  return spawnSync(process.execPath, [
    hub, '--agent', 'fake', '--permission', 'allow-all', '--cwd', box.cwd,
    '--registry', box.registry, '--json', '--no-save', ...args,
  ], { encoding: 'utf8', env: box.env });
}

function lastRecord(box) {
  return JSON.parse(readFileSync(join(box.dir, 'runs.jsonl'), 'utf8').trim().split('\n').at(-1));
}

test('the grant\'s maxContextTokens cuts a turn that reports a bigger window', () => {
  const box = sandbox({ maxContextTokens: 50 });
  const result = run(box, ['--prompt', 'CTX:100:1000 reply anyway']);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /context exceeded \(100 > 50 tokens\)/);

  const json = JSON.parse(result.stdout);
  assert.equal(json.status, 'context');
  assert.equal(json.contextExceeded, true);
  assert.equal(json.contextLimit, 50);
  assert.equal(json.tokens.context_peak, 100);
  assert.equal(json.tokens.context_size, 1_000);

  const record = lastRecord(box);
  assert.equal(record.status, 'context');
  assert.equal(record.contextExceeded, true);
  assert.equal(record.contextLimit, 50);
  assert.equal(record.usage.context_peak, 100, 'the peak is recorded even though the turn was cut');
});

test('a turn under the ceiling is not cut', () => {
  const box = sandbox({ maxContextTokens: 500 });
  const result = run(box, ['--prompt', 'CTX:100:1000 small enough']);
  assert.equal(result.status, 0, result.stderr);
  const json = JSON.parse(result.stdout);
  assert.equal(json.status, 'ok');
  assert.equal(json.contextExceeded, false);
  const record = lastRecord(box);
  assert.equal(record.status, 'ok');
  assert.equal(record.usage.context_peak, 100);
});

test('--max-context can only tighten the grant, never widen it', () => {
  const box = sandbox({ maxContextTokens: 50 });
  const result = run(box, ['--prompt', 'CTX:100:1000 reply anyway', '--max-context', '1000']);
  assert.equal(result.status, 1, result.stderr);
  assert.equal(JSON.parse(result.stdout).contextLimit, 50, 'the grant is the ceiling');
});

test('without a grant limit, --max-context still applies on its own', () => {
  const box = sandbox({});
  const result = run(box, ['--prompt', 'CTX:100:1000 reply anyway', '--max-context', '60']);
  assert.equal(result.status, 1, result.stderr);
  assert.equal(JSON.parse(result.stdout).contextLimit, 60);
});

test('no ceiling anywhere leaves the turn alone', () => {
  const box = sandbox({});
  const result = run(box, ['--prompt', 'CTX:900000:1000000 a big window is fine']);
  assert.equal(result.status, 0, result.stderr);
  const json = JSON.parse(result.stdout);
  assert.equal(json.contextExceeded, false);
  assert.equal(json.contextLimit, null);
});

test('a nonsense --max-context is refused before the agent starts', () => {
  const box = sandbox({});
  const result = run(box, ['--prompt', 'hello', '--max-context', 'many']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--max-context must be a positive number/);
});
