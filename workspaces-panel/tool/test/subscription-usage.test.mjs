import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { claudeLiveScript, claudeStatusWindows, estimateGoLocal, goModelReferences, hasChatGptConnection, readCodexAccountStats, readGoUsage } from '../lib/subscription-usage.mjs';

test('Go loads a manual snapshot and never treats missing or invalid windows as zero', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'go-usage-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'go-usage.json');
  const measuredAt = '2026-11-25T20:00:00.000Z';
  const resetsAt = '2026-12-01T00:00:00.000Z';
  assert.equal(readGoUsage(path), null);
  writeFileSync(path, JSON.stringify({ measuredAt, windows: [
    { label: '5h', usedPercent: 0, resetsAt },
    { label: 'week', usedPercent: 103, resetsAt },
    { label: 'month', usedPercent: 92, resetsAt, ignored: true },
  ] }));
  assert.deepEqual(readGoUsage(path), {
    measuredAt, windows: [{ label: 'month', usedPercent: 92, resetsAt }, { label: '5h', usedPercent: 0, resetsAt }],
  });
});

test('Go model references preserve per-tier USD limits and omit free or unpriced models', () => {
  const m = { id: 'test', cost: { text: { input: { price: 0.15 }, output: { price: 0.60 } } },
    go: { monthly_usage: { go: 100, 'go-plus': 200, 'go-teams': null } } };
  assert.deepEqual(goModelReferences({ data: [m, { ...m, go: null }] }), [
    { id: 'test', name: 'test', input: 0.15, output: 0.60, monthly: { go: 100, 'go-plus': 200 }, cacheRead: 0, cacheWrite: 0 },
  ]);
});

test('Go costs price work and cache separately, from local Go sessions only', () => {
  const now = new Date('2026-11-25T12:30:00Z');
  const model = { id: 'paid', input: 1, output: 2, cacheRead: .25, cacheWrite: 1 };
  const row = { agent: 'opencode', source: 'opencode', date: '2026-11-23', hour: 0, model: 'paid (opencode-go)',
    input_tokens: 1e6, output_tokens: 1e6, cache_read_tokens: 1e6, cache_write_tokens: 1e6, reasoning_tokens: 1e6 };
  const rows = [row, { ...row, date: '2026-11-22', hour: 23 },
    { ...row, model: 'paid (openai)' }, { ...row, source: 'agent-hub' }, { ...row, date: '2026-10-01' },
    { ...row, date: '2026-11-25', hour: 13 }];
  assert.deepEqual(estimateGoLocal(rows, [model], now).paid, { weekUsd: 4.25, recentUsd: 8.5 });
});

test('Codex dashboard snapshots are distinct and validated, preserving reported precision', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-account-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'codex-account.json');
  writeFileSync(path, JSON.stringify({ measuredOn: '2026-11-25', lifetimeTokens: 352800000, peakTokens: -1, foo: 'ignored' }));
  assert.deepEqual(readCodexAccountStats(path), { measuredOn: '2026-11-25', lifetimeTokens: 352800000 });
});

test('recognizes only an unambiguous ChatGPT OAuth connection', () => {
  const oauth = { type: 'credential', method: 'oauth' };
  const set = (...connections) => [{ id: 'openai', connections }];
  assert.equal(hasChatGptConnection(set(oauth)), true);
  assert.equal(hasChatGptConnection(set(oauth, { type: 'credential', method: 'key' })), false);
  assert.equal(hasChatGptConnection(set({ type: 'environment' })), false);
});

test('Claude only records current subscription windows, not API gateway spend limits', () => {
  const now = new Date('2026-11-25T12:00:00Z');
  const sec = now.getTime() / 1000;
  assert.deepEqual(claudeStatusWindows({ rate_limits: {
    five_hour: { used_percentage: 92, resets_at: sec - 1 },
    seven_day: { used_percentage: 23.5, resets_at: sec + 60 },
    spend_limit: { period: 'monthly', used_percentage: 87, resets_at: sec + 60 },
  } }, now), [{ label: 'week', usedPercent: 23.5, resetsAt: '2026-11-25T12:01:00.000Z' }]);
});

test('Claude live asset passes the snapshot without network or a module loader', () => {
  const expected = { measuredAt: '2026-11-25T12:00:00Z', windows: [
    { label: 'week', usedPercent: 90, resetsAt: '2026-11-30T12:00:00Z' },
  ] };
  let actual;
  runInNewContext(claudeLiveScript(expected), { window: { acceptClaudeUsage: (v) => { actual = JSON.stringify(v); } } });
  assert.equal(actual, JSON.stringify(expected));
  assert.doesNotThrow(() => runInNewContext(claudeLiveScript(null), { window: {} }));
});
