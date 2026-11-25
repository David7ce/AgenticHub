// render.mjs — rows -> dist/repos.json and the self-contained dist/index.html.
//
// The page opens from disk with no server: CSS and the client scripts in
// page/client/ are inlined, and the data is embedded.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { summarizeUsage } from '../lib/costs.mjs';
import { DIST_DIR } from '../lib/paths.mjs';
import { OWNER_ICONS, PROJECT_ICONS } from './icons.mjs';
import { renderCostsPage } from './costs-render.mjs';
import { INDEX_ROOT_HTML, renderHomePage, summarizeHome } from './home.mjs';
import { NOTES_HTML, readNotes, renderNotesPage } from './notes.mjs';
import { applyShell, writeSharedAssets } from './shared.mjs';

export { SHARED_ASSETS, writeSharedAssets } from './shared.mjs';
export { NOTES_HTML } from './notes.mjs';
export { INDEX_ROOT_HTML } from './home.mjs';

const CLIENT_DIR = new URL('./client/', import.meta.url);
// Load order matters: later files use what earlier ones define.
export const CLIENT_SCRIPTS = ['i18n.js', 'common.js', 'repos.js', 'usage.js', 'main.js'];
export const REPOS_JSON = join(DIST_DIR, 'repos.json');
export const INDEX_HTML = join(DIST_DIR, 'index.html');
export const COSTS_HTML = join(DIST_DIR, 'ai-usage.html');

const client = (name) => readFileSync(new URL(name, CLIENT_DIR), 'utf8');

/**
 * @param rows  repos.json rows
 * @param days  author's commits per day, `days[i]` for `rows[i]`
 * @param meta  { root, generatedAt, author, toolDir }
 * @param activity  `{ accounts: [{ name, days }], ai: [{ provider, days }] }` for the year summary
 */
export function renderPage(rows, days, meta, usageSummary = null, activity = null) {
  const data = {
    ...meta,
    activity,
    usageSummary: usageSummary
      ? { ...usageSummary, commits: days.reduce((sum, repoDays) => sum + Object.values(repoDays ?? {}).reduce((a, b) => a + b, 0), 0) }
      : null,
    toolDir: String(meta.toolDir).replace(/\\/g, '/'),
    ownerIcons: OWNER_ICONS,
    projectIcons: PROJECT_ICONS,
    repos: rows.map((row, i) => ({ ...row, days: days[i] ?? {} })),
  };
  // `<` escaped so a folder named "</script>" cannot close the block early.
  const script = `const DATA = ${JSON.stringify(data).replace(/</g, '\\u003c')};\n\n`
    + CLIENT_SCRIPTS.map(client).join('\n');
  try {
    new Function(script); // fail the build, not the page
  } catch (error) {
    throw new Error(`page script does not parse: ${error.message}`);
  }
  return applyShell(client('index.html'), 'repos')
    .replace('/*STYLES*/', () => client('styles.css'))
    .replace('/*SCRIPT*/', () => script);
}

/** Write the offline inventory, token report, notes and the Inicio page after rendering all outputs. */
export function writeSite(rows, days, meta, ledger = null, activity = null) {
  const data = ledger ?? { schemaVersion: 2, generatedAt: null, sources: {}, rows: [] };
  const html = renderPage(rows, days, meta, summarizeUsage(data), activity);
  const costsHtml = renderCostsPage(data);
  const notes = readNotes();
  const notesHtml = renderNotesPage({ notes, generatedAt: meta.generatedAt });
  const homeHtml = renderHomePage(summarizeHome({
    rows,
    usageSummary: summarizeUsage(data),
    limits: data.limits ?? null,
    notes,
    generatedAt: meta.generatedAt,
    // `2026-11-24 14:24 UTC` -> ISO, so the page can tell when it is stale.
    generatedAtIso: String(meta.generatedAt ?? '').replace(' UTC', ':00Z').replace(' ', 'T'),
  }));
  mkdirSync(DIST_DIR, { recursive: true });
  writeSharedAssets(DIST_DIR);
  writeFileSync(REPOS_JSON, `${JSON.stringify(rows, null, 2)}\n`);
  writeFileSync(INDEX_HTML, html);
  writeFileSync(COSTS_HTML, costsHtml);
  writeFileSync(NOTES_HTML, notesHtml);
  writeFileSync(INDEX_ROOT_HTML, homeHtml);
}
