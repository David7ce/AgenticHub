// Spec task: `explainDecision` does not exist yet. One readable line about a
// routing decision — the assertions check content, not formatting.
import test from 'node:test';
import assert from 'node:assert/strict';

import { explainDecision } from '../router.mjs';

const stats = {
  opencode: { runs: 3, ok: 3, failures: 0, recentFailures: 0, timeouts: 0, cost: 0.0012 },
  claude: { runs: 1, ok: 0, failures: 1, recentFailures: 1, timeouts: 0, cost: 0.42 },
};

test('names the agent that was chosen and repeats the reason', () => {
  const line = explainDecision({ agent: 'claude', reason: 'prompt mentions refactor' }, stats);
  assert.match(line, /claude/);
  assert.match(line, /prompt mentions refactor/);
});

test('reports what the window actually saw for both routing targets', () => {
  const line = explainDecision({ agent: 'opencode', reason: 'cheap default' }, stats);
  assert.match(line, /opencode/);
  assert.match(line, /3/);
  assert.match(line, /1/);
});

test('says so when there is no data, instead of inventing numbers', () => {
  const line = explainDecision({ agent: 'opencode', reason: 'cheap default' }, null);
  assert.match(line, /no data/i);
});

test('survives a partially populated stats object', () => {
  const line = explainDecision({ agent: 'opencode', reason: 'cheap default' }, { opencode: stats.opencode });
  assert.match(line, /opencode/);
});
