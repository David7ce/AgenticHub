import test from 'node:test';
import assert from 'node:assert/strict';

import { redact, isSecretPath } from '../redact.mjs';

// Token-shaped values are built by concatenation so the secret scanner does not flag this file.
test('masks token shapes', () => {
  for (const s of ['sk-' + 'abc123def456ghi789', 'ghp_' + 'a'.repeat(36), 'Bearer ' + 'eyJhbGciOi.x.y', 'github_pat_' + 'b'.repeat(40)])
    assert.equal(redact(`key ${s} end`), 'key [redacted] end');
});
test('masks .env paths but not .env.example', () => {
  assert.equal(redact('cat D:/repo/.env.local'), 'cat [redacted]');
  assert.equal(redact('read .env.example'), 'read .env.example');
});
test('isSecretPath', () => {
  assert.equal(isSecretPath('/a/.env'), true);
  assert.equal(isSecretPath('C:\\a\\.env.prod'), true);
  assert.equal(isSecretPath('/a/.env.example'), false);
});
test('token prefixes only match at the start of a word', () => {
  assert.equal(redact('see task-registry-entry-identifier now'), 'see task-registry-entry-identifier now');
});
test('masks .env paths followed or wrapped by punctuation, but not .env.example', () => {
  assert.equal(redact('cat .env;'), 'cat [redacted];');
  assert.equal(redact('cat (.env)'), 'cat ([redacted])');
  assert.equal(redact('cat .env.example;'), 'cat .env.example;');
});
test('leaves ordinary text alone', () => assert.equal(redact('ran npm test'), 'ran npm test'));
test('empty input is returned unchanged and is not a secret path', () => {
  assert.equal(redact(''), '');
  assert.equal(isSecretPath(''), false);
});
