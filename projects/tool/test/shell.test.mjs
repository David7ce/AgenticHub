// The shared Workspaces shell: copy parity and storage that may throw.
//
//   node --test projects/tool/test/

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

import { renderPage } from '../page/render.mjs';
import { renderCostsPage } from '../page/costs-render.mjs';
import { renderNotesPage } from '../page/notes.mjs';
import { SHARED_ASSETS, readShared, sharedAssets, sharedTags, writeSharedAssets } from '../page/shared.mjs';

const shellSource = readFileSync(new URL('../page/shared/shell.js', import.meta.url), 'utf8');

function loadShell(localStorage) {
  const context = { localStorage };
  vm.runInNewContext(`${shellSource}\nthis.SHELL_COPY = SHELL_COPY;`, context);
  return context;
}

test('shell_copy_parity', () => {
  const c = loadShell({ getItem: () => null, setItem: () => {} });
  assert.deepEqual(Object.keys(c.SHELL_COPY.es).sort(), Object.keys(c.SHELL_COPY.en).sort());
});

test('shell_defaults_to_spanish_and_reads_stored_language', () => {
  assert.equal(loadShell({ getItem: () => null, setItem: () => {} }).shellLang(), 'es');
  assert.equal(loadShell({ getItem: (k) => (k === 'lang' ? 'en' : null), setItem: () => {} }).shellLang(), 'en');
  assert.equal(loadShell({ getItem: () => 'fr', setItem: () => {} }).shellLang(), 'es');
});

test('shell_survives_throwing_storage', () => {
  const boom = () => { throw new Error('denied'); };
  const c = loadShell({ getItem: boom, setItem: boom });
  assert.equal(c.shellLang(), 'es');
  assert.doesNotThrow(() => c.writeStored('lang', 'en'));
  assert.equal(c.readStored('lang'), null);
});

const placeholders = ['<!--SHARED_CSS-->', '<!--SHARED_JS-->', '<!--SHELL-->'];

test('renderPage: shared shell with the Repos tab current', () => {
  const html = renderPage([], [], { root: 'D:\W', generatedAt: 'now', author: 'a@b', toolDir: 'D:\t' }, null);
  for (const p of placeholders) assert.ok(!html.includes(p), `${p} replaced`);
  assert.match(html, /<a id="tabRepos" href="index\.html" aria-current="page">/);
  assert.match(html, /<a id="tabIa" href="ai-usage\.html">/);
  assert.match(html, /<a id="tabNotes" href="notes\.html">/);
  for (const asset of ['tokens.css', 'base.css', 'shell.css', 'calendar.css']) {
    assert.match(html, new RegExp(`<link rel="stylesheet" href="shared/${asset.replace('.', '\\.')}\\?v=[0-9a-f]{10}">`));
  }
  for (const asset of ['shell.js', 'format.js', 'calendar.js']) {
    assert.match(html, new RegExp(`<script src="shared/${asset.replace('.', '\\.')}\\?v=[0-9a-f]{10}"></script>`));
  }
  assert.ok(!html.includes('/* tokens.css'), 'the palette is not inlined any more');
  assert.match(html, /<details class="card cal" id="calendar" open>\s*<summary><span data-cal="title">/);
  assert.ok(!html.includes('<!--CALENDAR-->'));
  assert.ok(!html.includes('<!--SHARED_CSS-->') && !html.includes('shared/style.css'));
});

test('renderCostsPage: shared shell with the IA tab current', () => {
  const html = renderCostsPage({ schemaVersion: 2, rows: [] });
  for (const p of placeholders) assert.ok(!html.includes(p), `${p} replaced`);
  assert.match(html, /<a id="tabIa" href="ai-usage\.html" aria-current="page">/);
  assert.match(html, /<a id="tabRepos" href="index\.html">/);
  const script = html.slice(html.lastIndexOf('<script>') + 8, html.lastIndexOf('</script>'));
  assert.doesNotThrow(() => new Function(script));
});

test('the calendar is only served to pages that show it', () => {
  const notes = renderNotesPage({ notes: [] });
  assert.ok(!notes.includes('calendar.css') && !notes.includes('calendar.js'), 'notes has no calendar');
  assert.match(notes, /shared\/base\.css\?v=[0-9a-f]{10}/);
  assert.match(notes, /shared\/format\.js\?v=[0-9a-f]{10}/);
  const repos = renderPage([], [], { root: 'D:\W', generatedAt: 'now', author: 'a@b', toolDir: 'D:\t' }, null);
  assert.match(repos, /shared\/calendar\.js\?v=[0-9a-f]{10}/);
});

