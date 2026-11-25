import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRollout } from '../../acp/codex-spend.mjs';
import { collectReport } from '../report.mjs';

test('parseRollout keeps the last cumulative token_count, model and cwd', () => {
  const lines = [
    { type: 'session_meta', payload: { cwd: 'D:/x' } },
    { type: 'turn_context', payload: { model: 'gpt-6.1-terra' } },
    { timestamp: '2026-11-09T10:00:00Z', type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 10 } } } },
    { timestamp: '2026-11-09T11:00:00Z', type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 99 } } } },
  ].map((l) => JSON.stringify(l)).join('\n');
  const s = parseRollout(lines);
  assert.equal(s.usage.input_tokens, 99);
  assert.equal(s.model, 'gpt-6.1-terra');
  assert.equal(s.cwd, 'D:/x');
  assert.equal(parseRollout('{}'), null);
});

test('collectReport hides agents outside the allowed set and counts them', () => {
  const t = new Date().toISOString();
  const text = [{ time: t, agent: 'hermes', status: 'ok' }, { time: t, agent: 'codex', status: 'ok' }]
    .map((l) => JSON.stringify(l)).join('\n');
  const r = collectReport(text, { agents: new Set(['codex']) });
  assert.equal(r.rows.length, 1);
  assert.equal(r.retired, 1);
});

import { agentChain } from '../../acp/router.mjs';
test('agentChain uses the registry list, else the two-pool swap', () => {
  assert.deepEqual(agentChain({ agentFallbacks: ['codex', 'opencode', 'claude'] }, 'claude'), ['codex', 'opencode']);
  assert.deepEqual(agentChain({}, 'claude'), ['opencode']);
  assert.deepEqual(agentChain(null, 'opencode'), ['claude']);
});
