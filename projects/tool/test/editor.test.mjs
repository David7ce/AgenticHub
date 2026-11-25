// The roadmap editor: the browser copy of the renderer and the save logic.
//
//   node --test projects/tool/test/

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

import { renderMarkdown, tagLabels, wrapProjects } from '../page/md.mjs';
import { renderNotesPage } from '../page/notes.mjs';
import { buildMdBrowser, sharedAssets } from '../page/shared.mjs';

const editorSource = readFileSync(new URL('../page/roadmap-editor.js', import.meta.url), 'utf8');
const loadEditor = () => {
  const context = {};
  vm.runInNewContext(`${editorSource}\nthis.saveMarkdown = saveMarkdown;`, context);
  return context;
};
const note = (id, file, markdown) => ({ id, file, markdown, title: id, kicker: '', absolute: `D:\W\working\${file}` });

test('md_browser_matches_md_mjs_output', () => {
  const context = { window: {} };
  vm.runInNewContext(buildMdBrowser(), context);
  // The owner's real roadmap when it is there (private, nested repo); a fixture in a public clone.
  const roadmap = new URL('../../working/ROADMAP.md', import.meta.url);
  const base = existsSync(roadmap)
    ? readFileSync(roadmap, 'utf8')
    : '# ROADMAP\n\n## P1\n\n### App (`code\\app`)\n- **Siguiente:** *probar* el `editor`.\n- **Límite:** [docs](docs/README.md).\n';
  const source = base
    + '\n| a | b |\n|---|--:|\n| `x|y` | 2 |\n\n```js\n<b>\n```\n\n- [x] hecho\n';
  const opts = { idPrefix: 'roadmap--' };
  assert.equal(context.window.MD.renderMarkdown(source, opts).html, renderMarkdown(source, opts).html);
  const html = renderMarkdown(source, opts).html;
  assert.equal(context.window.MD.tagLabels(context.window.MD.wrapProjects(html)), tagLabels(wrapProjects(html)));
});

test('md_browser_is_a_hashed_page_asset_without_module_syntax', () => {
  const asset = sharedAssets().find((a) => a.name === 'md-browser.js');
  assert.ok(asset && /^[0-9a-f]{10}$/.test(asset.hash));
  assert.ok(!/^\s*export\s/m.test(asset.content), 'no export statements in a classic script');
  assert.doesNotThrow(() => new Function(asset.content));
});

test('editor_markup_has_edit_button_only_on_roadmap', () => {
  const html = renderNotesPage({ notes: [note('roadmap', 'ROADMAP.md', '# R\n\n### P\n- **Dueño:** x\n'), note('handoff', 'HANDOFF.md', '# H\n\ntexto\n')] });
  assert.equal((html.match(/id="edOpen"/g) || []).length, 1);
  assert.equal((html.match(/id="roadmapEditor"/g) || []).length, 1);
  assert.ok(html.indexOf('id="edOpen"') < html.indexOf('<section id="handoff"'));
  assert.match(html, /<script type="application\/json" id="roadmap-source">/);
  assert.match(html, /<label for="edText">/);
  assert.match(html, /id="edStatus" role="status" aria-live="polite"/);
  assert.match(html, /src="shared\/md-browser\.js\?v=[0-9a-f]{10}"/);
  assert.ok(html.indexOf('shared/md-browser.js') < html.indexOf('shared/roadmap-editor.js'));
});

test('editor_source_json_survives_script_end_and_roundtrips', () => {
  const md = '# R\n\ntexto </script> y "comillas" ñ\n';
  const html = renderNotesPage({ notes: [note('roadmap', 'ROADMAP.md', md)] });
  const json = html.match(/<script type="application\/json" id="roadmap-source">([\s\S]*?)<\/script>/)[1];
  assert.equal(JSON.parse(json).markdown, md);
});

test('editor_script_parses', () => {
  assert.doesNotThrow(() => new Function(editorSource));
});

