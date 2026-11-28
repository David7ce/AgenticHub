// The notes' Markdown renderer: headings, lists, emphasis, links and escaping.
//
//   node --test workspaces-panel/tool/test/

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import test from 'node:test';

import { renderMarkdown, slugify } from '../page/md.mjs';

test('headings: the file title goes, the rest keeps an id', () => {
  const { html, headings } = renderMarkdown('# ROADMAP\n\nTexto.\n\n## Small Apps\n\n### Music App (`ruta`)\n', { idPrefix: 'roadmap--' });
  assert.ok(!html.includes('>ROADMAP</h2>'), 'the leading # title is dropped');
  assert.match(html, /<h3 id="roadmap--small-apps">Small Apps<\/h3>/);
  assert.match(html, /<h4 id="roadmap--music-app"><code>ruta<\/code>|Music App/);
  assert.deepEqual(headings.map((h) => h.level), [3, 4]);
});

test('identical headings get distinct ids', () => {
  const { html } = renderMarkdown('## 2026-11-24\n\na\n\n## 2026-11-24\n\nb\n');
  assert.match(html, /id="2026-11-24"/);
  assert.match(html, /id="2026-11-24-2"/);
});

test('slugify strips accents and punctuation', () => {
  assert.equal(slugify('Carta natal/gematría'), 'carta-natal-gematria');
  assert.equal(slugify('`bisect` en \'main\''), 'bisect-en-main');
  assert.equal(slugify('!!!'), '');
});

test('lists nest by indentation and merge continuation lines', () => {
  const { html } = renderMarkdown('- uno\n  sigue aquí\n  - dentro\n- dos\n  con su línea\n');
  assert.match(html, /<ul><li>uno sigue aquí<ul><li>dentro<\/li><\/ul><\/li><li>dos con su línea<\/li><\/ul>/);
});

test('a blank line between items keeps one list', () => {
  const { html } = renderMarkdown('- uno\n\n- dos\n\n- tres\n');
  assert.equal((html.match(/<ul>/g) ?? []).length, 1);
  assert.equal((html.match(/<li>/g) ?? []).length, 3);
});

test('ordered lists and mixed types', () => {
  const { html } = renderMarkdown('1. primero\n2. segundo\n   - anidado\n');
  assert.match(html, /<ol><li>primero<\/li><li>segundo<ul><li>anidado<\/li><\/ul><\/li><\/ol>/);
});

test('bold, italics and inline code', () => {
  const { html } = renderMarkdown('- **Dueño:** ver `dist/index.html` y *después* seguir\n');
  assert.match(html, /<strong>Dueño:<\/strong> ver <code>dist\/index\.html<\/code> y <em>después<\/em> seguir/);
});

test('code spans protect their content', () => {
  const { html } = renderMarkdown('Usa `**no** es negrita` aquí\n');
  assert.match(html, /<code>\*\*no\*\* es negrita<\/code>/);
  assert.ok(!html.includes('<strong>no</strong>'));
});

test('links go through the resolver', () => {
  const seen = [];
  const { html } = renderMarkdown('[AGENTS.md](../../AGENTS.md) y [web](https://example.com/a?b=1&c=2)\n', {
    resolveHref: (href) => {
      seen.push(href);
      return href.startsWith('http') ? href : `file:///D:/resuelto/${href.replace(/\.\.\//g, '')}`;
    },
  });
  assert.deepEqual(seen, ['../../AGENTS.md', 'https://example.com/a?b=1&c=2']);
  assert.match(html, /href="file:\/\/\/D:\/resuelto\/AGENTS.md"/);
  assert.match(html, /href="https:\/\/example\.com\/a\?b=1&amp;c=2"/);
});

test('text and attributes are escaped', () => {
  const { html } = renderMarkdown('Un <script>alert(1)</script> y "comillas"\n');
  assert.ok(!html.includes('<script>'));
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /&quot;comillas&quot;/);
});

test('blockquotes and rules', () => {
  const { html } = renderMarkdown('> Primero apps pequeñas\n> después grandes.\n\n---\n');
  assert.match(html, /<blockquote><p>Primero apps pequeñas después grandes\.<\/p><\/blockquote>/);
  assert.match(html, /<hr>/);
});

test('wrapped paragraphs join into one line', () => {
  const { html } = renderMarkdown('Una frase\nque sigue\n\ny otro párrafo.\n');
  assert.equal(html, '<p>Una frase que sigue</p>\n<p>y otro párrafo.</p>');
});

// --- tables, fences, task items, autolinks ---------------------------------

test('table_renders_header_and_aligned_cells', () => {
  const { html } = renderMarkdown('| a | b |\n|---|--:|\n| 1 | 2 |\n');
  assert.match(html, /<div class="table-wrap"><table>/);
  assert.match(html, /<th>a<\/th>/);
  assert.match(html, /<th style="text-align:right">b<\/th>/);
  assert.match(html, /<td style="text-align:right">2<\/td>/);
});

test('pipe_in_code_cell_stays_in_cell', () => {
  const { html } = renderMarkdown('| a | b |\n|---|---|\n| `x|y` | z |\n');
  assert.match(html, /<td><code>x\|y<\/code><\/td><td>z<\/td>/);
});

test('fence_keeps_text_verbatim_and_escaped', () => {
  const { html } = renderMarkdown('```js\n<b>& **x**\n```\n');
  assert.match(html, /<pre><code[^>]*>&lt;b&gt;&amp; \*\*x\*\*\n?<\/code><\/pre>/);
  assert.ok(!html.includes('<strong>'));
});

test('unclosed_fence_runs_to_end', () => {
  const { html } = renderMarkdown('```\nuno\ndos\n');
  assert.match(html, /<pre><code>uno\ndos\n?<\/code><\/pre>/);
});

test('task_items_render_checkbox', () => {
  const { html } = renderMarkdown('- [x] hecho\n- [ ] no\n');
  assert.match(html, /<input type="checkbox" disabled checked> hecho/);
  assert.match(html, /<input type="checkbox" disabled> no/);
});

test('bare_url_becomes_link', () => {
  const { html } = renderMarkdown('mira https://example.com/a?b=1 ya\n');
  assert.match(html, /<a href="https:\/\/example\.com\/a\?b=1">https:\/\/example\.com\/a\?b=1<\/a> ya/);
});

test('link_label_url_is_not_linked_twice', () => {
  const { html } = renderMarkdown('[web](https://example.com)\n');
  assert.equal((html.match(/<a /g) || []).length, 1);
});

// The owner's notes live in a private nested repo: a public clone has none.
const REAL_ROADMAP = new URL('../../working/ROADMAP.md', import.meta.url);
const noPrivateNotes = !existsSync(REAL_ROADMAP) && 'no private notes in this clone';

test('real_roadmap_loses_no_words', { skip: noPrivateNotes }, async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(REAL_ROADMAP, 'utf8');
  const { html } = renderMarkdown(source);
  const plain = html.replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/g, ' ');
  // The file title is dropped on purpose by the renderer (the page has its own).
  const body = source.replace(/^#\s+.*\n/, '');
  const words = body.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[`*#>\-_[\]()|]/g, ' ')
    .split(/\s+/).filter((w) => /^[\p{L}\p{N}]{4,}$/u.test(w));
  const missing = words.filter((w) => !plain.includes(w));
  assert.deepEqual(missing, []);
});
