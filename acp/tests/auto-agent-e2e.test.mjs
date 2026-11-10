import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// --agent auto end to end with no model and no login: the real hub-acp, the
// real consent gate and a fake ACP agent. The pick must follow the router's
// rules, reach the chosen agent, and leave exactly one audit line for it.

const HERE = dirname(fileURLToPath(import.meta.url));
const HUB_ACP = resolve(HERE, '..', 'hub-acp.mjs');
const FIXTURE = resolve(HERE, '..', '..', 'mcp', 'tests', 'fixtures', 'fake-acp-agent.mjs');

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'hub-auto-'));
  const repo = join(dir, 'repo');
  mkdirSync(repo);
  spawnSync('git', ['init', '-q'], { cwd: repo });
  writeFileSync(join(repo, 'a.txt'), 'x');
  const agent = (model) => ({
    label: model, command: process.execPath, args: [FIXTURE], defaultConfig: { model },
  });
  const registry = join(dir, 'agents.json');
  writeFileSync(registry, JSON.stringify({ agents: {
    opencode: agent('fake/cheap'),
    claude: agent('fake/strong'),
  } }));
  const grant = { enabled: true, overseerAck: true, expires: '2099-01-01T00:00:00Z' };
  writeFileSync(join(dir, 'consent.json'), JSON.stringify({ opencode: grant, claude: grant }));
  const env = {
    ...process.env,
    AGENT_HUB_CONSENT: join(dir, 'consent.json'),
    AGENT_HUB_LOG: join(dir, 'runs.jsonl'),
    AGENT_HUB_INFLIGHT: join(dir, 'inflight'),
    AGENT_HUB_LOCKS: join(dir, 'locks'),
    AGENT_HUB_RESULTS: join(dir, 'results'),
  };
  return { dir, repo, registry, env };
}

function runAuto(box, prompt) {
  return spawnSync(
    process.execPath,
    [HUB_ACP, '--agent', 'auto', '--prompt', prompt, '--cwd', box.repo, '--registry', box.registry],
    { env: box.env, encoding: 'utf8', timeout: 90_000 },
  );
}

function audit(box) {
  return readFileSync(join(box.dir, 'runs.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
}

test('auto sends an ordinary edit to the cheap agent and audits it', () => {
  const box = sandbox();
  const result = runAuto(box, 'fix the typo in a.txt');
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.match(result.stderr, /auto -> opencode/);
  assert.ok(result.stdout.includes('[model=fake/cheap]'), result.stdout);
  assert.deepEqual(audit(box).map((line) => line.agent), ['opencode']);
});

test('auto escalates a scope signal to the strong agent', () => {
  const box = sandbox();
  const result = runAuto(box, 'migrate several files to the new API');
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.match(result.stderr, /auto -> claude/);
  assert.ok(result.stdout.includes('[model=fake/strong]'), result.stdout);
  assert.deepEqual(audit(box).map((line) => line.agent), ['claude']);
});
