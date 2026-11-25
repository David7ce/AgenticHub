import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { priceOf, readCodexSpend } from '../../acp/codex-spend.mjs';

test('priceOf needs both input and output, and defaults cacheRead to input', () => {
  assert.equal(priceOf({ costPerMillion: null }), null);
  assert.equal(priceOf({ costPerMillion: { input: 1 } }), null);
  assert.deepEqual(priceOf({ costPerMillion: { input: 2, output: 8 } }), { input: 2, output: 8, cacheRead: 2 });
});

function rollout(root, usage) {
  const dir = join(root, '2026', '11', '10');
  mkdirSync(dir, { recursive: true });
  const lines = [
    { type: 'session_meta', payload: { cwd: 'D:/x' } },
    { type: 'turn_context', payload: { model: 'm1' } },
    { timestamp: '2026-11-10T10:00:00Z', type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: usage } } },
  ].map((l) => JSON.stringify(l)).join('\n');
  writeFileSync(join(dir, 'rollout-a.jsonl'), lines);
}

test('estimated cost is computed only for priced models', () => {
  const root = mkdtempSync(join(tmpdir(), 'codex-cost-'));
  rollout(root, { input_tokens: 1_000_000, cached_input_tokens: 400_000, output_tokens: 100_000 });
  const common = { root, dayKey: () => '2026-11-10', projectLabel: () => ({ label: 'p', path: null }) };
  const priced = readCodexSpend({ ...common, prices: { m1: { input: 2, output: 10, cacheRead: 0.5 } } });
  // fresh 600k*2 + cached 400k*0.5 + out 100k*10 = 1.2 + 0.2 + 1.0 = 2.4
  assert.equal(Number(priced.rows[0].costEstimatedUsd.toFixed(4)), 2.4);
  const unpriced = readCodexSpend(common);
  assert.equal(unpriced.rows[0].costEstimatedUsd, 0);
});
