import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkDailySpend } from '../doctor.mjs';

test('checkDailySpend warns at 80% and fails at the cap', () => {
  const grant = { enabled: true, limits: { maxDailyUsd: 5 } };
  const consent = { claude: grant, codex: grant, opencode: grant };
  const spent = (name) => ({ claude: 4.5, codex: 5, opencode: 1 })[name];
  const levels = checkDailySpend(consent, spent).map((r) => r.level);
  assert.deepEqual(levels, ['warn', 'fail']);
});