const handleFor = (disk, written = []) => ({
  name: 'ROADMAP.md',
  getFile: async () => ({ text: async () => disk }),
  createWritable: async () => ({ write: async (t) => written.push(t), close: async () => {} }),
});

test('save_writes_when_disk_matches_original_and_keeps_crlf', async () => {
  const { saveMarkdown } = loadEditor();
  const written = [];
  const result = await saveMarkdown({
    value: 'a\nb\n', original: 'a\n', handle: handleFor('a\r\n', written), pick: null,
    confirmFn: () => assert.fail('no confirmation needed'), download: () => assert.fail('no download'),
  });
  assert.equal(result.status, 'saved');
  assert.deepEqual(written, ['a\r\nb\r\n']);
});

test('save_asks_confirmation_when_disk_changed', async () => {
  const { saveMarkdown } = loadEditor();
  const written = [];
  let asked = 0;
  const decline = await saveMarkdown({
    value: 'mio\n', original: 'a\n', handle: handleFor('otro\n', written), pick: null,
    confirmFn: () => { asked += 1; return false; }, download: () => {},
  });
  assert.equal(decline.status, 'cancelled');
  assert.equal(asked, 1);
  assert.deepEqual(written, [], 'nothing is written when the owner declines');
  const accept = await saveMarkdown({
    value: 'mio\n', original: 'a\n', handle: handleFor('otro\n', written), pick: null,
    confirmFn: () => true, download: () => {},
  });
  assert.equal(accept.status, 'saved');
  assert.deepEqual(written, ['mio\n']);
});

test('save_asks_before_writing_to_a_file_with_another_name', async () => {
  const { saveMarkdown } = loadEditor();
  let asked = '';
  const other = { ...handleFor('a\n'), name: 'NOTAS.md' };
  const result = await saveMarkdown({
    value: 'x\n', original: 'a\n', handle: other, pick: null,
    confirmFn: (message) => { asked = message; return false; }, download: () => {},
  });
  assert.equal(result.status, 'cancelled');
  assert.match(asked, /NOTAS\.md/);
});

test('no_api_falls_back_to_download', async () => {
  const { saveMarkdown } = loadEditor();
  let downloaded = null;
  const result = await saveMarkdown({
    value: 'x\n', original: 'a\n', handle: null, pick: null,
    confirmFn: () => assert.fail('nothing to confirm'), download: (text) => { downloaded = text; },
  });
  assert.equal(result.status, 'downloaded');
  assert.equal(downloaded, 'x\n');
});

test('cancelling_the_file_picker_is_not_an_error', async () => {
  const { saveMarkdown } = loadEditor();
  const abort = Object.assign(new Error('closed'), { name: 'AbortError' });
  const result = await saveMarkdown({
    value: 'x\n', original: 'a\n', handle: null, pick: async () => { throw abort; },
    confirmFn: () => true, download: () => {},
  });
  assert.equal(result.status, 'cancelled');
});

test('a_write_failure_is_reported_not_thrown', async () => {
  const { saveMarkdown } = loadEditor();
  const broken = { ...handleFor('a\n'), createWritable: async () => { throw new Error('denied'); } };
  const result = await saveMarkdown({
    value: 'x\n', original: 'a\n', handle: broken, pick: null, confirmFn: () => true, download: () => {},
  });
  assert.equal(result.status, 'error');
  assert.match(result.error, /denied/);
});

test('editor_targets_the_real_body_not_the_preview_pane', () => {
  // The preview pane is a .doc-body inside #roadmap too; a descendant selector hid the wrong one.
  assert.match(editorSource, /querySelector\('#roadmap > \.doc-body'\)/);
  assert.match(editorSource, /querySelector\('#roadmap > \.doc-toc'\)/);
  const html = renderNotesPage({ notes: [note('roadmap', 'ROADMAP.md', '# R\n\n### P\n- x\n')] });
  assert.ok(html.indexOf('id="edPreview"') < html.indexOf('<div class="doc-body">'), 'the editor sits before the real body');
});
