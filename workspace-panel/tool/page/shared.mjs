// shared.mjs — the Workspaces shell and the assets every page reuses.
//
// The shell markup, the palette, the page frame, the calendar and the shared
// helpers are one source; the build writes them once under `dist/shared/` and the
// pages link them, so they are not repeated in three files. A content hash in the
// query string keeps a rebuild from being served from a stale cache.
//
// Two groups: what every page needs (tokens, base, shell, numbers), and what only
// a page with a calendar needs (calendar.css/js). The calendar is added when the
// template has the `<!--CALENDAR-->` placeholder.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const SHARED_DIR = new URL('./shared/', import.meta.url);
export const readShared = (name) => readFileSync(new URL(name, SHARED_DIR), 'utf8');

/** Written to `dist/shared/` and linked from every page. */
export const SHARED_STYLES = ['tokens.css', 'base.css', 'shell.css'];
export const SHARED_SCRIPTS = ['shell.js', 'format.js'];
/** Only for pages that render the year calendar. */
export const CALENDAR_STYLES = ['calendar.css'];
export const CALENDAR_SCRIPTS = ['calendar.js'];
export const SHARED_ASSETS = [...SHARED_STYLES, ...SHARED_SCRIPTS, ...CALENDAR_STYLES, ...CALENDAR_SCRIPTS];
export const ASSETS_DIRNAME = 'shared';

/**
 * Assets that belong to one page (its own CSS/JS), still served from dist/shared/ as
 * hashed files instead of being inlined. They live next to the page sources;
 * `md-browser.js` is generated from md.mjs, so the browser renders what the build does.
 */
export const PAGE_ASSETS = [
  'home.css', 'home.js',
  'client/styles.css', 'client/i18n.js', 'client/common.js', 'client/repos.js', 'client/usage.js', 'client/main.js',
  'costs.css', 'usage-range.js', 'costs.js',
  'notes.css', 'notes.js', 'roadmap-editor.css', 'roadmap-editor.js', 'md-browser.js',
];
const PAGE_URL = new URL('./', import.meta.url);
export const readPageAsset = (name) => readFileSync(new URL(name, PAGE_URL), 'utf8');

/** md.mjs as a classic script: no `export`, wrapped so its helpers stay private. */
export function buildMdBrowser() {
  const source = readPageAsset('md.mjs').replace(/^export /gm, '');
  return `// md-browser.js — generated from md.mjs by the build; do not edit.\n(function () {\n${source}\n`
    + 'window.MD = { renderMarkdown, slugify, wrapProjects, tagLabels };\n})();\n';
}

/** Every shared and page asset, as `{ name, content, hash }`. */
export const sharedAssets = () => [...SHARED_ASSETS, ...PAGE_ASSETS].map((name) => {
  const content = name === 'md-browser.js' ? buildMdBrowser()
    : PAGE_ASSETS.includes(name) ? readPageAsset(name) : readShared(name);
  return { name, content, hash: createHash('sha256').update(content).digest('hex').slice(0, 10) };
});

/** Write `dist/shared/` (or another build directory). */
export function writeSharedAssets(distDir) {
  const dir = join(distDir, ASSETS_DIRNAME);
  mkdirSync(dir, { recursive: true });
  for (const asset of sharedAssets()) {
    const target = join(dir, asset.name);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, asset.content);
  }
  return dir;
}

const FAVICON = '<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 viewBox=%270 0 100 100%27%3E%3Crect width=%27100%27 height=%27100%27 rx=%2722%27 fill=%27%232563eb%27/%3E%3Cpath d=%27M26 62 42 38l14 18 8-11 10 17%27 fill=%27none%27 stroke=%27%23fff%27 stroke-width=%277%27 stroke-linecap=%27round%27 stroke-linejoin=%27round%27/%3E%3C/svg%3E">';

