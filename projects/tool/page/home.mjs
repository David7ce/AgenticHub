// home.mjs — projects/index.html: the glance page, the "Inicio" tab of the panel.
//
// Built together with the other pages from data the build already has (repo rows,
// the token ledger, the working notes), so it never needs its own refresh. It sits
// at the root of projects/, so its links reach the other pages through `dist/`.
// Folders and published projects are not here on purpose: Repos lists them.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { PROJECTS_DIR } from '../lib/paths.mjs';
import { applyShell } from './shared.mjs';

const PAGE_DIR = new URL('./', import.meta.url);
const readClient = (name) => readFileSync(new URL(name, PAGE_DIR), 'utf8');

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

/** The page, ready to write at projects/index.html. */
export function renderHomePage(summary) {
  // The data is inline; the logic is the linked, hashed home.js (same global scope).
  const data = `const HOME = ${JSON.stringify(summary).replace(/</g, '\\u003c')};`;
  return applyShell(readClient('home.html'), 'home', {
    base: 'dist/', stamp: summary.generatedAt ?? '', page: ['home.css', 'home.js'],
  }).replace('/*HOME_DATA*/', () => data);
}
