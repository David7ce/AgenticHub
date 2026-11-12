import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import {
  cacheAgeMs, describeLimits, dropReset, queryCodexLimits, readLimitsCache, summarizeLimits, windowLabel, writeLimitsCache,
} from '../codex-limits.mjs';

const WEEKLY = { usedPercent: 74, windowDurationMins: 10080, resetsAt: 1794617615 };
const FIVE_H = { usedPercent: 12, windowDurationMins: 300, resetsAt: 1794500000 };

test('windowLabel names the common windows', () => {
  assert.equal(windowLabel(10080), 'weekly');
  assert.equal(windowLabel(300), '5h');
  assert.equal(windowLabel(1440), '1d');
  assert.equal(windowLabel(45), '45min');
  assert.equal(windowLabel(null), 'window');
});

test('summarizeLimits: a Plus plan reports only a weekly window', () => {
  const s = summarizeLimits({ rateLimits: { planType: 'plus', primary: WEEKLY, secondary: null, credits: { hasCredits: false, unlimited: false } }, ordinaryUsageAllowed: true });
  assert.equal(s.plan, 'plus');
  assert.equal(s.windows.length, 1);
  assert.equal(s.windows[0].label, 'weekly');
  assert.equal(s.windows[0].usedPercent, 74);
  assert.equal(s.windows[0].resetsAt, '2026-11-14T00:53:35.000Z');
  assert.deepEqual(s.credits, { has: false, unlimited: false });
});

test('summarizeLimits keeps both windows when the plan has two and picks the weekly one as main', () => {
  const s = summarizeLimits({ rateLimits: { planType: 'pro', primary: FIVE_H, secondary: WEEKLY } });
  assert.deepEqual(s.windows.map((w) => w.label), ['5h', 'weekly']);
  assert.match(describeLimits(s), /^pro · 5h 12% \(reinicia .*\) · semanal 74% \(reinicia .*\)$/);
});

test('summarizeLimits and describeLimits tolerate an empty answer', () => {
  assert.equal(summarizeLimits({}), null);
  assert.equal(describeLimits({ windows: [] }), null);
});

test('dropReset removes the windows that already reset and returns null when none is left', () => {
  const cache = summarizeLimits({ rateLimits: { primary: FIVE_H, secondary: WEEKLY } });
  const afterFiveH = Date.parse('2026-11-12T00:00:00Z'); // FIVE_H resets at 16:13Z
  assert.equal(dropReset(cache, afterFiveH).windows.length, 2);
  const later = Date.parse('2026-11-12T17:00:00Z');
  assert.deepEqual(dropReset(cache, later).windows.map((w) => w.label), ['weekly']);
  assert.equal(dropReset(cache, Date.parse('2026-11-14T10:00:00Z')), null);
  assert.equal(dropReset(null), null);
  assert.equal(dropReset({ windows: [{ usedPercent: 5, resetsAt: null }] }, 0).windows.length, 1); // no reset time: kept
});

test('the cache round-trips and reports its age', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'codex-limits-')), 'logs', 'codex-limits.json');
  assert.equal(readLimitsCache(path), null);
  const summary = summarizeLimits({ rateLimits: { planType: 'plus', primary: WEEKLY } });
  const now = new Date('2026-11-12T10:00:00Z');
  writeLimitsCache(path, summary, now);
  const cache = readLimitsCache(path);
  assert.equal(cache.windows[0].usedPercent, 74);
  assert.equal(cacheAgeMs(cache, now.getTime() + 90_000), 90_000);
  assert.equal(cacheAgeMs(null), Infinity);
});

// A fake `codex app-server` that answers over stdio, to test the protocol dance without Codex.
function fakeServer(answer) {
  return () => {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.kill = () => { child.killed = true; };
    let buffer = '';
    child.stdin.on('data', (chunk) => {
      buffer += chunk;
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const msg = JSON.parse(buffer.slice(0, nl));
        buffer = buffer.slice(nl + 1);
        if (msg.id == null) continue;
        child.stdout.write(`${JSON.stringify(answer(msg))}\n`);
      }
    });
    fakeServer.last = child;
    return child;
  };
}

test('queryCodexLimits runs initialize then account/rateLimits/read and stops the server', async () => {
  const seen = [];
  const out = await queryCodexLimits({
    timeoutMs: 2000,
    spawnImpl: fakeServer((msg) => {
      seen.push(msg.method);
      return msg.method === 'initialize'
        ? { jsonrpc: '2.0', id: msg.id, result: {} }
        : { jsonrpc: '2.0', id: msg.id, result: { rateLimits: { planType: 'plus', primary: WEEKLY } } };
    }),
  });
  assert.deepEqual(seen, ['initialize', 'account/rateLimits/read']);
  assert.equal(out.ok, true);
  assert.equal(out.summary.windows[0].usedPercent, 74);
  assert.equal(fakeServer.last.killed, true);
});

test('queryCodexLimits reports an error answer, a spawn failure and a silent server', async () => {
  const bad = await queryCodexLimits({ timeoutMs: 2000, spawnImpl: fakeServer((m) => ({ jsonrpc: '2.0', id: m.id, error: { message: 'not logged in' } })) });
  assert.deepEqual(bad, { ok: false, error: 'not logged in' });
  const thrown = await queryCodexLimits({ spawnImpl: () => { throw new Error('ENOENT'); } });
  assert.deepEqual(thrown, { ok: false, error: 'ENOENT' });
  const silent = await queryCodexLimits({
    timeoutMs: 80,
    spawnImpl: () => { const c = new EventEmitter(); c.stdin = new PassThrough(); c.stdout = new PassThrough(); c.kill = () => {}; return c; },
  });
  assert.equal(silent.ok, false);
  assert.match(silent.error, /no answer/);
});

import { needsRefresh } from '../codex-limits.mjs';
test('needsRefresh: only when the reading is old and the last attempt is not recent', () => {
  const NOW = Date.parse('2026-11-12T12:00:00Z');
  const cache = (minutesAgo) => ({ measuredAt: new Date(NOW - minutesAgo * 60_000).toISOString(), windows: [] });
  assert.equal(needsRefresh({ cache: null, now: NOW }), true); // nothing yet
  assert.equal(needsRefresh({ cache: cache(5), now: NOW }), false); // fresh
  assert.equal(needsRefresh({ cache: cache(45), now: NOW }), true); // old
  assert.equal(needsRefresh({ cache: cache(45), lastTryMs: NOW - 2 * 60_000, now: NOW }), false); // tried two minutes ago
  assert.equal(needsRefresh({ cache: cache(45), lastTryMs: NOW - 20 * 60_000, now: NOW }), true); // that try was long ago
});
