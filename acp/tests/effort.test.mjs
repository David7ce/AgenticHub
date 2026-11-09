import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { EFFORT_LEVELS, effortConfig } from '../effort.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const HUB_ACP = resolve(HERE, '..', 'hub-acp.mjs');
const FIXTURE = resolve(HERE, '..', '..', 'mcp', 'tests', 'fixtures', 'fake-acp-agent.mjs');
const LOCAL = resolve(HERE, '..', 'agents.json');
const REGISTRY = existsSync(LOCAL) ? LOCAL : resolve(HERE, '..', 'agents.example.json');

test('effortConfig maps a level to the agent\'s own option', () => {
  const opencode = { option: 'effort', values: { low: 'low', medium: 'default', high: 'high', max: 'max' } };
  assert.equal(effortConfig(opencode, 'low'), 'effort=low');
  assert.equal(effortConfig(opencode, 'medium'), 'effort=default');
  const codex = { option: 'reasoning_effort', values: { low: 'low', medium: 'medium', high: 'high', max: 'max' } };
  assert.equal(effortConfig(codex, 'high'), 'reasoning_effort=high');
});

test('effortConfig returns null for an agent without an effort option, and rejects bad levels', () => {
  assert.equal(effortConfig(undefined, 'low'), null);
  assert.equal(effortConfig({ option: 'effort', values: { low: 'low' } }, 'max'), null);
  assert.throws(() => effortConfig({ option: 'x', values: {} }, 'turbo'), /unknown effort/);
  assert.deepEqual(EFFORT_LEVELS, ['low', 'medium', 'high', 'max']);
});

test('the shipped registry maps every level for opencode and codex', () => {
  const agents = JSON.parse(readFileSync(REGISTRY, 'utf8')).agents;
  for (const name of ['opencode', 'codex']) {
    for (const level of EFFORT_LEVELS) {
      assert.ok(effortConfig(agents[name].effort, level), `${name} ${level}`);
    }
  }
  assert.equal(effortConfig(agents.opencode.effort, 'low'), 'effort=low');
  assert.equal(effortConfig(agents.codex.effort, 'low'), 'reasoning_effort=low');
});

function run(effortEntry, effort) {
  const dir = mkdtempSync(join(tmpdir(), 'hub-effort-'));
  const registry = join(dir, 'agents.json');
  const consent = join(dir, 'consent.json');
  const log = join(dir, 'runs.jsonl');
  const cwd = join(dir, 'tree');
  mkdirSync(cwd);
  const fake = { label: 'Fake', command: process.execPath, args: [FIXTURE] };
  if (effortEntry) fake.effort = effortEntry;
  writeFileSync(registry, JSON.stringify({ agents: { fake } }));
  writeFileSync(consent, JSON.stringify({ fake: { enabled: true, overseerAck: true, expires: '2099-01-01T00:00:00Z' } }));
  const result = spawnSync(
    process.execPath,
    [HUB_ACP, '--agent', 'fake', '--prompt', 'ping', '--cwd', cwd, '--registry', registry, '--json', '--no-save', '--effort', effort],
    { encoding: 'utf8', env: { ...process.env, AGENT_HUB_CONSENT: consent, AGENT_HUB_LOG: log, AGENT_HUB_LOCKS: join(dir, 'locks') } },
  );
  const record = JSON.parse(readFileSync(log, 'utf8').trim().split('\n').at(-1));
  return { ...result, record };
}

test('hub-acp records the effort and warns when the agent has no effort option', () => {
  const { status, stderr, record } = run(null, 'low');
  assert.equal(status, 0, stderr);
  assert.match(stderr, /declares no effort option; --effort low ignored/);
  assert.equal(record.effort, 'low');
});

test('hub-acp turns --effort into the agent\'s config option', () => {
  // The fake agent accepts any set_config_option; the call must succeed and be recorded.
  const { status, stderr, record } = run({ option: 'effort', values: { low: 'low' } }, 'low');
  assert.equal(status, 0, stderr);
  assert.doesNotMatch(stderr, /ignored/);
  assert.equal(record.effort, 'low');
});

test('hub-acp rejects an unknown effort level before spawning', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hub-effort-bad-'));
  const result = spawnSync(
    process.execPath,
    [HUB_ACP, '--agent', 'opencode', '--prompt', 'x', '--effort', 'turbo', '--json', '--no-save'],
    { encoding: 'utf8', env: { ...process.env, AGENT_HUB_LOG: join(dir, 'runs.jsonl') } },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unknown effort "turbo"/);
});
