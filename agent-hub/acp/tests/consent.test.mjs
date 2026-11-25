import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { checkLimits, isInside, normalizeTree, PERMISSION_RANK, permissionSafetyReason, spentToday, testConsent } from '../consent.mjs';
import { rotateIfNeeded } from '../log-rotation.mjs';
// Spawned hub-acp runs write transcripts under the results dir: keep them out of the real one.
process.env.AGENT_HUB_RESULTS = mkdtempSync(join(tmpdir(), 'hub-results-'));

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

test('isInside does not follow a link out of the tree: a junction inside it is not inside', () => {
  const root = mkdtempSync(join(tmpdir(), 'tree-'));
  const outside = mkdtempSync(join(tmpdir(), 'outside-'));
  const inside = join(root, 'pkg');
  mkdirSync(inside, { recursive: true });
  writeFileSync(join(outside, 'secret.txt'), 'x');
  const link = join(root, 'escape');
  symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(isInside(inside, root), true, 'a real child is inside');
  assert.equal(isInside(link, root), false, 'the link itself resolves outside');
  assert.equal(isInside(join(link, 'secret.txt'), root), false, 'and so does anything behind it');
  assert.equal(isInside(inside, link), false, 'the outside tree is not the parent of a real child');
  assert.equal(isInside(join(root, 'nuevo', 'sub'), root), true, 'a path that does not exist yet stays inside');
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
  const limits = { writeTrees: ['D:/Work/repo'] };
  assert.equal(checkLimits(limits, { permission: 'allow-all', cwd: 'D:/Work/repo/app' }, win).ok, true);
  const outside = checkLimits(limits, { permission: 'allow-all', cwd: 'D:/Work/other' }, win);
  assert.equal(outside.ok, false);
  assert.match(outside.reason, /not under limits.writeTrees/);
  assert.equal(checkLimits(limits, { permission: 'deny', cwd: 'D:/Work/other' }, win).ok, true);
  assert.equal(checkLimits(limits, { permission: 'allow-all', cwd: 'C:/Temp/hub-bench-1' }, win).ok, true);
  assert.equal(checkLimits({ writeTrees: [] }, { permission: 'allow-all', cwd: 'D:/Work/repo' }, win).ok, false);
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
  assert.equal(allowed.status, 1, allowed.stderr);
  assert.match(JSON.parse(allowed.stdout).error, /Restricted permissions cannot be enforced/);
});

test('restricted policies fail closed before an agent is spawned', () => {
  const dir = mkdtempSync(join(tmpdir(), 'claude-permission-'));
  const registry = join(dir, 'agents.json');
  const consent = join(dir, 'consent.json');
  const log = join(dir, 'runs.jsonl');
  const marker = join(dir, 'spawned');
  const fixture = join(dir, 'would-spawn.mjs');
  writeFileSync(fixture, `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'spawned');`);
  writeFileSync(registry, JSON.stringify({ agents: { claude: { command: process.execPath, args: [fixture] } } }));
  writeFileSync(consent, JSON.stringify({ claude: { enabled: true, overseerAck: true, expires: '2099-01-01T00:00:00Z' } }));
  for (const permission of ['deny', 'allow-reads']) {
    const result = spawnSync(process.execPath,
      [HUB_ACP, '--agent', 'claude', '--prompt', 'ping', '--permission', permission,
        '--cwd', dir, '--registry', registry, '--json', '--no-save'],
      { encoding: 'utf8', env: { ...process.env, AGENT_HUB_CONSENT: consent, AGENT_HUB_LOG: log } });
    assert.equal(result.status, 1, result.stderr);
    const body = JSON.parse(result.stdout);
    assert.equal(body.status, 'rejected');
    assert.match(body.error, /cannot be enforced/i);
    assert.equal(existsSync(marker), false, 'adapter must not be started');
  }
  const records = readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(records.map((record) => record.status), ['rejected', 'rejected']);

  // A custom registry name must not bypass the guard when it references the
  // Claude ACP adapter package.
  writeFileSync(registry, JSON.stringify({ agents: {
    alias: { command: process.execPath, args: [fixture, '@agentclientprotocol/claude-agent-acp@0.101.0'] },
  } }));
  writeFileSync(consent, JSON.stringify({ alias: { enabled: true, overseerAck: true, expires: '2099-01-01T00:00:00Z' } }));
  const alias = spawnSync(process.execPath,
    [HUB_ACP, '--agent', 'alias', '--prompt', 'ping', '--permission', 'allow-reads',
      '--cwd', dir, '--registry', registry, '--json', '--no-save'],
    { encoding: 'utf8', env: { ...process.env, AGENT_HUB_CONSENT: consent, AGENT_HUB_LOG: log } });
  assert.equal(JSON.parse(alias.stdout).status, 'rejected');
  assert.equal(existsSync(marker), false);
});

