// Construct task: a new export in paths.mjs AND a new flag in hubctl, judged by
// a file the agent never sees. The CLI half is what makes it cross-module.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { toRelative } from '../paths.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const HUBCTL = resolve(HERE, '..', '..', 'hubctl', 'hubctl.mjs');

test('toRelative answers in the same terms as the module', () => {
  assert.equal(toRelative('/mnt/d/a/b/c', '/mnt/d/a'), 'b/c');
  assert.equal(toRelative(String.raw`D:\a\b`, '/mnt/d/a'), 'b');
  assert.equal(toRelative('/mnt/d/a', '/mnt/d/a'), '.');
  assert.equal(toRelative('/home/user/x', '/mnt/d/y'), '/home/user/x');
});

test('hubctl path --base prints the relative form next to the two spellings', () => {
  const result = spawnSync(
    process.execPath,
    [HUBCTL, 'path', '/mnt/d/a/b/c', '--base', '/mnt/d/a', '--no-color'],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /relative\s+b\/c/);
  assert.match(result.stdout, /wsl\s+\/mnt\/d\/a\/b\/c/);
});

test('without --base the command still behaves as before', () => {
  const result = spawnSync(
    process.execPath,
    [HUBCTL, 'path', '/mnt/d/a/b/c', '--no-color'],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /relative/);
});
