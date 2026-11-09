import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { acquireTreeLock, lockPathFor, releaseTreeLock, STALE_MS } from '../tree-lock.mjs';

function locksDir() {
  return mkdtempSync(join(tmpdir(), 'tree-lock-'));
}

test('lockPathFor flattens a path into a stable, collision-free filename', () => {
  const a = lockPathFor('/locks', 'D:\\Workspaces\\AgentHub');
  const b = lockPathFor('/locks', '/mnt/d/Workspaces/AgentHub');
  assert.notEqual(a, b, 'the two spellings of the same tree are not unified here -- each caller locks by its own cwd spelling');
  assert.match(a, /AgentHub\.lock$/);
});

test('an unclaimed tree is acquired', () => {
  const dir = locksDir();
  const result = acquireTreeLock(dir, '/repo', { agent: 'opencode', pid: 111, now: 1000 });
  assert.equal(result.ok, true);
  assert.ok(existsSync(result.path));
  assert.deepEqual(JSON.parse(readFileSync(result.path, 'utf8')), {
    agent: 'opencode',
    pid: 111,
    cwd: '/repo',
    startedAt: 1000,
  });
});

test('a second run against the same tree is refused while the first is live', () => {
  const dir = locksDir();
  acquireTreeLock(dir, '/repo', { agent: 'opencode', pid: process.pid, now: Date.now() });
  const second = acquireTreeLock(dir, '/repo', { agent: 'claude', pid: process.pid + 1, now: Date.now() });
  assert.equal(second.ok, false);
  assert.equal(second.holder.agent, 'opencode');
});

test('two different trees never contend', () => {
  const dir = locksDir();
  const a = acquireTreeLock(dir, '/repo-a', { agent: 'opencode', pid: 1, now: 0 });
  const b = acquireTreeLock(dir, '/repo-b', { agent: 'claude', pid: 2, now: 0 });
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
});

test('a lock whose process is dead is treated as stale and reclaimed', () => {
  const dir = locksDir();
  // A pid this high is virtually guaranteed not to exist on this machine.
  acquireTreeLock(dir, '/repo', { agent: 'opencode', pid: 999_999, now: Date.now() });
  const result = acquireTreeLock(dir, '/repo', { agent: 'claude', pid: process.pid, now: Date.now() });
  assert.equal(result.ok, true);
});

test('a lock older than STALE_MS is retained while the pid is alive', () => {
  const dir = locksDir();
  const start = 1_000_000;
  acquireTreeLock(dir, '/repo', { agent: 'opencode', pid: process.pid, now: start });
  const result = acquireTreeLock(dir, '/repo', {
    agent: 'claude',
    pid: process.pid,
    now: start + STALE_MS + 1,
  });
  assert.equal(result.ok, false);
});

test('release only removes the lock if this pid still owns it', () => {
  const dir = locksDir();
  const path = acquireTreeLock(dir, '/repo', { agent: 'opencode', pid: 111, now: 0 }).path;

  releaseTreeLock(dir, '/repo', 222); // not the owner
  assert.ok(existsSync(path), 'a non-owner release must not clear another run\'s lock');

  releaseTreeLock(dir, '/repo', 111);
  assert.ok(!existsSync(path));
});

test('releasing a lock that was never acquired is a no-op', () => {
  const dir = locksDir();
  assert.doesNotThrow(() => releaseTreeLock(dir, '/never-locked', process.pid));
});
