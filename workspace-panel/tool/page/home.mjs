// home.mjs — workspace-panel/index.html: the glance page, the "Inicio" tab of the panel.
//
// Built together with the other pages from data the build already has (repo rows,
// the token ledger, the working notes), so it never needs its own refresh. It sits
// at the root of workspace-panel/, so its links reach the other pages through `dist/`.
// Folders and published projects are not here on purpose: Repos lists them.

import { join } from 'node:path';

import { PROJECTS_DIR } from '../lib/paths.mjs';
import { readPageAsset, renderDocument } from './shared.mjs';


export const INDEX_ROOT_HTML = join(PROJECTS_DIR, 'index.html');

const finite = (value) => (Number.isFinite(Number(value)) && value !== null ? Number(value) : null);

/**
 * The numbers of the glance, from what the build holds.
 * Every field degrades to 0 / null / [] when its source is empty.
 */
export function summarizeHome({ rows = [], usageSummary = null, limits = null, notes = [], generatedAt = null, generatedAtIso = null } = {}) {
  const repos = {
    total: rows.length,
    dirty: rows.filter((r) => r.dirty).length,
    ahead: rows.filter((r) => Number(r.ahead) > 0).length,
    noRemote: rows.filter((r) => !r.remote).length,
  };

  const agents = (usageSummary?.agents ?? []).map((a) => ({ agent: a.agent, workTokens: finite(a.work_tokens) ?? 0 }));
  const codexWindow = limits?.codex?.windows?.find((w) => w.label === 'weekly') ?? limits?.codex?.windows?.[0];
  const ia = {
    agents,
    codexWeeklyPct: finite(codexWindow?.usedPercent),
    claudeWeek: finite(limits?.claude?.week?.tokens),
  };

  const roadmapText = notes.find((n) => n.id === 'roadmap')?.markdown ?? '';
  const roadmap = {
    open: (roadmapText.match(/^###\s+\S/gm) ?? []).length,
    owner: (roadmapText.match(/^\s*[-*]\s+\*\*Dueño:\*\*/gm) ?? []).length,
  };


  return { repos, ia, roadmap, generatedAt, generatedAtIso };
}

/** The page, ready to write at workspace-panel/index.html. */
export function renderHomePage(summary) {
  return renderDocument(readPageAsset('home.html'), 'home', {
    base: 'dist/', stamp: summary.generatedAt ?? '', page: ['home.css', 'home.js'],
    data: { HOME: summary },
  });
}
