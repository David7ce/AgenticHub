// render.mjs — inventory data and publication of the four offline pages.
//
// Data is embedded; ordered classic scripts and styles are linked local assets.

import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { buildCostsView, summarizeUsage } from '../lib/costs.mjs';
import { DIST_DIR } from '../lib/paths.mjs';
import { CLAUDE_LIVE_PATH, claudeLiveScript, readClaudeUsage } from '../lib/subscription-usage.mjs';
import { OWNER_ICONS, PROJECT_ICONS } from './icons.mjs';
import { renderCostsPage } from './costs-render.mjs';
import { INDEX_ROOT_HTML, renderHomePage, summarizeHome } from './home.mjs';
import { NOTES_HTML, readNotes, renderNotesPage } from './notes.mjs';
import { readPageAsset, renderDocument, writeSharedAssets } from './shared.mjs';

export { SHARED_ASSETS, writeSharedAssets } from './shared.mjs';
export { NOTES_HTML } from './notes.mjs';
export { INDEX_ROOT_HTML } from './home.mjs';

// Classic scripts load in this order, sharing the page data and helpers.
export const CLIENT_SCRIPTS = ['i18n.js', 'common.js', 'repos.js', 'usage.js', 'main.js'];
export const REPOS_JSON = join(DIST_DIR, 'repos.json');
export const INDEX_HTML = join(DIST_DIR, 'index.html');
export const COSTS_HTML = join(DIST_DIR, 'ai-usage.html');

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
  return renderDocument(readPageAsset('client/index.html'), 'repos', {
    page: ['client/styles.css', ...CLIENT_SCRIPTS.map((name) => `client/${name}`)],
    data: { DATA: data },
  });
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
  // Don't overwrite a newer reading produced by an active Claude status line.
  try { writeFileSync(CLAUDE_LIVE_PATH, claudeLiveScript(readClaudeUsage()), { flag: 'wx' }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  // Already-open pages can pick up freshly rebuilt quota readings without reloading.
  const quotaPath = join(DIST_DIR, 'shared', 'account-usage-live.js');
  const quotaTemp = `${quotaPath}.${process.pid}.tmp`;
  const quota = {
    generatedAt: data.limits?.measuredAt ?? null,
    rows: buildCostsView(data).room.filter((r) => r.agent !== 'claude'
      && ['measured', 'manual'].includes(r.source) && ['week', 'month'].includes(r.label)),
  };
  try {
    writeFileSync(quotaTemp, `window.acceptAccountUsage?.(${JSON.stringify(quota).replace(/</g, '\\u003c')});\n`);
    renameSync(quotaTemp, quotaPath);
  } finally { rmSync(quotaTemp, { force: true }); }
  writeFileSync(REPOS_JSON, `${JSON.stringify(rows, null, 2)}\n`);
  writeFileSync(INDEX_HTML, html);
  writeFileSync(COSTS_HTML, costsHtml);
  writeFileSync(NOTES_HTML, notesHtml);
  writeFileSync(INDEX_ROOT_HTML, homeHtml);
}
