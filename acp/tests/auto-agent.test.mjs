import test from 'node:test';
import assert from 'node:assert/strict';

import { chooseAutoAgent } from '../route-pick.mjs';
import { CHEAP_AGENT, STRONG_AGENT } from '../router-config.mjs';

test('--agent auto follows the same prompt rules as router.mjs', () => {
  const cheap = chooseAutoAgent('fix the typo in the readme', { stats: null });
  assert.equal(cheap.agent, CHEAP_AGENT);

  const risky = chooseAutoAgent('migrate several files and rotate credentials', { stats: null });
  assert.equal(risky.agent, STRONG_AGENT);
  assert.match(risky.reason, /scope|consequence/);
});

test('--agent auto keeps the health overlay when stats are provided', () => {
  const zero = { runs: 0, ok: 0, failures: 0, recentFailures: 0, timeouts: 0, cost: 0, lastRun: null, lastFailure: null };
  const stats = {
    [CHEAP_AGENT]: { ...zero, recentFailures: 3 },
    [STRONG_AGENT]: zero,
  };
  assert.equal(chooseAutoAgent('rename the variable', { stats }).agent, STRONG_AGENT);
});