test('Claude allow-all remains subject to the existing grant', () => {
  const dir = mkdtempSync(join(tmpdir(), 'claude-allow-all-'));
  const registry = join(dir, 'agents.json');
  const consent = join(dir, 'consent.json');
  writeFileSync(registry, JSON.stringify({ agents: { claude: { command: process.execPath, args: [FIXTURE] } } }));
  const run = () => spawnSync(process.execPath,
    [HUB_ACP, '--agent', 'claude', '--prompt', 'ping', '--permission', 'allow-all',
      '--cwd', dir, '--registry', registry, '--json', '--no-save'],
    { encoding: 'utf8', timeout: 30000, env: { ...process.env, AGENT_HUB_CONSENT: consent,
      AGENT_HUB_LOG: join(dir, 'runs.jsonl'), AGENT_HUB_LOCKS: join(dir, 'locks') } });
  writeFileSync(consent, JSON.stringify({ claude: { enabled: false } }));
  assert.equal(JSON.parse(run().stdout).status, 'denied');
  writeFileSync(consent, JSON.stringify({ claude: { enabled: true, overseerAck: true, expires: '2099-01-01T00:00:00Z' } }));
  assert.equal(JSON.parse(run().stdout).status, 'ok');
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

test('maxDailyTokens denies once the day\'s tokens reach the cap, and ignores dollars', () => {
  const limits = { maxDailyTokens: 1_000_000 };
  assert.equal(checkLimits(limits, { spentTokensToday: 999_999 }, win).ok, true);
  const atCap = checkLimits(limits, { spentTokensToday: 1_000_000 }, win);
  assert.equal(atCap.ok, false);
  assert.match(atCap.reason, /daily token cap reached/);
  // No token figure in the request means nothing counted yet, never a denial.
  assert.equal(checkLimits(limits, {}, win).ok, true);
});

test('maxContextTokens reaches the caller as a ceiling, and a bad value fails closed', () => {
  assert.equal(checkLimits({ maxContextTokens: 150_000 }, {}, win).contextLimit, 150_000);
  assert.equal(checkLimits({ maxContextTokens: 1_500.9 }, {}, win).contextLimit, 1_500, 'whole tokens');
  assert.equal(checkLimits({ maxContextTokens: 0 }, {}, win).ok, false, 'zero is a typo, not "off"');
  assert.equal(checkLimits({ maxContextTokens: -5 }, {}, win).ok, false);
  assert.equal(checkLimits({ maxContextTokens: 'lots' }, {}, win).ok, false);
  assert.equal(checkLimits({ maxPermission: 'deny' }, {}, win).contextLimit, undefined, 'absent means no ceiling');
});

test('a budget of 0 (or one that is not a number) cannot switch a capped grant\'s watchdog off', () => {
  const limits = { maxBudgetUsd: 0.5 };
  assert.equal(checkLimits(limits, { budget: 0 }, win).budget, 0.5);
  assert.equal(checkLimits(limits, { budget: NaN }, win).budget, 0.5);
  assert.equal(checkLimits(limits, { budget: -1 }, win).budget, 0.5);
  assert.equal(checkLimits({ maxDailyUsd: 5 }, { budget: 0, spentToday: 4.2 }, win).budget, 0.8);
  // No cap in the grant: the caller's choice stands, as before.
  assert.equal(checkLimits({ maxPermission: 'deny' }, { budget: 0 }, win).budget, undefined);
});

test('an "expires" that is not a date denies instead of never expiring', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'hub-consent-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'consent.json');
  writeFileSync(file, JSON.stringify({
    typo: { enabled: true, overseerAck: true, expires: '2027-13-45' },
    words: { enabled: true, overseerAck: true, expires: 'next week' },
    fine: { enabled: true, overseerAck: true, expires: '2099-01-01T00:00:00Z' },
    open: { enabled: true, overseerAck: true },
  }));
  assert.match(testConsent('typo', file).reason, /not a date/);
  assert.match(testConsent('words', file).reason, /not a date/);
  assert.equal(testConsent('fine', file).ok, true);
  assert.equal(testConsent('open', file).ok, true);
});

test('spentToday still counts what was spent before the log rotated today', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'consent-rotated-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const log = join(dir, 'runs.jsonl');
  const now = new Date();
  const line = (agent, amount, time = now) => JSON.stringify({ time: time.toISOString(), agent, status: 'ok', cost: { amount } });

  writeFileSync(log, [line('a', 2), line('a', 9, new Date(now.getTime() - 2 * 86_400_000)), line('b', 7)].join('\n') + '\n');
  assert.ok(rotateIfNeeded(log, { maxBytes: 1, now }), 'the log rotates');
  writeFileSync(log, line('a', 0.5) + '\n');
  // An unrelated file with the same prefix shape is not a run log of this agent's day.
  writeFileSync(join(dir, 'runs-notes.txt'), line('a', 100));

  assert.equal(spentToday('a', log, now), 2.5, 'today, both sides of the rotation; not the old day, not agent b');
  assert.equal(spentToday('a', join(dir, 'missing.jsonl'), now), 0);
});

