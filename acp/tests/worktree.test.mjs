import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createWorktree,
  removeWorktree,
  repoInfo,
  safeAgentName,
  worktreeHasChanges,
  worktreePath,
} from '../fanout-acp.mjs';

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout.trim();
}

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'fanout-worktree-'));
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 'test@example.invalid']);
  git(dir, ['config', 'user.name', 'Test']);
  writeFileSync(join(dir, 'README.md'), 'base\n');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-qm', 'init']);
  return dir;
}

test('safeAgentName keeps simple names and flattens the rest', () => {
  assert.equal(safeAgentName('opencode'), 'opencode');
  assert.equal(safeAgentName('a/b c'), 'a-b-c');
  assert.equal(safeAgentName('--'), 'agent');
});

test('worktreePath stays under the git dir', () => {
  const path = worktreePath('/repo/.git', '20261029-120000', 'opencode');
  assert.equal(path.replace(/\\/g, '/'), '/repo/.git/agent-worktrees/20261029-120000-opencode');
});

test('repoInfo finds the root and common git dir', () => {
  const repo = makeRepo();
  const info = repoInfo(repo);
  assert.ok(info);
  // Windows CI's tmpdir is an 8.3 short path (RUNNER~1) while git answers with
  // the long form; compare the canonical path, not the spelling.
  const canonical = (path) => realpathSync.native(path).replace(/\\/g, '/').toLowerCase();
  assert.equal(canonical(info.root), canonical(repo));
  assert.ok(existsSync(join(info.commonDir, 'HEAD')));
});

test('repoInfo returns null outside a repository', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fanout-norepo-'));
  assert.equal(repoInfo(dir), null);
});

test('a worktree starts clean, reports edits, and can be removed', () => {
  const repo = makeRepo();
  const info = repoInfo(repo);
  const path = worktreePath(info.commonDir, '20261029-120000', 'opencode');

  createWorktree(info.root, path);
  assert.ok(existsSync(join(path, 'README.md')));
  assert.equal(worktreeHasChanges(path), false);

  writeFileSync(join(path, 'agent-output.txt'), 'changed\n');
  assert.equal(worktreeHasChanges(path), true);

  assert.equal(removeWorktree(info.root, path), true);
  assert.equal(existsSync(path), false);
  assert.doesNotMatch(git(info.root, ['worktree', 'list']), /20261029-120000-opencode/);
});

test('two agents get independent checkouts', () => {
  const repo = makeRepo();
  const info = repoInfo(repo);
  const a = worktreePath(info.commonDir, 'stamp', 'opencode');
  const b = worktreePath(info.commonDir, 'stamp', 'hermes');

  createWorktree(info.root, a);
  createWorktree(info.root, b);
  writeFileSync(join(a, 'only-a.txt'), 'a\n');

  assert.equal(worktreeHasChanges(a), true);
  assert.equal(worktreeHasChanges(b), false);
  assert.equal(existsSync(join(b, 'only-a.txt')), false);

  removeWorktree(info.root, a);
  removeWorktree(info.root, b);
});
