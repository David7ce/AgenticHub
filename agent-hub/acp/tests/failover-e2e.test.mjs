import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// End-to-end failover with no model and no login: the real router, the real
// hub-acp.mjs, and a fake ACP agent at the bottom. The first agent answers
// every prompt with a quota error; the registry's agentFallbacks hand the task
// to the second one, and with --cwd it must arrive with the tree's context.

const HERE = dirname(fileURLToPath(import.meta.url));
const ROUTER = resolve(HERE, '..', 'router.mjs');
const FIXTURE = resolve(HERE, '..', '..', 'mcp', 'tests', 'fixtures', 'fake-acp-agent.mjs');

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'hub-failover-'));
  const repo = join(dir, 'repo');
  mkdirSync(repo);
  spawnSync('git', ['init', '-q'], { cwd: repo });
  writeFileSync(join(repo, 'a.txt'), 'x');
  const agent = (model, extra = {}) => ({
    label: model, command: process.execPath, args: [FIXTURE], defaultConfig: { model }, ...extra,
  });
  writeFileSync(join(dir, 'agents.json'), JSON.stringify({
    agents: {
      opencode: agent('fake/model-1', { agentFallbacks: ['codex', 'claude'] }),
      codex: agent('fake/paid-model'),
      claude: agent('fake/paid-model'),
    },
  }));
  const grant = { enabled: true, overseerAck: true, expires: '2099-01-01T00:00:00Z' };
  writeFileSync(join(dir, 'consent.json'), JSON.stringify({ opencode: grant, codex: grant, claude: grant }));
  const env = {
    ...process.env,
    AGENT_HUB_REGISTRY: join(dir, 'agents.json'),
    AGENT_HUB_CONSENT: join(dir, 'consent.json'),
    AGENT_HUB_LOG: join(dir, 'runs.jsonl'),
    AGENT_HUB_INFLIGHT: join(dir, 'inflight'),
    AGENT_HUB_LOCKS: join(dir, 'locks'),
    AGENT_HUB_RESULTS: join(dir, 'results'),
  };
  return { dir, repo, env };
}

function route(box, prompt, extra = []) {
  return spawnSync(
    process.execPath,
    [ROUTER, '--force', 'opencode', '--permission', 'allow-all', '--log', join(box.dir, 'runs.jsonl'), '--prompt', prompt, '--cwd', box.repo, '--registry', join(box.dir, 'agents.json'), ...extra],
    { env: box.env, encoding: 'utf8', timeout: 90_000 },
  );
}

test('a quota failure hands the task to the next agent, with the tree context', () => {
  const box = sandbox();
  const result = route(box, 'QUOTA:model-1 please add a unit test');
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.match(result.stderr, /opencode is out of quota; retrying on codex/);
  assert.ok(result.stdout.includes('[model=fake/paid-model]'), 'the second agent answered');
  assert.match(result.stdout, /You are codex/, 'it received the handoff prompt');
  assert.match(result.stdout, /Task to carry out/);
  assert.match(result.stdout, /please add a unit test/, 'and the original task');
});

test('--no-context sends the bare prompt to the fallback agent', () => {
  const box = sandbox();
  const result = route(box, 'QUOTA:model-1 please add a unit test', ['--no-context']);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.ok(result.stdout.includes('[model=fake/paid-model]'));
  assert.doesNotMatch(result.stdout, /You are codex/);
});

test('--no-failover leaves the quota error alone', () => {
  const box = sandbox();
  const result = route(box, 'QUOTA:model-1 please add a unit test', ['--no-failover']);
  assert.notEqual(result.status, 0);
  assert.ok(!result.stdout.includes('[model=fake/paid-model]'));
});

test('every attempt is audited', () => {
  const box = sandbox();
  route(box, 'QUOTA:model-1 please add a unit test');
  const lines = readFileSync(join(box.dir, 'runs.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((l) => l.agent), ['opencode', 'codex']);
  assert.notEqual(lines[0].status, 'ok');
  assert.equal(lines[1].status, 'ok');
});
