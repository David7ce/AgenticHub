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
