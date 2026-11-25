import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  buildCostsView,
  cacheWeight,
  claudeReference,
  claudeWindows,
  collectLimits,
  DEFAULT_CACHE_WEIGHT,
  findLimitHits,
  fitCacheWeight,
  quotaTokens,
  workTokens,
} from '../lib/costs.mjs';

const USAGE = {
  codex: { source: 'live', summary: { plan: 'plus', windows: [
    { label: 'semanal', usedPercent: 12, resetsAt: '2026-11-30T16:16:00Z', windowMins: 10080 }] }, error: null },
  opencode: { models: [{ model: 'gpt-6-luna', pct: 0.099, cost: 1.48, limit: 15 },
    { model: 'iceman-contributor-free', cost: 0, limit: null }] },
};
const NOW = new Date('2026-11-23T20:00:00Z');

const row = (date, hour, work, extra = {}) => ({
  date, hour, source: 'claude-code', agent: 'claude', model: 'm', project: 'p',
  input_tokens: work, output_tokens: 0, cache_write_tokens: 0, cache_read_tokens: 999,
  reasoning_tokens: 0, unknown_tokens: 0, observations: 1, sessions: 1, ...extra,
});

test('work tokens exclude cache reads', () => {
  assert.equal(workTokens({ input_tokens: 1, output_tokens: 2, cache_write_tokens: 3, cache_read_tokens: 1000 }), 6);
});

test('claude window and record', () => {
  const rows = Array.from({ length: 10 }, (_, h) => row('2026-11-20', h, h === 3 ? 100 : 10));
  rows.push({ ...row('2026-11-20', 9, 500), agent: 'opencode', source: 'opencode' });
  const w = claudeWindows(rows, new Date('2026-11-20T10:00:00Z'));
  assert.equal(w.window5h.tokens, 50);
  assert.equal(w.record5h.tokens, 140);
  assert.equal(w.week.tokens, 190);
  assert.equal(w.recordWeek.tokens, 190);
});

test('claude windows handle gaps and legacy rows', () => {
  const empty = claudeWindows([], new Date('2026-11-20T10:00:00Z'));
  for (const key of ['window5h', 'week', 'record5h', 'recordWeek']) assert.equal(empty[key].tokens, 0);
  const legacy = claudeWindows([row('2026-11-20', null, 50)], new Date('2026-11-20T10:00:00Z'));
  assert.equal(legacy.record5h.tokens, 0);
  assert.ok(Number.isFinite(legacy.week.tokens));
});

