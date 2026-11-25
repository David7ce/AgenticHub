// audit-redaction.test.mjs — no credential reaches a record the hub keeps.
//
// The transcript path is covered elsewhere. This file covers the other three
// surfaces hub-acp writes: the audit line (prompt, output, tool titles, error),
// the saved answer under results/, and the --json document. Every key literal
// here is built by concatenation so the repo's secret scan stays clean.
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

// 24 characters after the prefix: long enough for redact()'s shape, short
// enough that a raw copy in this file would still trip the scanner.
const KEY_BODY = 'Zx9' + 'Qw8' + 'Er7' + 'Ty6' + 'Ui5' + 'Op4' + 'As3' + 'Df2';
const KEY = 's' + 'k-' + KEY_BODY;

// A run's temp registry/consent/tree/results/inflight, so nothing touches the
// real hub state. `command` lets the error test point the agent at a name that
// cannot spawn.
function sandbox({ command = process.execPath, args = [fixture] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'hub-audit-redact-'));
  const cwd = join(dir, 'tree');
  const results = join(dir, 'results');
  const registry = join(dir, 'registry.json');
  const consent = join(dir, 'consent.json');
  mkdirSync(cwd, { recursive: true });
  mkdirSync(results, { recursive: true });
  writeFileSync(registry, JSON.stringify({ agents: { fake: { command, args } } }));
  writeFileSync(consent, JSON.stringify({
    fake: { enabled: true, overseerAck: true, expires: '2099-01-01T00:00:00Z' },
  }));
  return {
    dir, cwd, results, registry, consent,
    env: {
      ...process.env,
      FAKE_TOOL_KEY: '1',
      AGENT_HUB_RESULTS: results,
      AGENT_HUB_INFLIGHT: join(results, 'inflight'),
      AGENT_HUB_LOG: join(dir, 'runs.jsonl'),
      AGENT_HUB_LOCKS: join(dir, 'locks'),
      AGENT_HUB_CONSENT: consent,
      HUB_CANCEL_WAIT_MS: '500',
    },
  };
}

// Ten consecutive characters of the key are a fragment: a redaction that cut
// the key at a cap boundary would leave one. Checking every window is stricter
// than checking the whole key and catches truncated tails.
function assertNoKeyFragment(text, where) {
  const value = String(text ?? '');
  assert.ok(!value.includes(KEY), `${where} contains the whole key`);
  for (let i = 0; i + 10 <= KEY_BODY.length; i += 1) {
    assert.ok(!value.includes(KEY_BODY.slice(i, i + 10)), `${where} contains a key fragment`);
  }
}

function lastRecord(dir) {
  const lines = readFileSync(join(dir, 'runs.jsonl'), 'utf8').trim().split('\n');
  return JSON.parse(lines.at(-1));
}

test('a turn keeps the key out of --json, the audit line, tool titles and the saved answer', () => {
  const box = sandbox();
  const prompt = `Please use ${KEY} carefully`;
  const result = spawnSync(process.execPath, [
    hub, '--agent', 'fake', '--prompt', prompt, '--permission', 'allow-all',
    '--cwd', box.cwd, '--registry', box.registry, '--json',
  ], { encoding: 'utf8', env: box.env });
  assert.equal(result.status, 0, result.stderr);

  // --json: the answer text, and the tool title it reports.
  const json = JSON.parse(result.stdout);
  assert.match(json.text, /\[redacted\]/);
  assertNoKeyFragment(json.text, '--json text');
  assert.ok(json.tools.some((tool) => /\[redacted\]/.test(tool.title)), 'the tool title was redacted');
  for (const tool of json.tools) assertNoKeyFragment(tool.title, `--json tool title ${tool.id}`);
  // --json events are collected per update, so their agent-authored fields are
  // a separate surface from the whole-turn text.
  assert.ok(json.events.length > 0);
  for (const event of json.events) {
    assertNoKeyFragment(event.content?.text, '--json event text');
    assertNoKeyFragment(event.title, '--json event title');
  }

  // The audit line.
  const record = lastRecord(box.dir);
  assert.match(record.prompt, /\[redacted\]/);
  assertNoKeyFragment(record.prompt, 'audit prompt');
  assert.match(record.output, /\[redacted\]/);
  assertNoKeyFragment(record.output, 'audit output');
  assert.ok(record.tools.length >= 1, 'the tool call reached the audit line');
  for (const tool of record.tools) {
    assert.match(tool.title, /\[redacted\]/);
    assertNoKeyFragment(tool.title, `audit tool title ${tool.id}`);
  }

  // The saved answer.
  assert.ok(json.savedTo, 'the run saved its answer');
  const saved = readFileSync(json.savedTo, 'utf8');
  assert.match(saved, /\[redacted\]/);
  assertNoKeyFragment(saved, 'saved answer');
});

