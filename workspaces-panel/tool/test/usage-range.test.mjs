// IA page range aggregation: what the calendar selection shows.
//
//   node --test workspaces-panel/tool/test/

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

import { renderCostsPage } from '../page/costs-render.mjs';

const source = readFileSync(new URL('../page/usage-range.js', import.meta.url), 'utf8');

function load() {
  const context = { Map };
  vm.runInNewContext(source, context);
  return context;
}

const tokens = { input_tokens: 0, output_tokens: 0, cache_write_tokens: 0, cache_read_tokens: 0, reasoning_tokens: 0, unknown_tokens: 0 };
const r = (fields) => ({ ...tokens, project: 'p', model: 'm', ...fields });

test('range_totals_include_rows_without_hour', () => {
  const c = load();
  const rows = [
    r({ date: '2026-11-20', hour: null, agent: 'claude', input_tokens: 5 }),
    r({ date: '2026-11-20', hour: 3, agent: 'claude', output_tokens: 7 }),
    r({ date: '2026-11-21', hour: 1, agent: 'claude', output_tokens: 100 }),
  ];
  assert.equal(c.dailyWork(rows).get('2026-11-20'), 12);
  const day = c.breakdown(rows, ['2026-11-20', '2026-11-20']);
  assert.equal(day.agents[0].work, 12);
  assert.equal(day.totals.claude.input_tokens, 5);
  assert.equal(c.breakdown(rows, null).agents[0].work, 112);
});

test('work_counts_undisclosed_but_not_cache_reads', () => {
  const c = load();
  assert.equal(c.workOf(r({ input_tokens: 1, output_tokens: 2, cache_write_tokens: 3, unknown_tokens: 4, cache_read_tokens: 1000 })), 10);
});

test('bills by provider rather than client or model name, and merges the same model across clients', () => {
  const c = load();
  const source = [
    r({ source: 'opencode', agent: 'opencode', model: 'gpt-sol (openai)', output_tokens: 10 }),
    r({ source: 'codex', agent: 'codex', model: 'gpt-sol (openai)', output_tokens: 5 }),
    r({ source: 'opencode', agent: 'opencode', model: 'claude-haiku (opencode-go)', output_tokens: 25 }),
    r({ source: 'opencode', agent: 'opencode', model: 'claude-haiku (opencode)', output_tokens: 2 }),
  ];
  assert.equal(c.billingOf(source[0], false), 'other');
  // OpenCode Zen (free or pay-as-you-go) is OpenCode, but not the Go allowance.
  assert.equal(c.billingOf(source[3], false), 'zen');
  const models = c.breakdown(c.billedRows(source, true), null).models.map((entry) => [entry.key, entry.work]);
  assert.deepEqual(JSON.parse(JSON.stringify(models)), [
    ['opencode · claude-haiku', 25], ['codex · gpt-sol', 15], ['zen · claude-haiku', 2],
  ]);
});

test('ranking orders by work tokens with cache reads apart', () => {
  const c = load();
  const rows = [
    r({ date: '2026-11-23', agent: 'claude', output_tokens: 10, cache_read_tokens: 9999 }),
    r({ date: '2026-11-23', agent: 'opencode', output_tokens: 30 }),
  ];
  const { agents } = c.breakdown(rows, ['2026-11-23', '2026-11-23']);
  assert.deepEqual(JSON.parse(JSON.stringify(agents.map((a) => [a.key, a.work]))), [['opencode', 30], ['claude', 10]]);
  assert.equal(agents[1].cacheRead, 9999);
});

