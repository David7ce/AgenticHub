// Spec task: `samePath` does not exist yet. Two spellings, one file — the
// cases below are the contract.
import test from 'node:test';
import assert from 'node:assert/strict';

import { samePath } from '../paths.mjs';

test('a drive path and its /mnt form are the same file', () => {
  assert.equal(samePath(String.raw`D:\Workspaces\AgentHub`, '/mnt/d/Workspaces/AgentHub'), true);
  assert.equal(samePath('/mnt/c/Users/user', String.raw`C:\Users\user`), true);
});

test('the WSL share and the POSIX path are the same file', () => {
  assert.equal(samePath(String.raw`\\wsl.localhost\Ubuntu\home\user`, '/home/user'), true);
});

test('different drives or roots are not', () => {
  assert.equal(samePath(String.raw`D:\a`, String.raw`C:\a`), false);
  assert.equal(samePath('/home/a', '/mnt/c/a'), false);
});

test('a trailing separator and drive-letter case do not change identity', () => {
  assert.equal(samePath('/mnt/d/a/', '/mnt/d/a'), true);
  assert.equal(samePath(String.raw`d:\a`, String.raw`D:\a`), true);
});

test('separators, slash style and case do not change the file', () => {
  assert.equal(samePath(String.raw`D:\Workspaces\AgentHub\`, '/mnt/d/Workspaces/AgentHub/'), true);
  assert.equal(samePath(String.raw`d:/Workspaces/AgentHub`, String.raw`D:\Workspaces\AgentHub`), true);
  assert.equal(samePath(String.raw`\\wsl.localhost\Ubuntu\home\user\`, '/home/user/'), true);
});

test('a genuinely different path is not the same file', () => {
  assert.equal(samePath('/mnt/d/a', '/mnt/d/b'), false);
});
