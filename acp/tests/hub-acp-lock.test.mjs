import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { acquireTreeLock } from '../tree-lock.mjs';

// Proves the wiring end to end: a real hub-acp.mjs process, told another
// allow-all run already holds the tree lock, still completes the turn but
// logs the warning instead of silently racing. The fake-agent fixture
// answers instantly, so pre-claiming the lock ourselves (rather than racing
// two real processes) is what makes this deterministic.

const HERE = dirname(fileURLToPath(import.meta.url));
const HUB_ACP = resolve(HERE, '..', 'hub-acp.mjs');
const FIXTURE = resolve(HERE, '..', '..', 'mcp', 'tests', 'fixtures', 'fake-acp-agent.mjs');

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'hub-acp-lock-'));
  const registry = join(dir, 'agents.json');
  const consent = join(dir, 'consent.json');
  const log = join(dir, 'runs.jsonl');
  const locks = join(dir, 'locks');
  const cwd = join(dir, 'tree');
  writeFileSync(
    registry,
    JSON.stringify({ agents: { fake: { label: 'Fake', command: process.execPath, args: [FIXTURE] } } }),
  );
  writeFileSync(
    consent,
    JSON.stringify({ fake: { enabled: true, overseerAck: true, expires: '2099-01-01T00:00:00Z' } }),
  );
  mkdirSync(cwd, { recursive: true });
  return { dir, registry, consent, log, locks, cwd };
}

function runHubAcp(paths, extraArgs = []) {
  const result = spawnSync(
    process.execPath,
    [
      HUB_ACP,
      '--agent', 'fake',
      '--prompt', 'ping',
      '--permission', 'allow-all',
      '--cwd', paths.cwd,
      '--registry', paths.registry,
      '--json',
      '--no-save',
      ...extraArgs,
    ],
    {
      encoding: 'utf8',
      env: { ...process.env, AGENT_HUB_CONSENT: paths.consent, AGENT_HUB_LOG: paths.log, AGENT_HUB_LOCKS: paths.locks },
    },
  );
  return { ...result, json: JSON.parse(result.stdout) };
}

test('an allow-all run against a free tree logs no concurrency warning', () => {
  const paths = sandbox();
  const { status, json } = runHubAcp(paths);
  assert.equal(status, 0);
  assert.equal(json.ok, true);
  const record = JSON.parse(readFileSync(paths.log, 'utf8').trim());
  assert.equal(record.concurrentWrite, null);
});

test('an allow-all run against an already-held tree is rejected', () => {
  const paths = sandbox();
  acquireTreeLock(paths.locks, resolve(paths.cwd), { agent: 'claude', pid: process.pid, now: Date.now() });

  const { status, json, stderr } = runHubAcp(paths);
  assert.equal(status, 1);
  assert.equal(json.ok, false);
  assert.equal(json.status, 'rejected');
  assert.match(stderr, /rejected: claude .* is already writing/);

  const record = JSON.parse(readFileSync(paths.log, 'utf8').trim());
  assert.match(record.concurrentWrite, /claude/);
});

test('allow-reads never touches the lock, even on a held tree', () => {
  const paths = sandbox();
  acquireTreeLock(paths.locks, resolve(paths.cwd), { agent: 'claude', pid: process.pid, now: Date.now() });

  const { status, json, stderr } = runHubAcp(paths, ['--permission', 'allow-reads']);
  assert.equal(status, 0);
  assert.equal(json.ok, true);
  assert.doesNotMatch(stderr, /warning:/);

  const record = JSON.parse(readFileSync(paths.log, 'utf8').trim());
  assert.equal(record.concurrentWrite, null);
});