/** `<link>` and `<script>` tags for the shared assets, hashed for cache busting. */
export function sharedTags({ calendar = true, assets = sharedAssets(), base = '', page = [] } = {}) {
  const styles = [...(calendar ? [...SHARED_STYLES, ...CALENDAR_STYLES] : SHARED_STYLES), ...page.filter((n) => n.endsWith('.css'))];
  const scripts = [...(calendar ? [...SHARED_SCRIPTS, ...CALENDAR_SCRIPTS] : SHARED_SCRIPTS), ...page.filter((n) => n.endsWith('.js'))];
  const url = (name) => {
    const asset = assets.find((a) => a.name === name);
    return `${base}${ASSETS_DIRNAME}/${name}?v=${asset?.hash ?? '0'}`;
  };
  return {
    css: [FAVICON, ...styles.map((name) => `<link rel="stylesheet" href="${url(name)}">`)].join('\n'),
    js: scripts.map((name) => `<script src="${url(name)}"></script>`).join('\n'),
  };
}

/**
 * Fill the shell placeholders of a page template: `<!--SHARED_CSS-->`,
 * `<!--SHARED_JS-->`, `<!--SHELL-->` and `<!--CALENDAR-->`.
 *
 * `tab` marks the current tab ('home' | 'repos' | 'ia' | 'notes'). Options:
 *   page     this page's own assets (PAGE_ASSETS names), linked after the shared ones;
 *   base     path from the page to dist/ ('' inside dist/, 'dist/' from the root);
 *   stamp    text under the title, when the page ships it rendered (notes);
 *   hideLang a page generated in one language drops the ES/EN selector.
 */
export function applyShell(html, tab, { stamp = '', hideLang = false, base = '', page = [] } = {}) {
  let header = readShared('shell.html')
    .replaceAll('{{BASE}}', base)
    .replace('{{HOME_HREF}}', base ? 'index.html' : '../index.html')
    .replace('{{HOME_CURRENT}}', tab === 'home' ? ' aria-current="page"' : '')
    .replace('{{REPOS_CURRENT}}', tab === 'repos' ? ' aria-current="page"' : '')
    .replace('{{IA_CURRENT}}', tab === 'ia' ? ' aria-current="page"' : '')
    .replace('{{NOTES_CURRENT}}', tab === 'notes' ? ' aria-current="page"' : '')
    .replace('{{STAMP}}', () => String(stamp).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'));
  if (hideLang) header = header.replace(/<!--LANG-->[\s\S]*?<!--\/LANG-->/, '');
  // The page asks for the calendar by carrying its placeholder.
  const tags = sharedTags({ calendar: html.includes('<!--CALENDAR-->'), base, page });
  return html
    .replace('<!--SHARED_CSS-->', () => tags.css)
    .replace('<!--SHARED_JS-->', () => tags.js)
    .replace('<!--CALENDAR-->', () => readShared('calendar.html').trimEnd())
    .replace('<!--SHELL-->', () => header.trimEnd());
}

/** One assembly path for all offline pages: shell, data, assets and content slots. */
export function renderDocument(template, tab, { data = {}, slots = {}, ...options } = {}) {
  const titles = { home: 'Inicio', repos: 'Repositorios', ia: 'Uso de IA', notes: 'Roadmap' };
  const script = Object.entries(data).map(([name, value]) => {
    if (!/^[A-Z][A-Z0-9_]*$/.test(name)) throw new Error(`Invalid page data name: ${name}`);
    return `const ${name} = ${JSON.stringify(value).replace(/</g, '\\u003c')};`;
  }).join('\n');
  // Validate data and ordered classic scripts together, including lexical collisions.
  const sources = (options.page ?? []).filter((name) => name.endsWith('.js'))
    .map((name) => name === 'md-browser.js' ? buildMdBrowser() : readPageAsset(name));
  try { new Function([script, ...sources].join('\n')); }
  catch (error) { throw new Error(`${tab} page script does not parse: ${error.message}`); }
  let html = template.replace('<!--PAGE_DATA-->', () => script ? `<script>\n${script}\n</script>` : '')
    .replace('{{PAGE_TITLE}}', () => `Panel Workspaces · ${titles[tab]}`);
  for (const [marker, content] of Object.entries(slots)) html = html.replace(marker, () => content);
  return applyShell(html, tab, options);
}