test('ask is write-capable but a distinct cap: above allow-reads, below allow-all', () => {
  assert.ok(PERMISSION_RANK.ask > PERMISSION_RANK['allow-reads'], 'ask must rank above read-only');
  assert.ok(PERMISSION_RANK.ask < PERMISSION_RANK['allow-all'], 'ask must not rank with full write access');
  assert.equal(permissionSafetyReason('ask', { name: 'claude' }), null);
  assert.match(permissionSafetyReason('allow-reads', { name: 'claude' }), /cannot be enforced/);
});

test('a grant capped at ask accepts ask and refuses allow-all', () => {
  const supervised = { maxPermission: 'ask' };
  assert.equal(checkLimits(supervised, { permission: 'ask' }, win).ok, true);
  const denied = checkLimits(supervised, { permission: 'allow-all' }, win);
  assert.equal(denied.ok, false);
  assert.match(denied.reason, /permission allow-all exceeds the grant \(max ask\)/);
  // Full write access admits both.
  assert.equal(checkLimits({ maxPermission: 'allow-all' }, { permission: 'ask' }, win).ok, true);
  assert.equal(checkLimits({ maxPermission: 'allow-all' }, { permission: 'allow-all' }, win).ok, true);
});

test('maxPermission allow-reads bounds ask like allow-all', () => {
  const readOnly = { maxPermission: 'allow-reads' };
  const denied = checkLimits(readOnly, { permission: 'ask' }, win);
  assert.equal(denied.ok, false);
  assert.match(denied.reason, /permission ask exceeds the grant/);
});

test('writeTrees bounds ask, not only allow-all', () => {
  const limits = { writeTrees: ['D:/Work/repo'] };
  assert.equal(checkLimits(limits, { permission: 'ask', cwd: 'D:/Work/repo/app' }, win).ok, true);
  const outside = checkLimits(limits, { permission: 'ask', cwd: 'D:/Work/other' }, win);
  assert.equal(outside.ok, false);
  assert.match(outside.reason, /not under limits.writeTrees/);
});
