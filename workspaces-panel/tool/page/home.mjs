// home.mjs — workspaces-panel/index.html: the glance page, the "Inicio" tab of the panel.
//
// Built together with the other pages from data the build already has (repo rows,
// the token ledger, the working notes), so it never needs its own refresh. It sits
// at the root of workspaces-panel/, so its links reach the other pages through `dist/`.
// Folders and published projects are not here on purpose: Repos lists them.

import { join } from 'node:path';

import { buildCostsView } from '../lib/costs.mjs';
import { PROJECTS_DIR } from '../lib/paths.mjs';
import { readPageAsset, renderDocument } from './shared.mjs';


export const INDEX_ROOT_HTML = join(PROJECTS_DIR, 'index.html');

const finite = (value) => (Number.isFinite(Number(value)) && value !== null ? Number(value) : null);
const DAY_MS = 86400_000;

/** Work tokens: input + output + cache writes + undisclosed (same as the IA page). */
function workOf(row) {
  return (Number(row.input_tokens) || 0) + (Number(row.output_tokens) || 0)
    + (Number(row.cache_write_tokens) || 0) + (Number(row.unknown_tokens) || 0);
}

/** Billing attribution, the same one the IA page applies before drawing its charts. */
function billingOf(row, openAiViaChatGpt) {
  const provider = /\(([^()]+)\)$/.exec(row.model ?? '')?.[1];
  if (provider === 'opencode-go') return 'opencode';
  if (provider === 'opencode') return 'zen';
  if (row.source === 'claude-code' && (!provider || provider === 'anthropic')) return 'claude';
  if ((row.source === 'codex' && (!provider || provider === 'openai'))
      || (row.source === 'opencode' && provider === 'openai' && openAiViaChatGpt)) return 'codex';
  return 'other';
}

const lastDays = (now, count = 7) => {
  const end = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Array.from({ length: count }, (_, i) => new Date(end - (count - 1 - i) * DAY_MS).toISOString().slice(0, 10));
};

/** Share of the Go allowance this week, at base rates (the week is half the month). */
function goWeekShare(local, models, plan) {
  let pct = 0;
  let used = false;
  for (const model of models ?? []) {
    const limit = Number(model?.monthly?.[plan]);
    const spent = local?.[model.id];
    if (!(limit > 0) || !spent) continue;
    pct += (Number(spent.weekUsd) || 0) / (limit / 2);
    used = used || spent.weekUsd > 0;
  }
  return used ? pct : null;
}

/**
 * One row per current subscription: local work tokens for the last seven days and
 * the weekly reading its plan reports (measured, estimated or against the record).
 */
function weeklySubscriptions(rows, limits, now) {
  // Readings need the full plan shape; a partial `limits` still leaves tokens and lines.
  let view = null;
  try { view = buildCostsView({ rows, limits }, now); } catch { /* no readings */ }
  const days = lastDays(now);
  const byAgent = new Map();
  for (const row of rows) {
    if (!row.date) continue;
    const agent = billingOf(row, view.openAiViaChatGpt);
    const perDay = byAgent.get(agent) ?? new Map();
    perDay.set(row.date, (perDay.get(row.date) ?? 0) + workOf(row));
    byAgent.set(agent, perDay);
  }
  const readings = new Map((view?.room ?? []).map((r) => [`${r.agent}-${r.label}`, r]));
  const reading = (agent, label) => {
    const r = readings.get(`${agent}-${label}`);
    if (!r) return null;
    if (Number.isFinite(r.pct)) {
      return { pct: r.pct, kind: r.source === 'measured' ? 'measured' : r.source === 'manual' ? 'manual' : 'estimated' };
    }
    if (Number.isFinite(r.recordPct)) return { pct: r.recordPct, kind: 'record' };
    return null;
  };
  const configuredGo = view?.configuredPlans?.opencode ?? limits?.goPlan ?? null;
  const goPlan = configuredGo && configuredGo !== 'zen' ? configuredGo : null;
  const goWeek = view ? goWeekShare(view.goLocal, view.goModels, goPlan ?? 'go') : null;
  const items = [];
  const add = (agent, plan, pct) => {
    const perDay = byAgent.get(agent);
    const daily = days.map((day) => perDay?.get(day) ?? 0);
    const tokens = daily.reduce((sum, n) => sum + n, 0);
    if (!plan && !tokens) return;
    items.push({ agent, plan: plan ?? null, tokens, days: daily, pct: pct?.pct ?? null, pctKind: pct?.kind ?? null });
  };
  add('codex', view?.detectedPlans?.codex ?? limits?.codex?.plan ?? null, reading('codex', 'week'));
  add('claude', view?.configuredPlans?.claude ?? limits?.claude?.plan ?? null, reading('claude', '7d'));
  add('opencode', goPlan, goWeek === null ? null : { pct: goWeek, kind: 'estimated' });
  add('zen', configuredGo === 'zen' ? 'zen' : null, { pct: null, kind: 'free' });
  return { dates: days, items };
}

/**
 * The numbers of the glance, from what the build holds.
 * Every field degrades to 0 / null / [] when its source is empty.
 */
export function summarizeHome({ rows = [], usageRows = [], usageSummary = null, limits = null, notes = [], generatedAt = null, generatedAtIso = null, now = new Date() } = {}) {
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

  const weekly = weeklySubscriptions(usageRows, limits, now);

  const roadmapText = notes.find((n) => n.id === 'roadmap')?.markdown ?? '';
  const roadmap = {
    open: (roadmapText.match(/^###\s+\S/gm) ?? []).length,
    owner: (roadmapText.match(/^\s*[-*]\s+\*\*Dueño:\*\*/gm) ?? []).length,
  };


  return { repos, ia, weekly, roadmap, generatedAt, generatedAtIso };
}

/** The page, ready to write at workspaces-panel/index.html. */
export function renderHomePage(summary) {
  return renderDocument(readPageAsset('home.html'), 'home', {
    base: 'dist/', stamp: summary.generatedAt ?? '', page: ['home.css', 'home.js'],
    data: { HOME: summary },
  });
}
