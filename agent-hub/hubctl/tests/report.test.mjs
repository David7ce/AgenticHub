import assert from 'node:assert/strict';
import test from 'node:test';

import { collectReport, renderReport } from '../report.mjs';

const now = Date.parse('2026-11-08T12:00:00Z');
const line = (over) => JSON.stringify({ time: '2026-11-08T11:00:00Z', agent: 'opencode', status: 'ok', durationMs: 1000, ...over });

test('collectReport groups by agent and model and skips probes', () => {
  const text = [
    line({ durationMs: 1000, model: 'm1' }),
    line({ durationMs: 3000, model: 'm1' }),
    line({ durationMs: 2000, model: 'm1' }),
    line({ status: 'failed', durationMs: 500, model: 'm1' }),
    line({ status: 'probe' }),
    line({ agent: 'claude', status: 'timeout', durationMs: 9000, model: 'sonnet' }),
  ].join('\n');
  const report = collectReport(text, { now, days: 1 });
  assert.equal(report.runs, 5);
  assert.equal(report.skipped, 1);
  const open = report.rows.find((row) => row.agent === 'opencode');
  assert.equal(open.runs, 4);
  assert.equal(open.ok, 3);
  assert.equal(open.failed, 1);
  assert.equal(open.p50Ms, 2000);
  assert.equal(open.p95Ms, 3000);
  const claude = report.rows.find((row) => row.agent === 'claude');
  assert.equal(claude.timeout, 1);
});

test('collectReport drops lines outside the window and sums reported cost', () => {
  const old = line({ time: '2026-10-01T00:00:00Z', cost: { amount: 9 } });
  const recent = line({ cost: { amount: 0.25 } });
  const report = collectReport(`${old}\n${recent}`, { now, days: 2 });
  assert.equal(report.rows.length, 1);
  assert.equal(report.rows[0].costUsd, 0.25);
});

test('renderReport prints a table and no ANSI when colour is off', () => {
  const report = collectReport(line({}), { now, days: 1 });
  const text = renderReport(report, { color: false, now });
  assert.match(text, /AGENTHUB REPORT/);
  assert.match(text, /agent\s+model\s+runs/);
  assert.doesNotMatch(text, /\x1b\[/);
});

test('renderReport handles an empty window without throwing', () => {
  const report = collectReport('', { now, days: 1 });
  assert.match(renderReport(report, { color: false, now }), /no completed turns/);
});

test('classifyFailure separates causes that need different fixes', async () => {
  const { classifyFailure } = await import('../report.mjs');
  assert.equal(classifyFailure({ status: 'ok' }), null);
  assert.equal(classifyFailure({ status: 'failed', error: 'session/prompt: Internal error: Free usage limit reached. (code -32603)' }), 'quota');
  assert.equal(classifyFailure({ status: 'failed', error: "You've hit your weekly limit" }), 'quota');
  assert.equal(classifyFailure({ status: 'failed', error: 'session/prompt: Authentication required (code -32000)' }), 'auth');
  assert.equal(classifyFailure({ status: 'failed', error: 'getaddrinfo EAI_AGAIN opencode.ai (code -32603)' }), 'network');
  assert.equal(classifyFailure({ status: 'failed', error: 'session/set_config_option: Internal error (code -32603)' }), 'config');
  assert.equal(classifyFailure({ status: 'failed', error: 'spawn hermes ENOENT' }), 'spawn');
  assert.equal(classifyFailure({ status: 'failed', error: 'session/prompt: Internal error (code -32603)' }), 'agent-error');
  assert.equal(classifyFailure({ status: 'failed' }), 'unknown');
  assert.equal(classifyFailure({ status: 'timeout', cancelAck: false }), 'timeout-unacked');
  assert.equal(classifyFailure({ status: 'timeout', cancelAck: true }), 'timeout');
  assert.equal(classifyFailure({ status: 'budget' }), 'budget');
});
