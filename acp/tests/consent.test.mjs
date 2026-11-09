import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { checkLimits, isInside, normalizeTree, spentToday, testConsent } from '../consent.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const HUB_ACP = resolve(HERE, '..', 'hub-acp.mjs');
const FIXTURE = resolve(HERE, '..', '..', 'mcp', 'tests', 'fixtures', 'fake-acp-agent.mjs');

const SCRATCH = 'C:/Temp';
const win = { scratch: SCRATCH, platform: 'win32' };

test('normalizeTree folds case and separators on Windows', () => {
  assert.equal(normalizeTree('D:\\Work\\Repo\\', 'win32'), normalizeTree('d:/work/repo', 'win32'));
});

test('isInside accepts the tree and its children, not siblings with a shared prefix', () => {
  assert.equal(isInside('D:/Work/repo', 'D:/Work/repo', 'win32'), true);
  assert.equal(isInside('D:/Work/repo/.git/agent-worktrees/x', 'd:\\work\\repo', 'win32'), true);
  assert.equal(isInside('D:/Work/repo-other', 'D:/Work/repo', 'win32'), false);
});

test('a grant without limits keeps the old behaviour', () => {
  assert.deepEqual(checkLimits(undefined, { permission: 'allow-all', cwd: 'D:/x', budget: 9 }, win), { ok: true });
});

test('maxPermission rejects a stronger request and accepts an equal or weaker one', () => {
  const limits = { maxPermission: 'allow-reads' };
  assert.equal(checkLimits(limits, { permission: 'allow-all' }, win).ok, false);
  assert.equal(checkLimits(limits, { permission: 'allow-reads' }, win).ok, true);
  assert.equal(checkLimits(limits, { permission: 'deny' }, win).ok, true);
  assert.equal(checkLimits({ maxPermission: 'root' }, { permission: 'deny' }, win).ok, false);
});

test('writeTrees bounds allow-all only, and always allows the scratch dir', () => {
  const limits = { writeTrees: ['D:/Work/pkg-lab'] };
  assert.equal(checkLimits(limits, { permission: 'allow-all', cwd: 'D:/Work/pkg-lab/app' }, win).ok, true);
  const outside = checkLimits(limits, { permission: 'allow-all', cwd: 'D:/Work/other' }, win);
  assert.equal(outside.ok, false);
  assert.match(outside.reason, /not under limits.writeTrees/);
  assert.equal(checkLimits(limits, { permission: 'deny', cwd: 'D:/Work/other' }, win).ok, true);
  assert.equal(checkLimits(limits, { permission: 'allow-all', cwd: 'C:/Temp/hub-bench-1' }, win).ok, true);
  assert.equal(checkLimits({ writeTrees: [] }, { permission: 'allow-all', cwd: 'D:/Work/pkg-lab' }, win).ok, false);
});

test('maxBudgetUsd clamps a larger or missing budget and leaves a smaller one alone', () => {
  const limits = { maxBudgetUsd: 0.5 };
  const clamped = checkLimits(limits, { budget: 3 }, win);
  assert.equal(clamped.ok, true);
  assert.equal(clamped.budget, 0.5);
  assert.match(clamped.note, /clamped/);
  assert.equal(checkLimits(limits, {}, win).budget, 0.5);
  assert.equal(checkLimits(limits, { budget: 0.2 }, win).budget, undefined);
});

test('testConsent applies limits only when a request is given', () => {
  const dir = mkdtempSync(join(tmpdir(), 'consent-unit-'));
  const path = join(dir, 'consent.json');
  writeFileSync(path, JSON.stringify({
    a: { enabled: true, overseerAck: true, expires: '2099-01-01T00:00:00Z', limits: { maxPermission: 'deny' } },
  }));
  assert.equal(testConsent('a', path).ok, true);
  assert.equal(testConsent('a', path, { permission: 'allow-all' }).ok, false);
});

test('hub-acp denies a run that exceeds the grant and logs the reason', () => {
  const dir = mkdtempSync(join(tmpdir(), 'consent-e2e-'));
  const registry = join(dir, 'agents.json');
  const consent = join(dir, 'consent.json');
  const log = join(dir, 'runs.jsonl');
  const cwd = join(dir, 'tree');
  mkdirSync(cwd);
  writeFileSync(registry, JSON.stringify({ agents: { fake: { label: 'Fake', command: process.execPath, args: [FIXTURE] } } }));
  writeFileSync(consent, JSON.stringify({
    fake: { enabled: true, overseerAck: true, expires: '2099-01-01T00:00:00Z', limits: { maxPermission: 'allow-reads' } },
  }));
  const run = (permission) => spawnSync(
    process.execPath,
    [HUB_ACP, '--agent', 'fake', '--prompt', 'ping', '--permission', permission, '--cwd', cwd,
      '--registry', registry, '--json', '--no-save'],
    { encoding: 'utf8', env: { ...process.env, AGENT_HUB_CONSENT: consent, AGENT_HUB_LOG: log, AGENT_HUB_LOCKS: join(dir, 'locks') } },
  );

  const denied = run('allow-all');
  assert.equal(denied.status, 1);
  assert.equal(JSON.parse(denied.stdout).status, 'denied');
  const record = JSON.parse(readFileSync(log, 'utf8').trim().split('\n').at(-1));
  assert.equal(record.status, 'denied');
  assert.match(record.reason, /exceeds the grant/);

  const allowed = run('allow-reads');
  assert.equal(allowed.status, 0, allowed.stderr);
});

test('maxDailyUsd denies at the cap and clamps the budget to what is left', () => {
  const limits = { maxBudgetUsd: 2, maxDailyUsd: 5 };
  const atCap = checkLimits(limits, { budget: 2, spentToday: 5 }, win);
  assert.equal(atCap.ok, false);
  assert.match(atCap.reason, /daily cap reached/);
  const nearCap = checkLimits(limits, { budget: 2, spentToday: 4.2 }, win);
  assert.equal(nearCap.ok, true);
  assert.equal(nearCap.budget, 0.8);
  assert.match(nearCap.note, /left of today/);
  assert.equal(checkLimits(limits, { budget: 3, spentToday: 0 }, win).budget, 2);
  assert.equal(checkLimits(limits, { budget: 1, spentToday: 0 }, win).budget, undefined);
});

test('spentToday sums this agent\'s reported cost on the local day only', () => {
  const dir = mkdtempSync(join(tmpdir(), 'consent-spent-'));
  const log = join(dir, 'runs.jsonl');
  const now = new Date();
  const yesterday = new Date(now.getTime() - 86_400_000);
  writeFileSync(log, [
    JSON.stringify({ time: now.toISOString(), agent: 'a', status: 'ok', cost: { amount: 1.25 } }),
    JSON.stringify({ time: now.toISOString(), agent: 'a', status: 'ok', cost: 0.5 }),
    JSON.stringify({ time: now.toISOString(), agent: 'b', status: 'ok', cost: { amount: 9 } }),
    JSON.stringify({ time: yesterday.toISOString(), agent: 'a', status: 'ok', cost: { amount: 9 } }),
    'not json "agent":"a"',
  ].join('\n'));
  assert.equal(spentToday('a', log, now), 1.75);
  assert.equal(spentToday('a', join(dir, 'missing.jsonl'), now), 0);
});