test('the shared assets are written once, with a hash that follows their content', () => {
  const dir = mkdtempSync(join(tmpdir(), 'projects-shared-'));
  try {
    writeSharedAssets(dir);
    for (const name of SHARED_ASSETS) {
      const written = readFileSync(join(dir, 'shared', name), 'utf8');
      assert.equal(written, readShared(name), `${name} byte for byte`);
    }
    const tags = sharedTags();
    assert.match(tags.css, /href="shared\/tokens\.css\?v=[0-9a-f]{10}"/);
    assert.match(tags.js, /src="shared\/shell\.js\?v=[0-9a-f]{10}"/);
    const changed = sharedTags({ assets: sharedAssets().map((a) => ({ ...a, hash: `${a.hash.slice(0, 9)}f` })) });
    assert.notEqual(changed.css, tags.css, 'a different hash changes the URL');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('compact header: no language label, icon-only theme button', () => {
  const c = loadShell({ getItem: () => null, setItem: () => {} });
  for (const lang of ['es', 'en']) {
    assert.ok(!('language' in c.SHELL_COPY[lang]), 'no "Idioma/Language" label');
    assert.equal(c.SHELL_COPY[lang].iconLight, '☀');
    assert.equal(c.SHELL_COPY[lang].iconDark, '☽');
  }
  const html = renderPage([], [], { root: 'D:\W', generatedAt: 'now', author: 'a@b', toolDir: 'D:\t' }, null);
  assert.ok(!html.includes('id="shellLanguage"'));
});

test('language_change_sticks_when_storage_is_blocked', () => {
  const boom = () => { throw new Error('denied'); };
  const c = loadShell({ getItem: boom, setItem: boom });
  c.rememberLang('en');
  assert.equal(c.shellLang(), 'en', 'the calendar reads shellLang(): it must follow the switch');
  c.rememberLang('es');
  assert.equal(c.shellLang(), 'es');
});

// --- Inicio tab, path base, skip link --------------------------------------
import { applyShell } from '../page/shared.mjs';

const META = { root: 'D:\W', generatedAt: 'now', author: 'a@b', toolDir: 'D:\t' };
const pages = () => ({
  repos: renderPage([], [], META, null),
  ia: renderCostsPage({ schemaVersion: 2, rows: [] }),
  notes: renderNotesPage({ notes: [] }),
});

test('brand_links_home_with_an_icon_on_all_pages', () => {
  for (const [name, html] of Object.entries(pages())) {
    assert.match(html, /<a id="brandHome" class="brand" href="\.\.\/index\.html"[^>]*><svg class="brand-icon"[^>]*aria-hidden="true"/, name);
    assert.ok(!html.includes('id="tabHome"'), 'Home is the brand, not a tab');
  }
});

test('home_page_tabs_use_dist_prefix', () => {
  const html = applyShell('<!--SHELL-->', 'home', { base: 'dist/' });
  assert.match(html, /<a id="brandHome" class="brand" href="index\.html" aria-current="page"/);
  assert.match(html, /<a id="tabRepos" href="dist\/index\.html">/);
  assert.match(html, /<a id="tabIa" href="dist\/ai-usage\.html">/);
  assert.match(html, /<a id="tabNotes" href="dist\/notes\.html">/);
});

test('exactly_one_aria_current_per_page', () => {
  for (const [name, html] of Object.entries(pages())) {
    const tabs = html.slice(html.indexOf('id="shellTabs"'), html.indexOf('</nav>', html.indexOf('id="shellTabs"')));
    assert.equal((tabs.match(/aria-current="page"/g) || []).length, 1, name);
  }
});

test('skip_link_targets_content_anchor', () => {
  for (const [name, html] of Object.entries(pages())) {
    assert.match(html, /<a class="skip" href="#content" id="skipLink">/, name);
    assert.match(html, /<span id="content" tabindex="-1"><\/span>/, name);
  }
});

test('shell_copy_names_the_three_tabs_and_the_skip_link', () => {
  const c = loadShell({ getItem: () => null, setItem: () => {} });
  assert.deepEqual([c.SHELL_COPY.en.tabRepos, c.SHELL_COPY.en.tabIa, c.SHELL_COPY.en.tabNotes], ['Projects', 'AI Usage', 'Roadmap']);
  assert.deepEqual([c.SHELL_COPY.es.tabRepos, c.SHELL_COPY.es.tabIa, c.SHELL_COPY.es.tabNotes], ['Proyectos', 'Uso de IA', 'Roadmap']);
  assert.ok(c.SHELL_COPY.es.homeLabel && c.SHELL_COPY.en.homeLabel);
  assert.equal(c.SHELL_COPY.es.skip, 'Saltar al contenido');
  assert.equal(c.SHELL_COPY.en.skip, 'Skip to content');
  assert.ok(c.SHELL_COPY.es.pageHome && c.SHELL_COPY.en.pageHome);
});

test('shared_assets_follow_the_base_prefix', () => {
  const html = applyShell('<!--SHARED_CSS-->', 'home', { base: 'dist/' });
  assert.match(html, /href="dist\/shared\/tokens\.css\?v=[0-9a-f]{10}"/);
  assert.match(applyShell('<!--SHARED_CSS-->', 'ia'), /href="shared\/tokens\.css\?v=/);
});

test('every_page_carries_the_same_icon', () => {
  const all = { ...pages(), home: applyShell('<!--SHARED_CSS-->', 'home', { base: 'dist/' }) };
  for (const [name, html] of Object.entries(all)) {
    assert.equal((html.match(/<link rel="icon"/g) || []).length, 1, name);
  }
});

test('page_without_selector_follows_the_stored_language_but_stays_a_spanish_document', () => {
  const nodes = {};
  const element = () => ({ textContent: '', title: '', value: '', addEventListener() {}, setAttribute() {}, getAttribute: () => null });
  for (const id of ['shellTitle', 'brandText', 'brandHome', 'skipLink', 'tabRepos', 'tabIa', 'tabNotes', 'themeBtn', 'shellStamp']) nodes[id] = element();
  const root = { lang: '', getAttribute: () => null, setAttribute() {} };
  const context = {
    localStorage: { getItem: (k) => (k === 'lang' ? 'en' : null), setItem() {} },
    document: { documentElement: root, title: '', getElementById: (id) => nodes[id] ?? null },
    matchMedia: () => ({ matches: false }),
  };
  vm.runInNewContext(`${shellSource}\nthis.initShell = initShell;`, context);
  context.initShell({ tab: 'notes' });
  assert.equal(nodes.tabNotes.textContent, 'Roadmap');
  assert.equal(nodes.tabRepos.textContent, 'Projects', 'tabs follow the stored English');
  assert.equal(root.lang, 'es', 'the document language stays Spanish');
});
