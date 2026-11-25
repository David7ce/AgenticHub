import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { estimatedCodexToday } from '../spend-estimate.mjs';

function rollout(root, name, originator, usage) {
  const dir = join(root, 'd');
  mkdirSync(dir, { recursive: true });
  const lines = [
    { type: 'session_meta', payload: { cwd: 'D:/x', originator } },
    { type: 'turn_context', payload: { model: 'm1' } },
    { timestamp: new Date().toISOString(), type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: usage } } },
  ].map((l) => JSON.stringify(l)).join('\n');
  writeFileSync(join(dir, `rollout-${name}.jsonl`), lines);
}

function models(dir, costPerMillion) {
  const path = join(dir, 'models.json');
  writeFileSync(path, JSON.stringify({ models: [{ id: 'm1', agent: 'codex', costPerMillion }] }));
  return path;
}

test('only hub-started Codex sessions count against the hub cap, priced from models.json', () => {
  const root = mkdtempSync(join(tmpdir(), 'codex-est-'));
  rollout(root, 'hub', 'agent-hub-acp', { input_tokens: 1_000_000, cached_input_tokens: 0, output_tokens: 0 });
  rollout(root, 'mine', 'codex-tui', { input_tokens: 9_000_000, cached_input_tokens: 0, output_tokens: 0 });
  const modelsPath = models(root, { input: 2, output: 8 });
  assert.equal(Number(estimatedCodexToday({ root, modelsPath }).toFixed(4)), 2);
});

test('an unpriced model counts as zero, never a guess', () => {
  const root = mkdtempSync(join(tmpdir(), 'codex-est-'));
  rollout(root, 'hub', 'agent-hub-acp', { input_tokens: 1_000_000, cached_input_tokens: 0, output_tokens: 0 });
  const modelsPath = models(root, null);
  assert.equal(estimatedCodexToday({ root, modelsPath }), 0);
});
