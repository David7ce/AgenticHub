// The Inicio page: the numbers it summarises and the page it renders.
//
//   node --test workspaces-panel/tool/test/

import assert from 'node:assert/strict';
import test from 'node:test';

import { renderHomePage, summarizeHome } from '../page/home.mjs';

const note = (id, markdown) => ({ id, markdown });
const ROADMAP = `# ROADMAP

## Small Apps

### Music App
- **Dueño:** instalar.
- **Siguiente:** nada.

### RSS Reader
- **Dueño:** probar.

## Big apps

### Fitness App
Texto.
`;

test('summary_counts_repos', () => {
  const rows = [
    { remote: 'git@x', dirty: 2, ahead: 0 },
    { remote: 'git@y', dirty: 0, ahead: 3 },
    { remote: '', dirty: 0, ahead: 0 },
  ];
  assert.deepEqual(summarizeHome({ rows }).repos, { total: 3, dirty: 1, ahead: 1, noRemote: 1 });
});

test('summary_roadmap_counts_projects_and_owner_items', () => {
  const s = summarizeHome({ notes: [note('roadmap', ROADMAP)] });
  assert.deepEqual(s.roadmap, { open: 3, owner: 2 });
});

test('summary_reads_ia_windows', () => {
  const s = summarizeHome({
    usageSummary: { agents: [{ agent: 'claude', work_tokens: 1500 }, { agent: 'codex', work_tokens: 0 }] },
    limits: { codex: { windows: [{ label: 'weekly', usedPercent: 12 }] }, claude: { week: { tokens: 14389029 } } },
  });
  assert.deepEqual(s.ia, { agents: [{ agent: 'claude', workTokens: 1500 }, { agent: 'codex', workTokens: 0 }], codexWeeklyPct: 12, claudeWeek: 14389029 });
});

test('summary_weekly_subscriptions_show_tokens_reading_and_seven_days', () => {
  const now = new Date('2026-11-27T12:00:00Z');
  const rows = [
    { date: '2026-11-26', agent: 'claude', source: 'claude-code', model: 'claude-sonnet-5-5', input_tokens: 100, output_tokens: 50, cache_write_tokens: 10 },
    { date: '2026-11-27', agent: 'opencode', source: 'opencode', model: 'deepseek-v4.1-flash (opencode-go)', input_tokens: 20, output_tokens: 10 },
    { date: '2026-11-27', agent: 'opencode', source: 'opencode', model: 'free-model (opencode)', input_tokens: 5, output_tokens: 5 },
    { date: '2026-11-27', agent: 'codex', source: 'codex', model: 'gpt (openai)', input_tokens: 7 },
  ];
  const limits = {
    codex: { plan: 'plus', measuredAt: '2026-11-27T00:00:00Z', windows: [{ label: 'weekly', usedPercent: 29, windowMins: 10080 }] },
    claude: { plan: 'pro', window5h: { tokens: 10, quota: 10 }, week: { tokens: 160, quota: 160 }, reference: { week: 800 } },
    goPlan: 'go',
    subscription: { goModels: [], goManual: null },
  };
  const s = summarizeHome({ usageRows: rows, limits, now });
  assert.equal(s.weekly.dates.length, 7);
  assert.equal(s.weekly.dates.at(-1), '2026-11-27');
  const codex = s.weekly.items.find((i) => i.agent === 'codex');
  const claude = s.weekly.items.find((i) => i.agent === 'claude');
  const go = s.weekly.items.find((i) => i.agent === 'opencode');
  const zen = s.weekly.items.find((i) => i.agent === 'zen');
  assert.deepEqual([codex.tokens, codex.pct, codex.pctKind], [7, 0.29, 'measured']);
  assert.deepEqual([claude.tokens, claude.pct, claude.pctKind], [160, 0.2, 'estimated']);
  assert.deepEqual([go.tokens, go.pct], [30, null]);
  assert.deepEqual([zen.tokens, zen.pct, zen.pctKind], [10, null, 'free']);
  assert.equal(codex.days.length, 7);
  assert.equal(zen.days.at(-1), 10);
});

test('empty_ledger_and_null_limits_do_not_throw', () => {
  const s = summarizeHome({});
  assert.deepEqual(s.repos, { total: 0, dirty: 0, ahead: 0, noRemote: 0 });
  assert.deepEqual(s.roadmap, { open: 0, owner: 0 });
  assert.equal(s.ia.codexWeeklyPct, null);
  assert.equal(s.ia.claudeWeek, null);
  const html = renderHomePage(s);
  assert.ok(!html.includes('NaN') && !html.includes('undefined'));
});

test('missing_roadmap_note_counts_zero', () => {
  const s = summarizeHome({ notes: [note('roadmap', '_No se encontró `ROADMAP.md`._')] });
  assert.deepEqual(s.roadmap, { open: 0, owner: 0 });
});

test('home_has_no_handoff_or_journal_tiles', () => {
  const html = renderHomePage(summarizeHome({}));
  assert.ok(!/notes\.html#(handoff|journal)/.test(html));
  assert.ok(!/Handoff|Journal/.test(html));
});

test('home_has_no_folders_or_published_sections', () => {
  const html = renderHomePage(summarizeHome({}));
  assert.ok(!html.includes('file:///D:/Workspaces/'));
  assert.ok(!/Carpetas|Publicado|Git-clones|\bWorks\b/.test(html));
});

test('home_links_cards_to_pages_through_dist', () => {
  const html = renderHomePage(summarizeHome({}));
  for (const href of ['dist/index.html', 'dist/ai-usage.html', 'dist/notes.html#roadmap']) {
    assert.ok(html.includes(`href="${href}"`), href);
  }
  assert.match(html, /<a id="brandHome" class="brand" href="index\.html" aria-current="page"/);
  assert.match(html, /href="dist\/shared\/home\.css\?v=[0-9a-f]{10}"/);
  assert.match(html, /src="dist\/shared\/home\.js\?v=[0-9a-f]{10}"/);
});

test('home_data_block_parses_and_escapes_script_end', () => {
  const html = renderHomePage({ ...summarizeHome({}), generatedAt: '</script>x' });
  const data = html.match(/<script>\s*(const HOME = [\s\S]*?);\s*<\/script>/)[1];
  assert.doesNotThrow(() => new Function(`${data}; return HOME;`)());
  assert.ok(!html.includes('</script>x'));
});

test('home_script_parses_and_has_matching_copy_keys', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('../page/home.js', import.meta.url), 'utf8');
  assert.doesNotThrow(() => new Function(source));
  const html = readFileSync(new URL('../page/home.html', import.meta.url), 'utf8');
  const keys = [...html.matchAll(/data-k="(\w+)"/g)].map((m) => m[1]);
  for (const lang of ['es', 'en']) {
    const block = source.slice(source.indexOf(`  ${lang}: {`), source.indexOf('  },', source.indexOf(`  ${lang}: {`)));
    for (const key of keys) assert.ok(new RegExp(`\\b${key}:`).test(block), `${lang} copy has ${key}`);
  }
});
