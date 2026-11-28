// The notes page: three notes, one page, links that survive dist/.
//
//   node --test workspaces-panel/tool/test/

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import { NOTES, readNotes, renderNotesPage } from '../page/notes.mjs';

const note = (id, file, markdown, title = id[0].toUpperCase() + id.slice(1)) => ({
  id, file, markdown, title, kicker: '', absolute: `D:\\W\\working\\${file}`,
});

test('notes page: every note is a section with an anchor and a source link', () => {
  const html = renderNotesPage({
    generatedAt: '2026-11-24 04:26 UTC',
    notes: [note('roadmap', 'ROADMAP.md', '# ROADMAP\n\n## Small Apps\n\n- uno\n'), note('handoff', 'HANDOFF.md', '# Handoff\n\ntexto\n')],
  });
  assert.match(html, /<section id="roadmap" class="card doc">/);
  assert.match(html, /<section id="handoff" class="card doc">/);
  assert.match(html, /href="#roadmap">Roadmap<\/a>/);
  assert.match(html, /href="file:\/\/\/D:\/W\/working\/ROADMAP\.md"/);
  assert.ok(!html.includes('<!--NOTES-->') && !html.includes('<!--SHELL-->'));
  assert.ok(!html.includes('{{STAMP}}') && !html.includes('{{NOTES_CURRENT}}'));
  assert.ok(!html.includes('id="lang"'), 'one-language page drops the ES/EN selector');
  assert.ok(html.includes('2026-11-24 04:26 UTC'));
});

test('notes page: the Notas tab is current and the script parses', () => {
  const html = renderNotesPage({ notes: [note('roadmap', 'ROADMAP.md', '# R\n\ntexto\n')] });
  assert.match(html, /<a id="tabNotes" href="notes\.html" aria-current="page">/);
  assert.match(html, /<a id="tabRepos" href="index\.html">/);
  const script = readFileSync(new URL('../page/notes.js', import.meta.url), 'utf8');
  assert.doesNotThrow(() => new Function(script));
});

test('notes page: sibling note links become anchors, other paths file:// URLs', () => {
  const html = renderNotesPage({
    notes: [
      note('roadmap', 'ROADMAP.md', '# R\n\nVer [HANDOFF](HANDOFF.md) y [AGENTS](../../AGENTS.md).\n'),
      note('handoff', 'HANDOFF.md', '# H\n\nnada\n'),
    ],
  });
  assert.match(html, /href="#handoff">HANDOFF<\/a>/);
  assert.match(html, /href="file:\/\/\/[A-Za-z]:[^"]*AgenticHub[^"]*AGENTS\.md"|href="file:\/\/\/D:\/W\/AGENTS\.md"/);
});

test('readNotes: a missing file renders a line instead of failing the build', () => {
  const notes = readNotes('D:\\no-existe\\working');
  assert.equal(notes.length, NOTES.length);
  for (const n of notes) assert.match(n.markdown, /No se encontró/);
  assert.doesNotThrow(() => renderNotesPage({ notes }));
});

// The owner's notes live in a private nested repo: a public clone has none.
const noPrivateNotes = !existsSync(new URL('../../working/ROADMAP.md', import.meta.url)) && 'no private notes in this clone';

test('the real notes render (no tables, no fences: this is the regression)', { skip: noPrivateNotes }, () => {
  const html = renderNotesPage({ generatedAt: 'now' });
  for (const id of NOTES.map((n) => n.id)) assert.match(html, new RegExp(`<section id="${id}" class="card doc">`));
  assert.match(html, /<section id="roadmap"[\s\S]*?<article class="proj">/, 'the roadmap projects are in the page');
  assert.ok(!html.includes('<p>undefined</p>'));
});

test('the shell stays in one language per page', () => {
  const shell = readFileSync(new URL('../page/shared/shell.js', import.meta.url), 'utf8');
  assert.ok(shell.includes('pageNotes'));
  for (const lang of ['es', 'en']) assert.ok(shell.includes(`${lang}: {`));
});

// --- roadmap as projects, tags, linked assets --------------------------------