test('ranges pick their days; projects and models are top 8', () => {
  const c = load();
  const rows = [
    r({ date: '2026-11-23', agent: 'claude', output_tokens: 10 }),
    r({ date: '2026-11-18', agent: 'claude', output_tokens: 20 }),
    r({ date: '2026-11-01', agent: 'claude', output_tokens: 40 }),
    ...Array.from({ length: 10 }, (_, i) => r({ date: '2026-10-01', agent: 'codex', project: 'q' + i, model: 'x' + i, unknown_tokens: i + 1 })),
  ];
  assert.equal(c.breakdown(rows, ['2026-11-17', '2026-11-23']).agents[0].work, 30);
  assert.equal(c.breakdown(rows, ['2026-11-01', '2026-11-30']).agents[0].work, 70);
  assert.equal(c.breakdown(rows, ['2026-11-01', '2026-11-30']).projects[0].key, 'p');
  const october = c.breakdown(rows, ['2026-10-01', '2026-10-31']);
  assert.equal(october.projects.length, 8);
  assert.equal(october.models[0].key, 'codex · x9');
  assert.equal(c.inRange(rows, null).length, rows.length);
});

test('ia_page_renders_with_empty_ledger', () => {
  const html = renderCostsPage({ schemaVersion: 2, rows: [] });
  assert.match(html, /data-cal="weeks"/);
  assert.ok(!html.includes('id="period"') && !html.includes('id="date"'));
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  assert.doesNotThrow(() => new Function(script));
});

test('only rows timed per step go into the hourly chart', () => {
  const c = load();
  assert.equal(c.hasStepHour(r({ source: 'claude-code', hour: 10 })), true);
  assert.equal(c.hasStepHour(r({ source: 'codex', hour: 10, input_tokens: 5 })), true);
  // A Codex thread total sits at the thread's start hour.
  assert.equal(c.hasStepHour(r({ source: 'codex', hour: 10, unknown_tokens: 5 })), false);
  // OpenCode replies carry their own time; session totals only their start.
  assert.equal(c.hasStepHour(r({ source: 'opencode', hour: 10, stepHours: true })), true);
  assert.equal(c.hasStepHour(r({ source: 'opencode', hour: 10 })), false);
  assert.equal(c.hasStepHour(r({ source: 'claude-code', hour: null })), false);
});

test('Go share adds each model against its own allowance; the week is half the month', () => {
  const c = load();
  const models = [
    { id: 'flash', monthly: { go: 100, 'go-plus': 200 } },
    { id: 'pro', monthly: { go: 20 } },
  ];
  const local = { flash: { weekUsd: 5, recentUsd: 10 }, pro: { weekUsd: 1, recentUsd: 2 }, stray: { weekUsd: 9, recentUsd: 9 } };
  const share = c.goShare(local, models, 'go');
  assert.ok(Math.abs(share.week - (5 / 50 + 1 / 10)) < 1e-9);
  assert.ok(Math.abs(share.month - (10 / 100 + 2 / 20)) < 1e-9);
  assert.ok(Math.abs(c.goShare(local, models, 'go-plus').week - 5 / 100) < 1e-9);
  assert.equal(c.goShare({}, models, 'go'), null);
  assert.equal(c.goShare(local, [], 'go'), null);
});

test('activity stats: peak day and streaks of days with work, the same for every subscription', () => {
  const c = load();
  const rows = [
    r({ date: '2026-11-20', output_tokens: 5 }),
    r({ date: '2026-11-21', output_tokens: 50 }),
    r({ date: '2026-11-21', input_tokens: 10 }),
    r({ date: '2026-11-22', output_tokens: 1 }),
    // Cache reads alone are not work: the 23rd breaks the streak.
    r({ date: '2026-11-23', cache_read_tokens: 999 }),
    r({ date: '2026-11-25', output_tokens: 2 }),
    r({ date: '2026-11-26', output_tokens: 3 }),
  ];
  const stats = c.activityStats(rows, '2026-11-26');
  assert.deepEqual(JSON.parse(JSON.stringify(stats)), { peakDay: '2026-11-21', peakWork: 60, currentStreak: 2, longestStreak: 3, activeDays: 5 });
  // A streak still counts when today has no use yet.
  assert.equal(c.activityStats(rows, '2026-11-27').currentStreak, 2);
  assert.equal(c.activityStats(rows, '2026-11-28').currentStreak, 0);
  assert.equal(c.activityStats([], '2026-11-26'), null);
});
