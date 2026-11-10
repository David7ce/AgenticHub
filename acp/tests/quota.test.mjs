import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isQuotaError } from '../quota.mjs';
import { classifyFailure } from '../../hubctl/report.mjs';

test('one definition: what the router retries is what report calls quota', () => {
  for (const text of ['429 Too Many Requests', 'weekly limit reached', 'Rate limit hit', 'quota exceeded', 'credits exhausted', 'session limit']) {
    assert.ok(isQuotaError(text), text);
    assert.equal(classifyFailure({ status: 'failed', error: text }), 'quota', text);
  }
  assert.ok(!isQuotaError('syntax error in file'));
  assert.ok(!isQuotaError(''));
});
