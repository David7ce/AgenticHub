// The Inicio page: the numbers it summarises and the page it renders.
//
//   node --test projects/tool/test/

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
