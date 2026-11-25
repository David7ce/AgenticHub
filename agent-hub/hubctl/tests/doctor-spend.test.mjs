import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkDailySpend, checkUnpricedCaps } from '../doctor.mjs';

test('a dollar cap on an unpriced agent is flagged', () => {
  const consent = { codex: { enabled: true, limits: { maxDailyUsd: 5 } }, claude: { enabled: true, limits: { maxDailyUsd: 5 } } };
  const unpriced = { models: [{ agent: 'codex', id: 'a', enabled: true, costPerMillion: null }] };
  assert.equal(checkUnpricedCaps(consent, unpriced).length, 1);
  const priced = { models: [{ agent: 'codex', id: 'a', enabled: true, costPerMillion: { input: 1, output: 2 } }] };
  assert.equal(checkUnpricedCaps(consent, priced).length, 0);
});

test('checkDailySpend warns at 80% and fails at the cap', () => {
  const grant = { enabled: true, limits: { maxDailyUsd: 5 } };
  const consent = { claude: grant, codex: grant, opencode: grant };
  const spent = (name) => ({ claude: 4.5, codex: 5, opencode: 1 })[name];
  const levels = checkDailySpend(consent, spent).map((r) => r.level);
  assert.deepEqual(levels, ['warn', 'fail']);
});
