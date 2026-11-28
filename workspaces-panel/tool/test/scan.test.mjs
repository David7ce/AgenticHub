import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { readState } from '../lib/scan.mjs';

function repoWith(files) {
  const dir = mkdtempSync(join(tmpdir(), 'panel-scan-'));
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  git('config', 'core.autocrlf', 'false');
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  git('add', '.');
  git('commit', '-q', '-m', 'init');
  return dir;
}

test('ignoreChanges keeps generated files out of the dirty count, and nothing else', async () => {
  const dir = repoWith({ 'COSTS.md': 'a\n', 'costs.json': '{}\n', 'ROADMAP.md': 'x\n' });
  try {
    writeFileSync(join(dir, 'COSTS.md'), 'b\n');
    writeFileSync(join(dir, 'costs.json'), '{"n":1}\n');
    const ignoreChanges = ['COSTS.md', 'costs.json'];

    assert.equal((await readState(dir)).dirty, 2, 'without the list, both count');
    assert.equal((await readState(dir, { ignoreChanges })).dirty, 0, 'generated files only: clean');

    writeFileSync(join(dir, 'ROADMAP.md'), 'y\n');
    writeFileSync(join(dir, 'nuevo.md'), 'z\n');
    assert.equal((await readState(dir, { ignoreChanges })).dirty, 2, 'a real edit and a new file still count');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('changes are counted by git kind, once per file', async () => {
  const dir = repoWith({ 'edit.md': 'a\n', 'gone.md': 'b\n', 'old-name.md': 'c\n', 'keep.md': 'd\n' });
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe' });
  try {
    writeFileSync(join(dir, 'edit.md'), 'a2\n');
    rmSync(join(dir, 'gone.md'));
    git('mv', 'old-name.md', 'new-name.md');
    writeFileSync(join(dir, 'added.md'), 'x\n');
    git('add', 'added.md');
    writeFileSync(join(dir, 'added.md'), 'x2\n'); // staged, then edited again: still one "added"
    writeFileSync(join(dir, 'loose.md'), 'y\n');

    const state = await readState(dir);
    assert.equal(state.dirty, 5);
    assert.deepEqual(state.changes, { modified: 1, deleted: 1, renamed: 1, added: 1, untracked: 1 });

    const clean = await readState(repoWith({ 'a.md': 'a\n' }));
    assert.deepEqual(clean.changes, {}, 'a clean repo has no kinds');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
