import test from 'node:test';
import assert from 'node:assert/strict';

import { ageLabel, planPrune } from '../hubctl.mjs';

const rows = [
  { path: '/w/clean-a', dirty: false },
  { path: '/w/dirty-b', dirty: true },
  { path: '/w/clean-c', dirty: false },
];

test('prune removes the clean worktrees and keeps the dirty ones', () => {
  const plan = planPrune(rows);
  assert.deepEqual(plan.remove.map((r) => r.path), ['/w/clean-a', '/w/clean-c']);
  assert.deepEqual(plan.keep.map((r) => r.path), ['/w/dirty-b']);
});

test('--force discards work, so only then are dirty trees removed', () => {
  const plan = planPrune(rows, { force: true });
  assert.equal(plan.remove.length, 3);
  assert.deepEqual(plan.keep, []);
});

test('an empty list plans nothing', () => {
  assert.deepEqual(planPrune([]), { remove: [], keep: [] });
});

test('ages read as days, hours, or unknown', () => {
  assert.equal(ageLabel(3.2), '3d');
  assert.equal(ageLabel(0.5), '12h');
  assert.equal(ageLabel(0.01), '1h');
  assert.equal(ageLabel(null), '?');
});

import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { agentWorktrees, repoRoots } from '../commands/worktree.mjs';

const norm = (p) => p.split(String.fromCharCode(92)).join('/').toLowerCase();
const git = (cwd, ...args) => spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
function repoWithAgentWorktree() {
  const repo = mkdtempSync(join(tmpdir(), 'wt-repo-'));
  git(repo, 'init', '-q');
  git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init');
  const path = join(repo, '.git', 'agent-worktrees', 'run1-codex');
  mkdirSync(join(repo, '.git', 'agent-worktrees'), { recursive: true });
  const added = git(repo, 'worktree', 'add', '-q', '--detach', path);
  assert.equal(added.status, 0, added.stderr);
  return { repo, path };
}

test('repoRoots adds every --repo to the hub repo, once', () => {
  const roots = repoRoots(['--repo', '/a', '--json', '--repo', '/a', '--repo', '/b'], '/hub');
  assert.equal(roots.length, 3);
  assert.equal(roots[0], '/hub');
  assert.deepEqual(repoRoots(['--repo'], '/hub'), ['/hub']); // a dangling flag names nothing
});

test('agentWorktrees finds the worktrees of other repositories, tagged with theirs, and skips non-repos', () => {
  const { repo, path } = repoWithAgentWorktree();
  const notRepo = mkdtempSync(join(tmpdir(), 'wt-plain-'));
  writeFileSync(join(notRepo, 'x.txt'), 'x');
  const rows = agentWorktrees([notRepo, repo]);
  assert.equal(rows.length, 1);
  assert.equal(norm(rows[0].path), norm(path));
  assert.equal(norm(rows[0].repo), norm(repo));
  assert.equal(rows[0].dirty, false);
});
