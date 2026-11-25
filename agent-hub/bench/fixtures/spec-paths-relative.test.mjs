// Spec task: `toRelative` does not exist yet. The prose contract is in the
// task prompt; these cases pin behaviour, not implementation.
import test from 'node:test';
import assert from 'node:assert/strict';

import { toRelative } from '../paths.mjs';

test('a path under the base becomes relative, in either spelling', () => {
  assert.equal(toRelative('/mnt/d/a/b/c', '/mnt/d/a'), 'b/c');
  assert.equal(toRelative(String.raw`D:\a\b`, String.raw`D:\a`), 'b');
});

test('mixed spellings describe the same tree', () => {
  assert.equal(toRelative(String.raw`D:\a\b`, '/mnt/d/a'), 'b');
  assert.equal(toRelative('/mnt/d/a/b', String.raw`D:\a`), 'b');
});

test('the same directory is "."', () => {
  assert.equal(toRelative('/mnt/d/a', '/mnt/d/a'), '.');
  assert.equal(toRelative(String.raw`D:\a`, '/mnt/d/a'), '.');
});

test('a different root cannot be made relative, so it comes back absolute', () => {
  assert.equal(toRelative('/home/user/x', '/mnt/d/y'), '/home/user/x');
  assert.equal(toRelative(String.raw`C:\x`, String.raw`D:\y`), '/mnt/c/x');
});

test('the result never keeps a trailing separator', () => {
  assert.equal(toRelative('/mnt/d/a/b/', '/mnt/d/a/'), 'b');
});
