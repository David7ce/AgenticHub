import test from 'node:test';
import assert from 'node:assert/strict';

import { estimateGo, humanTokens } from '../hubctl.mjs';

// The usage estimate is the only local way to see how much of the Go allowance
// is gone: the provider reports cost 0 for flat-rate models. These pin the
// arithmetic, not the table.
const entry = (id, input, output, cache = 0) => ({
  model: { id },
  tokens: { input, output, cache: { read: cache } },
});

test('prices a model against its monthly allowance', () => {
  const result = estimateGo(entry('deepseek-v4.1-flash', 1_000_000, 1_000_000));
  assert.equal(result.cost, 0.75); // 0.15 in + 0.60 out
  assert.equal(result.limit, 100);
  assert.ok(Math.abs(result.pct - 0.0075) < 1e-9);
});

test('cached reads are priced separately and cheaply', () => {
  const result = estimateGo(entry('deepseek-v4.1-flash', 0, 0, 1_000_000));
  assert.equal(result.cost, 0.003);
});

test('a free model reports a null limit instead of a percentage', () => {
  const result = estimateGo(entry('iceman-contributor-free', 1_000_000, 1_000_000));
  assert.equal(result.cost, 0);
  assert.equal(result.limit, null);
});

test('a model with no price entry returns null rather than guessing', () => {
  assert.equal(estimateGo(entry('some-unknown-model', 1_000_000, 1_000_000)), null);
});

test('token counts are formatted for the table', () => {
  assert.equal(humanTokens(1_500_000), '1.5M');
  assert.equal(humanTokens(2_400), '2k');
  assert.equal(humanTokens(42), '42');
  assert.equal(humanTokens(1_200_000_000), '1.2G');
});