const ROADMAP = '# ROADMAP\n\n## Small Apps\n\n### Music App\n- **Dueño:** instalar.\n- **Siguiente:** nada.\n\n### RSS Reader\n- **Límite:** local.\n- **Después:** sync.\n\n## Big apps\n\n### Fitness App\ntexto\n';

test('notes_page_links_assets_instead_of_inlining', () => {
  const html = renderNotesPage({ notes: [note('roadmap', 'ROADMAP.md', ROADMAP)] });
  assert.ok(!html.includes('/*NOTES_CSS*/') && !html.includes('/*NOTES_SCRIPT*/'));
  assert.ok(!html.includes('<style>'), 'no inline stylesheet');
  assert.match(html, /<link rel="stylesheet" href="shared\/notes\.css\?v=[0-9a-f]{10}">/);
  assert.match(html, /<script src="shared\/notes\.js\?v=[0-9a-f]{10}"><\/script>/);
  assert.ok(html.indexOf('shared/shell.js') < html.indexOf('shared/notes.js'), 'shell.js loads first');
});

test('roadmap_projects_are_articles_without_a_chips_index', () => {
  const html = renderNotesPage({ notes: [note('roadmap', 'ROADMAP.md', ROADMAP)] });
  assert.equal((html.match(/<article class="proj"/g) || []).length, 3);
  assert.equal((html.match(/<\/article>/g) || []).length, 3);
  assert.match(html, /<article class="proj"[^>]*>\s*<h4 id="roadmap--music-app">Music App<\/h4>/);
  assert.ok(!html.includes('doc-toc'), 'the roadmap has no fixed row of chips');
});

test('roadmap_headings_link_to_the_project_folder', () => {
  const md = [
    '# R', '',
    '### Map App (`code\\web-app\\map-app`)', '- **Siguiente:** x', '',
    '### Inventado (`code\\no-existe`)', '- **Siguiente:** y', '',
  ].join(String.fromCharCode(10));
  // A throwaway workspace instead of this machine's folders (local/roots.json).
  const ws = mkdtempSync(join(tmpdir(), 'roots-'));
  mkdirSync(join(ws, 'web-app', 'map-app'), { recursive: true });
  const roots = { 'code\\': ws.replace(/\\/g, '/') };
  const html = renderNotesPage({ notes: [note('roadmap', 'ROADMAP.md', md)], roots });
  assert.match(html, new RegExp(`<a class="proj-path" href="${pathToFileURL(join(ws, 'web-app', 'map-app')).href.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`));
  assert.match(html, /href="[^"]*map-app"[^>]*><code>code\\web-app\\map-app<\/code><\/a>/);
  assert.ok(!html.includes('no-existe</a>'), 'una carpeta que no existe no se enlaza');
});

test('owner_label_gets_tag_class', () => {
  const html = renderNotesPage({ notes: [note('roadmap', 'ROADMAP.md', ROADMAP)] });
  assert.match(html, /<strong class="tag tag-owner">Dueño:<\/strong>/);
  assert.match(html, /<strong class="tag tag-next">Siguiente:<\/strong>/);
  assert.match(html, /<strong class="tag tag-limit">Límite:<\/strong>/);
  assert.match(html, /<strong class="tag tag-later">Después:<\/strong>/);
});

test('priority_level_gets_a_coloured_pill', () => {
  const md = '# R\n\n### P\n- **Prioridad:** P1 — producto principal.\n';
  const html = renderNotesPage({ notes: [note('roadmap', 'ROADMAP.md', md)] });
  assert.match(html, /<strong class="tag tag-priority">Prioridad:<\/strong> <span class="prio prio-p1">P1<\/span>/);
  assert.ok(!html.includes('prio-p4'), 'only P0–P3 are levels');
});

test('other_notes_keep_their_group_index', () => {
  const html = renderNotesPage({ notes: [note('handoff', 'HANDOFF.md', '# H\n\n## A\n\n### Sub\n\ntexto\n')] });
  assert.ok(!html.includes('<article class="proj"'));
  assert.ok(!html.includes('doc-toc'));
});