test('text chunks stay out of --json events, so a split key cannot survive', () => {
  // FAKE_SPLIT_TOKEN streams the answer as two chunks with a key straddling the
  // boundary: redacting each update on its own leaves the tail unmatched, so
  // the only safe --json events stream is one without text chunks at all.
  const box = sandbox();
  const result = spawnSync(process.execPath, [
    hub, '--agent', 'fake', '--prompt', 'ping', '--permission', 'allow-all',
    '--cwd', box.cwd, '--registry', box.registry, '--json', '--no-save',
  ], {
    encoding: 'utf8',
    env: { ...box.env, FAKE_TOOL_KEY: '', FAKE_SPLIT_TOKEN: '1' },
  });
  assert.equal(result.status, 0, result.stderr);

  const json = JSON.parse(result.stdout);
  assert.match(json.text, /\[redacted\]/);
  assert.ok(!result.stdout.includes('s' + 'k-'), 'the key prefix survives somewhere in --json');
  assert.ok(!result.stdout.includes('Q'.repeat(10)), 'a fragment of the key body survives in --json');
  assert.ok(!result.stdout.includes('R'.repeat(10)), 'a fragment of the key tail survives in --json');
  assert.ok(
    !json.events.some((event) => event?.sessionUpdate === 'agent_message_chunk'),
    'the answer belongs in text, not in events',
  );
  assert.ok(
    !json.events.some((event) => event?.sessionUpdate === 'agent_thought_chunk'),
    'thought chunks stay out of events too',
  );
});

test('a rejected over-long prompt keeps the key out of its audit line', () => {
  const box = sandbox();
  const result = spawnSync(process.execPath, [
    hub, '--agent', 'fake', '--prompt', `Please use ${KEY} ` + 'x'.repeat(50),
    '--max-prompt-chars', '10', '--permission', 'allow-all', '--cwd', box.cwd,
    '--registry', box.registry, '--json', '--no-save',
  ], { encoding: 'utf8', env: box.env });
  assert.equal(result.status, 1, result.stderr);
  const record = lastRecord(box.dir);
  assert.match(record.prompt, /\[redacted\]/);
  assertNoKeyFragment(record.prompt, 'rejected prompt');
});

test('a failure message keeps the key out of the audit line and --json', () => {
  // The agent command is the key-shaped value: a spawn failure reports it back
  // in the error message, which is exactly the path that used to write raw.
  const box = sandbox({ command: KEY });
  const result = spawnSync(process.execPath, [
    hub, '--agent', 'fake', '--prompt', 'ping', '--permission', 'allow-all',
    '--cwd', box.cwd, '--registry', box.registry, '--json', '--no-save',
  ], { encoding: 'utf8', env: box.env });
  assert.equal(result.status, 1, result.stderr);

  const json = JSON.parse(result.stdout);
  assert.ok(json.error, 'the run reported an error');
  assert.match(json.error, /\[redacted\]/);
  assertNoKeyFragment(json.error, '--json error');

  const record = lastRecord(box.dir);
  assert.ok(record.error, 'the audit line recorded the error');
  assert.match(record.error, /\[redacted\]/);
  assertNoKeyFragment(record.error, 'audit error');
});
