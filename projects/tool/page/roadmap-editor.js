// roadmap-editor.js — edit ROADMAP.md from the Notas page, in Markdown, with the same
// rendering as the page (md-browser.js is a build-time copy of md.mjs).
//
// The page opens from disk, so there is no server to write to. Where the browser has
// the File System Access API (Chrome, Edge) the editor asks once for the real file and
// writes into it; elsewhere it offers the edited text as a download.

const NL = /\r\n?/g;
const norm = (text) => String(text).replace(NL, '\n');

/**
 * Write `value` into the roadmap file, or hand it over as a download.
 * Never throws: the page shows `status` ('saved' | 'cancelled' | 'downloaded' | 'error').
 *
 *   original    the text this editing session started from
 *   handle      a FileSystemFileHandle already chosen, or null
 *   pick        showOpenFilePicker-like () => Promise<[handle]>, or null when unsupported
 *   confirmFn   (message) => boolean, asked before overwriting something unexpected
 *   download    (text) => void, the fallback
 */
async function saveMarkdown({ value, original, handle, pick, confirmFn, download, expectedName = 'ROADMAP.md' }) {
  if (!pick && !handle) {
    download(value);
    return { status: 'downloaded', handle: null };
  }
  let file = handle;
  try {
    if (!file) file = (await pick())[0];
    if (file.name !== expectedName
      && !confirmFn(`Elegiste «${file.name}», no ${expectedName}. ¿Escribir ahí de todas formas?`)) {
      return { status: 'cancelled', handle: null };
    }
    const disk = await (await file.getFile()).text();
    if (norm(disk) !== norm(original)
      && !confirmFn('El archivo cambió en disco desde que abriste el editor. ¿Sobrescribirlo con tu versión?')) {
      return { status: 'cancelled', handle: file };
    }
    // Keep the file's own line endings: ROADMAP.md is CRLF, and a diff should not say otherwise.
    const eol = disk.includes('\r\n') ? '\r\n' : '\n';
    const writable = await file.createWritable();
    await writable.write(norm(value).replace(/\n/g, eol));
    await writable.close();
    return { status: 'saved', handle: file };
  } catch (error) {
    if (error && error.name === 'AbortError') return { status: 'cancelled', handle: null };
    return { status: 'error', handle: file ?? null, error: String((error && error.message) || error) };
  }
}

function initRoadmapEditor() {
  const $ = (id) => document.getElementById(id);
  const sourceEl = $('roadmap-source');
  if (!sourceEl || !$('edOpen') || typeof window.MD === 'undefined') return;

  const { markdown, workingUrl, siblings } = JSON.parse(sourceEl.textContent);
  let original = markdown;
  let handle = null;
  let dirty = false;

  // Direct children only: the preview pane inside the editor is a .doc-body too.
  const body = document.querySelector('#roadmap > .doc-body');
  const toc = document.querySelector('#roadmap > .doc-toc');
  const editor = $('roadmapEditor');
  const text = $('edText');
  const preview = $('edPreview');
  const status = $('edStatus');
  const say = (message) => { status.textContent = message; };

  // Links resolve as the page build does: sibling notes become anchors, the rest file:// URLs.
  const resolveHref = (href) => {
    if (/^(https?:|mailto:|file:)/i.test(href)) return href;
    const [path, hash] = href.split('#');
    const name = path.split('/').pop().toLowerCase();
    if (siblings[name]) return `#${siblings[name]}${hash ? `-${hash}` : ''}`;
    try { return new URL(href, workingUrl).href; } catch { return href; }
  };
  const render = (source) => window.MD.tagLabels(window.MD.wrapProjects(
    window.MD.renderMarkdown(source, { idPrefix: 'preview--', resolveHref }).html,
  ));

  let frame = 0;
  const paintPreview = () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => { preview.innerHTML = render(text.value); });
  };

  function open() {
    text.value = original;
    preview.innerHTML = render(original);
    body.hidden = true;
    if (toc) toc.hidden = true;
    editor.hidden = false;
    $('edOpen').hidden = true;
    say('');
    text.focus();
  }
  function close() {
    editor.hidden = true;
    body.hidden = false;
    if (toc) toc.hidden = false;
    $('edOpen').hidden = false;
    $('edOpen').focus();
  }

  async function save() {
    const value = text.value;
    say('Guardando…');
    const result = await saveMarkdown({
      value,
      original,
      handle,
      pick: window.showOpenFilePicker
        ? () => window.showOpenFilePicker({ multiple: false, types: [{ description: 'Markdown', accept: { 'text/markdown': ['.md'] } }] })
        : null,
      confirmFn: (message) => window.confirm(message),
      download: downloadText,
    });
    if (result.handle) handle = result.handle;
    if (result.status === 'saved') {
      original = value;
      dirty = false;
      body.innerHTML = render(value);
      say('Guardado. Ejecuta «refresh» para reflejarlo en Inicio y en el índice.');
    } else if (result.status === 'downloaded') {
      say('Este navegador no puede escribir en disco: se descargó ROADMAP.md; cópialo a working/.');
    } else if (result.status === 'cancelled') {
      say('No se guardó.');
    } else {
      say(`No se pudo guardar: ${result.error}`);
    }
  }

  function downloadText(value) {
    const url = URL.createObjectURL(new Blob([value], { type: 'text/markdown;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'ROADMAP.md';
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  $('edOpen').addEventListener('click', open);
  $('edSave').addEventListener('click', save);
  $('edDownload').addEventListener('click', () => { downloadText(text.value); say('Descargado ROADMAP.md.'); });
  $('edCancel').addEventListener('click', () => {
    if (dirty && !window.confirm('Hay cambios sin guardar. ¿Descartarlos?')) return;
    dirty = false;
    close();
  });
  text.addEventListener('input', () => { dirty = text.value !== original; paintPreview(); });
  text.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      save();
    }
  });
  window.addEventListener('beforeunload', (event) => {
    if (dirty) { event.preventDefault(); event.returnValue = ''; }
  });
}

if (typeof document !== 'undefined') initRoadmapEditor();
