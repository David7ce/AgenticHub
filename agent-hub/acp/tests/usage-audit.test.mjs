// usage-audit.test.mjs — the audit line and --json carry the turn's tokens.
//
// The readers themselves are covered in usage-capture.test.mjs. This file
// proves the wiring: one real hub-acp run, no model, and the store pointed at
// an empty directory so the real transcripts of this machine are never read.
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

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'hub-usage-audit-'));
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
    fake: { enabled: true, overseerAck: true, expires: '2099-01-01T00:00:00Z' },
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
      // Hermetic: an empty store for each agent, so nothing of this machine is read.
      HUB_USAGE_CLAUDE_DIR: empty,
      HUB_USAGE_OPENCODE_DB: join(empty, 'none.db'),
      HUB_USAGE_CODEX_DIR: empty,
    },
  };
}

test('a turn records usage in the audit line and in --json, even with no store', () => {
  const box = sandbox();
  const result = spawnSync(process.execPath, [
    hub, '--agent', 'fake', '--prompt', 'ping', '--permission', 'allow-all',
    '--cwd', box.cwd, '--registry', box.registry, '--json', '--no-save',
  ], { encoding: 'utf8', env: box.env });
  assert.equal(result.status, 0, result.stderr);

  const json = JSON.parse(result.stdout);
  assert.ok(json.tokens, '--json carries the token block');
  assert.equal(json.tokens.confidence, 'unavailable', 'the fake agent has no local store');
  assert.ok(json.tokens.reason, 'an unavailable reading says why');
  assert.equal(json.tokens.input_tokens, 0, 'never a number the store did not report');

  const lines = readFileSync(join(box.dir, 'runs.jsonl'), 'utf8').trim().split('\n');
  const record = JSON.parse(lines.at(-1));
  assert.ok(record.usage, 'the audit line carries the token block');
  assert.equal(record.usage.source, 'fake-usage');
  assert.equal(record.usage.confidence, 'unavailable');
  assert.equal(record.usage.context_peak, null, 'the fixture reports no context window');
});

test('a turn that fails before the prompt still writes a usage block, not null', () => {
  const box = sandbox();
  const result = spawnSync(process.execPath, [
    hub, '--agent', 'fake', '--prompt', 'ping', '--permission', 'allow-all',
    '--cwd', box.cwd, '--registry', box.registry, '--json', '--no-save',
    '--timeout', '1',
  ], { encoding: 'utf8', env: box.env });
  // The timeout path (status 2) or a fast answer (0): either way the line is written.
  assert.ok([0, 2].includes(result.status), result.stderr);
  const lines = readFileSync(join(box.dir, 'runs.jsonl'), 'utf8').trim().split('\n');
  const record = JSON.parse(lines.at(-1));
  assert.ok(record.usage, 'the audit line still carries a token block');
  assert.equal(typeof record.usage.confidence, 'string');
});
