import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { archivedPath, rotateIfNeeded } from '../log-rotation.mjs';

function dir() {
  return mkdtempSync(join(tmpdir(), 'log-rotation-'));
}

test('archivedPath stamps down to the second, next to the original', () => {
  const now = new Date('2026-11-01T21:05:09.123Z');
  assert.equal(
    archivedPath('/logs/runs.jsonl', now).replace(/\\/g, '/'),
    '/logs/runs-2026-11-01T21-05-09.jsonl',
  );
});

test('a file under the threshold is left alone', () => {
  const path = join(dir(), 'runs.jsonl');
  writeFileSync(path, 'a small line\n');
  const result = rotateIfNeeded(path, { maxBytes: 1_000_000 });
  assert.equal(result, null);
  assert.ok(existsSync(path));
});

test('a missing file is not an error', () => {
  const result = rotateIfNeeded(join(dir(), 'nope.jsonl'), { maxBytes: 1 });
  assert.equal(result, null);
});

test('a file at or over the threshold is renamed and the original path freed', () => {
  const path = join(dir(), 'runs.jsonl');
  writeFileSync(path, 'x'.repeat(100));
  const now = new Date('2026-11-01T00:00:00.000Z');

  const archived = rotateIfNeeded(path, { maxBytes: 100, now });

  assert.match(archived.replace(/\\/g, '/'), /runs-2026-11-01T00-00-00\.jsonl$/);
  assert.ok(!existsSync(path), 'the live path is free for the next append');
  assert.equal(readFileSync(archived, 'utf8'), 'x'.repeat(100));
});

test('a second rotation in the same second does not overwrite the first', () => {
  const base = dir();
  const path = join(base, 'runs.jsonl');
  const now = new Date('2026-11-01T00:00:00.000Z');

  writeFileSync(path, 'first');
  const first = rotateIfNeeded(path, { maxBytes: 1, now });

  writeFileSync(path, 'second');
  const second = rotateIfNeeded(path, { maxBytes: 1, now });

  assert.notEqual(first, second);
  assert.equal(readFileSync(first, 'utf8'), 'first');
  assert.equal(readFileSync(second, 'utf8'), 'second');
});

test('exactly at the threshold still rotates (>= , not >)', () => {
  const path = join(dir(), 'runs.jsonl');
  writeFileSync(path, 'x'.repeat(50));
  assert.equal(statSync(path).size, 50);
  const archived = rotateIfNeeded(path, { maxBytes: 50 });
  assert.ok(archived);
  assert.ok(!existsSync(path));
});
