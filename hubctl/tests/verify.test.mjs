import test from 'node:test';
import assert from 'node:assert/strict';

import { detectVerifyCommand, parseVerifyArgs, tailLines } from '../commands/verify.mjs';

test('verify detection follows the repo shape, with package.json first', () => {
  const pkg = { command: 'npm test', why: 'package.json scripts.test' };
  assert.deepEqual(
    detectVerifyCommand({ names: ['package.json', 'go.mod'], readJson: () => ({ scripts: { test: 'node --test' } }) }),
    pkg,
  );
  // A package.json without scripts.test must not shadow the real toolchain.
  assert.deepEqual(
    detectVerifyCommand({ names: ['package.json', 'go.mod'], readJson: () => ({ scripts: {} }) }),
    { command: 'go test ./...', why: 'go.mod' },
  );
  assert.equal(detectVerifyCommand({ names: ['pyproject.toml'] }).command, 'python -m pytest -q');
  assert.equal(detectVerifyCommand({ names: ['App.sln'] }).command, 'dotnet test');
  assert.equal(detectVerifyCommand({ names: ['Cargo.toml'] }).command, 'cargo test');
  assert.equal(detectVerifyCommand({ names: ['README.md'] }), null);
});

test('verify arguments are strict and --cmd never becomes the directory', () => {
  const args = parseVerifyArgs(['--json', '--cmd', 'npm test', 'D:/repo', '--timeout', '5000']);
  assert.equal(args.asJson, true);
  assert.equal(args.command, 'npm test');
  assert.equal(args.timeout, 5000);
  assert.ok(args.dir.endsWith('repo'));
  assert.equal(parseVerifyArgs(['--task', 't-1']).task, 't-1');
  assert.throws(() => parseVerifyArgs(['--task']), /needs a task id/);
  assert.throws(() => parseVerifyArgs(['--cmd']), /needs a command/);
  assert.throws(() => parseVerifyArgs(['--nope']), /unknown option/);
  assert.throws(() => parseVerifyArgs(['a', 'b']), /unexpected argument/);
});

test('tailLines keeps the last lines and normalises CRLF', () => {
  const text = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\r\n');
  const tail = tailLines(text, 3);
  assert.equal(tail, 'line 27\nline 28\nline 29');
  assert.equal(tailLines('one\n'), 'one');
});