test('limit hit detection keeps only time', () => {
  const dir = mkdtempSync(join(tmpdir(), 'limits-'));
  try {
    mkdirSync(join(dir, 'p'));
    const quote = 'Claude AI usage limit reached|1795000000';
    writeFileSync(join(dir, 'p', 'x.jsonl'), [
      JSON.stringify({ type: 'assistant', isApiErrorMessage: true, timestamp: '2026-11-20T10:00:00Z',
        message: { model: '<synthetic>', content: [{ type: 'text', text: quote }] } }),
      JSON.stringify({ type: 'assistant', isApiErrorMessage: true, timestamp: '2026-11-21T10:00:00Z',
        message: { model: '<synthetic>', content: [{ type: 'text', text: '5-hour limit reached ∙ resets 3pm' }] } }),
      // Talking about the limit is not hitting it:
      JSON.stringify({ type: 'user', timestamp: '2026-11-19T09:00:00Z', message: { role: 'user', content: `the scanner looks for "${quote}"` } }),
      JSON.stringify({ type: 'assistant', timestamp: '2026-11-19T09:01:00Z', message: { model: 'm', content: [{ type: 'text', text: quote }] } }),
      JSON.stringify({ type: 'assistant', isSidechain: true, isApiErrorMessage: true, timestamp: '2026-11-19T09:02:00Z',
        message: { model: '<synthetic>', content: [{ type: 'text', text: quote }] } }),
      JSON.stringify({ type: 'assistant', isApiErrorMessage: true, timestamp: '2026-11-19T09:03:00Z',
        message: { model: '<synthetic>', content: [{ type: 'text', text: `A long explanation that mentions ${quote} among many other words.` }] } }),
      '',
    ].join('\n'));
    assert.deepEqual(findLimitHits(dir), ['2026-11-20T10:00:00Z', '2026-11-21T10:00:00Z']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('reference prefers config, then the first observed hit', () => {
  const rows = Array.from({ length: 10 }, (_, h) => row('2026-11-20', h, 10));
  assert.deepEqual(
    claudeReference({ claude: { plan: 'pro', window5h: 1000, week: 9000 } }, ['2026-11-20T08:00:00Z'], rows),
    { plan: 'pro', window5h: 1000, week: 9000, source: 'manual' });
  const observed = claudeReference({ claude: { plan: 'pro' } }, ['2026-11-20T08:00:00Z', '2026-11-20T05:00:00Z'], rows);
  assert.equal(observed.window5h, 50);
  assert.equal(observed.source, 'observed 2026-11-20');
  assert.equal(claudeReference({}, [], rows), null);
  // A hit with no hourly rows before it says nothing about the ceiling.
  assert.equal(claudeReference({}, ['2026-11-25T08:00:00Z'], rows), null);
});

test('quota tokens weigh cache reads, and the weight is configurable', () => {
  const tokens = { input_tokens: 100, output_tokens: 10, cache_write_tokens: 20, cache_read_tokens: 1_000 };
  assert.equal(quotaTokens(tokens), 130 + 100); // prior 0.1
  assert.equal(quotaTokens(tokens, 0), 130);
  assert.equal(quotaTokens(tokens, 1), 1_130);
  assert.equal(cacheWeight({}), DEFAULT_CACHE_WEIGHT);
  assert.equal(cacheWeight({ claude: { cacheWeight: 0.25 } }), 0.25);
  assert.equal(cacheWeight({ cacheWeight: 0.02 }), 0.02);
  assert.equal(cacheWeight({ claude: { cacheWeight: 3 } }), DEFAULT_CACHE_WEIGHT, 'out of range is not a weight');
});

test('the cache weight is fitted from a real limit hit, not guessed', () => {
  // A hit at 10:00 after 4 hours: 400 work tokens and 6,000 cache reads
  // reached a 1,000-token ceiling -> 600 / 6,000 = 0.1.
  const rows = [6, 7, 8, 9].map((h) => row('2026-11-20', h, 100, { cache_read_tokens: 1_500 }));
  const fitted = fitCacheWeight({ rows, hits: ['2026-11-20T10:00:00Z'], ceiling: 1_000 });
  assert.equal(fitted.weight, 0.1);
  assert.equal(fitted.samples, 1);
  assert.equal(fitted.residuals.length, 1);
  assert.equal(fitted.residuals[0].error, 0);

  assert.match(fitCacheWeight({ rows, hits: [], ceiling: 1_000 }).error, /no limit hit/);
  assert.match(fitCacheWeight({ rows, hits: ['2026-11-20T10:00:00Z'], ceiling: null }).error, /ceiling/);
  const noCache = fitCacheWeight({
    rows: [row('2026-11-20', 9, 100, { cache_read_tokens: 0 })],
    hits: ['2026-11-20T10:00:00Z'], ceiling: 1_000,
  });
  assert.match(noCache.error, /no cache reads/);
  // A hit that reached the ceiling with work alone fits no positive weight.
  const workOnly = fitCacheWeight({
    rows: [row('2026-11-20', 9, 2_000)],
    hits: ['2026-11-20T10:00:00Z'], ceiling: 1_000,
  });
  assert.match(workOnly.error, /no cache reads/);
});

test('a fitted weight replaces the prior only when both ceiling and hit exist', () => {
  const rows = [6, 7, 8, 9].map((h) => row('2026-11-20', h, 100, { cache_read_tokens: 1_500 }));
  const fitted = collectLimits({
    rows, now: new Date('2026-11-20T11:00:00Z'), runUsage: () => ({}),
    readConfig: () => ({ claude: { window5h: 1_000 } }),
    findHits: () => ['2026-11-20T10:00:00Z'],
  });
  assert.equal(fitted.claude.quota.source, 'fitted');
  assert.equal(fitted.claude.quota.weight, 0.1);
  // Same four hourly buckets: 400 work + 0.1 x 6,000 cache = the 1,000 ceiling.
  assert.equal(fitted.claude.window5h.quota, 1_000);

  const prior = collectLimits({
    rows, now: new Date('2026-11-20T11:00:00Z'), runUsage: () => ({}),
    readConfig: () => ({}), findHits: () => ['2026-11-20T10:00:00Z'],
  });
  assert.equal(prior.claude.quota.source, 'prior', 'no ceiling in limits.json: never invent one');
  assert.match(prior.claude.quota.error, /ceiling/);

  const manual = collectLimits({
    rows, now: new Date('2026-11-20T11:00:00Z'), runUsage: () => ({}),
    readConfig: () => ({ claude: { cacheWeight: 0.05 } }), findHits: () => [],
  });
  assert.equal(manual.claude.quota.source, 'manual');
  assert.equal(manual.claude.quota.weight, 0.05);
});

test('dry run does not ask the accounts', async () => {
  const { limitsForRun } = await import('../lib/costs.mjs');
  let called = false;
  const dry = limitsForRun({ rows: [], now: NOW, write: false, runUsage: () => { called = true; return USAGE; },
    readConfig: () => ({}), findHits: () => [] });
  assert.equal(called, false);
  assert.equal(dry.codex, null);
  assert.match(dry.error, /--write/);
  const wet = limitsForRun({ rows: [], now: NOW, write: true, runUsage: () => USAGE, readConfig: () => ({}), findHits: () => [] });
  assert.equal(wet.codex.plan, 'plus');
});

test('limits snapshot shape', () => {
  const limits = collectLimits({
    rows: [row('2026-11-23', 18, 40)], now: NOW,
    runUsage: () => USAGE, readConfig: () => ({ claude: { plan: 'pro' } }), findHits: () => [],
  });
  assert.equal(limits.measuredAt, NOW.toISOString());
  assert.equal(limits.codex.plan, 'plus');
  assert.equal(limits.codex.windows[0].usedPercent, 12);
  assert.deepEqual(limits.go.map((m) => m.model), ['gpt-6-luna', 'iceman-contributor-free']);
  assert.equal(limits.go[0].pct, 0.099);
  assert.equal(limits.claude.window5h.tokens, 40);
  assert.equal(limits.claude.plan, 'pro');
  assert.equal(limits.claude.reference, null);
  assert.equal(limits.error, null);
});

const ledgerWith = (rows, limits, generatedAt = NOW.toISOString()) => ({ schemaVersion: 2, generatedAt, sources: {}, rows, limits });
const agentRow = (agent, date, work, cacheRead = 0) => ({
  ...row(date, 12, work), agent, source: agent, cache_read_tokens: cacheRead,
});

test('reset window is not reported as used', () => {
  const limits = collectLimits({ rows: [], now: NOW, readConfig: () => ({}), findHits: () => [],
    runUsage: () => ({ codex: { summary: { plan: 'plus', windows: [
      { label: 'weekly', usedPercent: 90, resetsAt: '2026-11-23T19:00:00Z', windowMins: 10080 }] } } }) });
  const codex = buildCostsView(ledgerWith([], limits), NOW).room.find((r) => r.agent === 'codex');
  assert.equal(codex.state, 'reset');
  assert.equal(codex.pct, null);
});

test('high state at 80 percent and go rows merged by model', () => {
  const limits = collectLimits({ rows: [], now: NOW, readConfig: () => ({}), findHits: () => [],
    runUsage: () => ({ opencode: { models: [
      { model: 'deepseek', pct: 0.5, cost: 50, limit: 100 }, { model: 'deepseek', pct: 0.35, cost: 35, limit: 100 }] } }) });
  const go = buildCostsView(ledgerWith([], limits), NOW).room.filter((r) => r.agent === 'opencode');
  assert.equal(go.length, 1);
  assert.equal(go[0].state, 'high');
  assert.ok(Math.abs(go[0].pct - 0.85) < 1e-9);
  assert.equal(go[0].source, 'estimated');
});

test('claude rows use the record when there is no plan reference', () => {
  const rows = Array.from({ length: 10 }, (_, h) => row('2026-11-23', 10 + h, h === 3 ? 100 : 10));
  const limits = collectLimits({ rows, now: NOW, readConfig: () => ({}), findHits: () => [], runUsage: () => ({}) });
  const claude5h = buildCostsView(ledgerWith(rows, limits), NOW).room.find((r) => r.id === 'claude-5h');
  assert.equal(claude5h.pct, null);
  assert.equal(claude5h.source, 'record');
  assert.ok(Math.abs(claude5h.recordPct - 50 / 140) < 1e-9);
});

test('own record never raises the alarm; the view has no ranking', () => {
  const rows = Array.from({ length: 10 }, (_, h) => row('2026-11-23', 10 + h, 10));
  const limits = collectLimits({ rows, now: NOW, readConfig: () => ({}), findHits: () => [], runUsage: () => ({}) });
  const view = buildCostsView(ledgerWith(rows, limits), NOW);
  const week = view.room.find((r) => r.id === 'claude-week');
  assert.equal(week.recordPct, 1);
  assert.equal(week.state, 'ok');
  assert.equal(view.ranking, undefined);
});

test('codex undisclosed totals count as work', () => {
  assert.equal(workTokens({ unknown_tokens: 500, cache_read_tokens: 9 }), 500);
});

test('view without limits snapshot', () => {
  const rows = [agentRow('claude', '2026-11-23', 10), agentRow('claude', '2026-11-18', 20), agentRow('claude', '2026-11-01', 40)];
  const view = buildCostsView(ledgerWith(rows, undefined), NOW);
  assert.equal(view.noLimits, true);
  assert.deepEqual(view.room, []);
});

test('account windows take precedence and missing subscription windows remain unknown', () => {
  const reading = { usedPercent: 73, resetsAt: '2026-11-26T00:00:00Z' };
  const limits = collectLimits({
    now: NOW, runUsage: () => USAGE, readConfig: () => ({ opencode: { plan: 'go' }, claude: { plan: 'pro' } }),
    findHits: () => [],
  });
  limits.subscription = {
    goManual: { measuredAt: NOW.toISOString(), windows: [{ ...reading, label: 'week' }] },
    claude: { measuredAt: NOW.toISOString(), windows: [{ ...reading, label: 'week' }] },
  };
  const view = buildCostsView(ledgerWith([], limits), NOW);
  assert.equal(view.detectedPlans.codex, 'plus');
  assert.equal(view.configuredPlans.opencode, 'go');
  assert.equal(view.room.find((r) => r.id === 'opencode-week').pct, 0.73);
  assert.equal(view.room.find((r) => r.id === 'opencode-week').source, 'manual');
  assert.equal(view.room.find((r) => r.id === 'claude-7d').source, 'measured');
  assert.equal(view.room.filter((r) => r.label === 'month' && r.source === 'unavailable').length, 3);
  assert.ok(!view.room.some((r) => r.id === 'opencode-gpt-6-luna'));
});

test('stale flag', () => {
  assert.equal(buildCostsView(ledgerWith([], undefined, '2026-11-23T13:00:00Z'), NOW).stale, true);
  assert.equal(buildCostsView(ledgerWith([], undefined, '2026-11-23T19:00:00Z'), NOW).stale, false);
  assert.equal(buildCostsView(ledgerWith([], undefined, null), NOW).stale, true);
});

test('markdown report lists the limits reading', async () => {
  const { renderCostsMarkdown } = await import('../lib/costs.mjs');
  const limits = collectLimits({ rows: [], now: NOW, readConfig: () => ({}), findHits: () => [], runUsage: () => USAGE });
  const md = renderCostsMarkdown(ledgerWith([], limits));
  assert.match(md, /^## Límites$/m);
  assert.match(md, /Codex · semanal \| 12%/);
  assert.match(md, /gpt-6-luna \| 9\.9%/);
  assert.doesNotMatch(renderCostsMarkdown(ledgerWith([], undefined)), /^## Límites$/m);
  const dup = collectLimits({ rows: [], now: NOW, readConfig: () => ({}), findHits: () => [],
    runUsage: () => ({ opencode: { models: [{ model: 'ds', pct: 0.003, cost: 0.3, limit: 100 }, { model: 'ds', pct: 0.001, cost: 0.1, limit: 100 }] } }) });
  const dupMd = renderCostsMarkdown(ledgerWith([], dup));
  assert.equal((dupMd.match(/OpenCode Go · ds/g) || []).length, 1);
  assert.match(dupMd, /\$0\.40 de \$100/);
});

test('limits survive a failing hubctl', () => {
  const limits = collectLimits({
    rows: [row('2026-11-23', 18, 40)], now: NOW,
    runUsage: () => { throw new Error('hubctl not found'); }, readConfig: () => ({}), findHits: () => [],
  });
  assert.equal(limits.codex, null);
  assert.equal(limits.go, null);
  assert.match(limits.error, /hubctl not found/);
  assert.equal(limits.claude.window5h.tokens, 40);
});
