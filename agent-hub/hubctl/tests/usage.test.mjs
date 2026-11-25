import test from 'node:test';
import assert from 'node:assert/strict';

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { estimateGo, humanTokens, opencodeStatsCommand } from '../hubctl.mjs';
import { codexUsage } from '../commands/usage.mjs';

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

test('OpenCode stats is read natively on Windows, not through WSL', () => {
  const win = opencodeStatsCommand({ platform: 'win32', comspec: 'cmd.exe', days: 7 });
  assert.equal(win.command, 'cmd.exe');
  assert.ok(!win.args.some((arg) => String(arg).includes('wsl')));
  assert.match(win.args.at(-1), /^"opencode" stats --days 7 --cost --models --json$/);
  const linux = opencodeStatsCommand({ platform: 'linux', days: 1 });
  assert.equal(linux.command, 'opencode');
  assert.deepEqual(linux.args, ['stats', '--days', '1', '--cost', '--models', '--json']);
});

test('token counts are formatted for the table', () => {
  assert.equal(humanTokens(1_500_000), '1.5M');
  assert.equal(humanTokens(2_400), '2k');
  assert.equal(humanTokens(42), '42');
  assert.equal(humanTokens(1_200_000_000), '1.2G');
});

test('codexUsage: a live reading is cached; a failed one falls back to the cache and says why', async () => {
  const path = join(mkdtempSync(join(tmpdir(), 'codex-usage-')), 'logs', 'codex-limits.json');
  const summary = { plan: 'plus', windows: [{ slot: 'primary', label: 'weekly', usedPercent: 74, windowMins: 10080, resetsAt: null }], reached: null };
  const now = new Date('2026-11-12T12:00:00Z');
  const live = await codexUsage({ path, now, query: async () => ({ ok: true, summary }) });
  assert.equal(live.source, 'live');
  assert.equal(live.summary.windows[0].usedPercent, 74);
  const down = await codexUsage({ path, now, query: async () => ({ ok: false, error: 'not logged in' }) });
  assert.equal(down.source, 'cache');
  assert.equal(down.error, 'not logged in');
  assert.equal(down.summary.windows[0].usedPercent, 74);
  const none = await codexUsage({ path: join(path, '..', 'missing.json'), now, query: async () => ({ ok: false, error: 'x' }) });
  assert.equal(none.source, null);
  assert.equal(none.summary, null);
  const offline = await codexUsage({ live: false, path, now });
  assert.equal(offline.source, 'cache');
});
