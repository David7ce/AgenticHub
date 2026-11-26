// notes.mjs — dist/notes.html: the three working notes, readable in the panel.
//
// The `.md` files stay the source of truth (agents read them, git diffs them);
// this is the same text rendered once per build, with the panel's design, so the
// launcher can open the roadmap, the handoff and the journal like any other page.
// Links are rewritten: note-to-note links become anchors on this page, everything
// else points at the real file with a file:// URL (the page opens from disk).

import { readFileSync, statSync } from 'node:fs';
import { basename, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

import { readLocalJson } from '../lib/local.mjs';
import { DIST_DIR, PROJECTS_DIR } from '../lib/paths.mjs';
import { renderMarkdown, tagLabels, wrapProjects } from './md.mjs';
import { readPageAsset, renderDocument } from './shared.mjs';


/**
 * Las raíces del workspace, tal y como se escriben en el roadmap: la ruta que va
 * entre paréntesis en cada `### Nombre (`code\...`)` se convierte en enlace a la
 * carpeta del repo. Son rutas de esta máquina, así que viven en
 * workspace-panel/local/roots.json (ignorado por git); sin ese archivo no se enlaza nada.
 */
const WORKSPACE_ROOTS = readLocalJson('roots.json', {});

/** Enlaza la carpeta del proyecto en cada título del roadmap, si existe. */
export function linkProjectFolders(html, roots = WORKSPACE_ROOTS) {
  return html.replace(/<h4[^>]*>([\s\S]*?)<\/h4>/g, (whole, inner) => {
    const linked = inner.replace(/<code>([^<]+)<\/code>/, (tag, shown) => {
      const prefix = Object.keys(roots).find((root) => shown.startsWith(root));
      if (!prefix) return tag;
      const folder = `${roots[prefix]}/${shown.slice(prefix.length).replace(/\\/g, '/')}`;
      try {
        if (!statSync(folder).isDirectory()) return tag;
      } catch {
        return tag;
      }
      return `<a class="proj-path" href="${pathToFileURL(folder).href}" title="Abrir la carpeta del proyecto">${tag}</a>`;
    });
    return whole.replace(inner, linked);
  });
}

export const WORKING_DIR = join(PROJECTS_DIR, 'working');
export const NOTES_HTML = join(DIST_DIR, 'notes.html');

/** The notes, in the order they are read. `file` is the source under working/. */
export const NOTES = [
  {
    id: 'roadmap',
    file: 'ROADMAP.md',
    title: 'Roadmap',
    kicker: 'Lo que queda abierto, con su siguiente paso o su bloqueo.',
  },
  {
    id: 'handoff',
    file: 'HANDOFF.md',
    title: 'Handoff',
    kicker: 'Cómo arrancar: pendiente, puertos y reglas.',
  },
  {
    id: 'journal',
    file: 'JOURNAL.md',
    title: 'Journal',
    kicker: 'Registro de sesiones, lo más reciente arriba.',
  },
];

/** Read the notes; a missing file becomes a visible line, not a failed build. */
export function readNotes(dir = WORKING_DIR) {
  return NOTES.map((note) => {
    const absolute = join(dir, note.file);
    let markdown = null;
    try {
      markdown = readFileSync(absolute, 'utf8');
    } catch {
      markdown = `_No se encontró \`${note.file}\`._`;
    }
    return { ...note, markdown, absolute };
  });
}

// The three notes live in working/, so a relative link resolves from there, as
// it does when the .md is opened in an editor: `COSTS.md` and `../../AGENTS.md`.
function hrefResolver(note, notes) {
  return (href) => {
    if (/^(https?:|mailto:|file:)/i.test(href)) return href;
    const [path, hash] = href.split('#');
    const sibling = notes.find((other) => other.file.toLowerCase() === basename(path).toLowerCase());
    if (sibling) return `#${sibling.id}${hash ? `-${hash}` : ''}`;
    const url = pathToFileURL(resolve(WORKING_DIR, path)).href;
    return hash ? `${url}#${hash}` : url;
  };
}

// Order matters: the shell first, then the renderer copy, then the page and its editor.
const NOTES_PAGE_ASSETS = ['notes.css', 'roadmap-editor.css', 'md-browser.js', 'notes.js', 'roadmap-editor.js'];

/** The roadmap's Markdown editor: hidden until "Editar", and its source as inert JSON. */
function editorMarkup(note) {
  const siblings = Object.fromEntries(NOTES.map((n) => [n.file.toLowerCase(), n.id]));
  const json = JSON.stringify({
    markdown: note.markdown,
    file: note.file,
    workingUrl: pathToFileURL(WORKING_DIR + sep).href,
    siblings,
  }).replace(/</g, '\\u003c');
  return `
  <script type="application/json" id="roadmap-source">${json}</script>
  <div class="editor" id="roadmapEditor" hidden>
    <div class="editor-bar" role="toolbar" aria-label="Editor del roadmap">
      <button type="button" class="shell-tool primary" id="edSave">Guardar</button>
      <button type="button" class="shell-tool" id="edDownload">Descargar .md</button>
      <button type="button" class="shell-tool" id="edCancel">Cancelar</button>
      <span id="edStatus" role="status" aria-live="polite"></span>
    </div>
    <div class="editor-panes">
      <div class="editor-pane"><label for="edText">Markdown</label><textarea id="edText" spellcheck="false"></textarea></div>
      <div class="editor-pane"><h3 id="edPreviewLabel">Vista previa</h3><div class="doc-body" id="edPreview" aria-labelledby="edPreviewLabel"></div></div>
    </div>
  </div>`;
}

/**
 * @param notes        from readNotes()
 * @param generatedAt  the panel's timestamp, shown in the header
 */
export function renderNotesPage({ notes = readNotes(), generatedAt = null, roots = WORKSPACE_ROOTS } = {}) {
  const sections = [];
  const nav = [];
  for (const note of notes) {
    const rendered = renderMarkdown(note.markdown, {
      idPrefix: `${note.id}--`,
      resolveHref: hrefResolver(note, notes),
    });
    const isRoadmap = note.id === 'roadmap';
    // The roadmap is a list of projects (`###`): each is a card of its own, and its
    // folder becomes a link so the page is also a way into the repos.
    const html = tagLabels(isRoadmap ? linkProjectFolders(wrapProjects(rendered.html), roots) : rendered.html);
    nav.push(`<a href="#${note.id}">${note.title}</a>`);
    const source = pathToFileURL(note.absolute).href;
    sections.push(`<section id="${note.id}" class="card doc">
  <div class="doc-head">
    <div><h2>${note.title}</h2><p>${note.kicker}</p></div>
    <div class="doc-actions">${isRoadmap ? '<button type="button" class="shell-tool" id="edOpen" aria-controls="roadmapEditor">Editar</button>' : ''}<a class="doc-source" href="${source}">${note.file}</a></div>
  </div>${isRoadmap ? editorMarkup(note) : ''}
  <div class="doc-body">
${html}
  </div>
</section>`);
  }

  const stamp = generatedAt
    ? `Notas de ${notes.map((n) => n.file).join(', ')} · ${generatedAt}`
    : `Notas de ${notes.map((n) => n.file).join(', ')}`;
  return renderDocument(readPageAsset('notes.html'), 'notes', {
    hideLang: true, stamp, page: NOTES_PAGE_ASSETS,
    slots: { '<!--NOTES_NAV-->': nav.join(''), '<!--NOTES-->': sections.join('\n') },
  });
}
