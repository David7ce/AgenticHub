// Subscription windows, account readings and quota presentation; history scanning stays in costs.mjs.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { PROJECTS_DIR } from './paths.mjs';
import { GO_WINDOWS } from './subscription-usage.mjs';
import { collectFiles, numeric, readJsonLines, workTokens } from './usage-records.mjs';

// ---------------------------------------------------------------- limits

const HOUR = 3_600_000;
const WINDOW_5H = 5;
const WINDOW_WEEK = 168;

/**
 * The published cache read is a fraction of the fresh-input price, and a plan
 * window rations it at a fraction too — but nobody publishes that fraction per
 * plan. 0.1 is the order of magnitude the providers quote; `fitCacheWeight()`
 * replaces it with the owner's own number once a limit hit is on record.
 */
export const DEFAULT_CACHE_WEIGHT = 0.1;

/** The weight to use for an agent: the owner's `local/limits.json` wins. */
export function cacheWeight(config = {}, agent = 'claude') {
  const raw = config?.[agent]?.cacheWeight ?? config?.cacheWeight;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : DEFAULT_CACHE_WEIGHT;
}

/**
 * Tokens a plan actually rations: work tokens plus the cache reads at their
 * weight. This is an estimate, and the page says so; it is not a bill.
 */
export function quotaTokens(tokens, weight = DEFAULT_CACHE_WEIGHT) {
  return workTokens(tokens) + Math.round(weight * numeric(tokens.cache_read_tokens));
}

/** Per-hour work and cache reads for one agent, from hourly rows only. */
function agentHours(rows, agent = 'claude') {
  const hours = new Map();
  for (const row of rows) {
    if (row.agent !== agent || !Number.isInteger(row.hour) || !row.date) continue;
    const start = Date.parse(`${row.date}T00:00:00Z`) + row.hour * HOUR;
    if (!Number.isFinite(start)) continue;
    const current = hours.get(start) ?? { work: 0, cache: 0 };
    current.work += workTokens(row);
    current.cache += numeric(row.cache_read_tokens);
    hours.set(start, current);
  }
  return hours;
}

function sumField(hours, from, to, field) {
  let total = 0;
  for (const [start, value] of hours) if (start >= from && start < to) total += value[field];
  return total;
}

function heaviest(hours, span) {
  let best = { tokens: 0, start: null };
  for (const start of hours.keys()) {
    const tokens = sumField(hours, start, start + span * HOUR, 'work');
    if (tokens > best.tokens) best = { tokens, start: new Date(start).toISOString() };
  }
  return best;
}

/**
 * Claude's rolling 5-hour and 7-day usage, and the heaviest such windows on
 * record. `tokens` stays the work-only figure the tables always showed; `quota`
 * is the same window with cache reads at `weight`.
 */
export function claudeWindows(rows, now = new Date(), weight = DEFAULT_CACHE_WEIGHT) {
  const hours = agentHours(rows);
  const end = now.getTime();
  const window = (span) => {
    const from = end - span * HOUR;
    const work = sumField(hours, from, end, 'work');
    const cache = sumField(hours, from, end, 'cache');
    return {
      tokens: work,
      cache,
      quota: work + Math.round(weight * cache),
      start: new Date(from).toISOString(),
      end: new Date(end).toISOString(),
    };
  };
  return {
    window5h: window(WINDOW_5H),
    week: window(WINDOW_WEEK),
    record5h: heaviest(hours, WINDOW_5H),
    recordWeek: heaviest(hours, WINDOW_WEEK),
  };
}

/**
 * Solve the cache weight from real limit hits: with a known ceiling C and the
 * work and cache read in the window that hit it, w = (C - work) / cache.
 * One sample is a fit; more samples give a median and the residuals say whether
 * the model holds. No ceiling or no usable sample is an error, not a guess.
 */
export function fitCacheWeight({
  rows = [], hits = [], ceiling = null, agent = 'claude', windowHours = WINDOW_5H,
} = {}) {
  if (!numeric(ceiling)) return { error: 'no plan ceiling to fit against (workspaces-panel/local/limits.json)' };
  if (!hits.length) return { error: 'no limit hit on record yet' };
  const hours = agentHours(rows, agent);
  const span = windowHours * HOUR;
  const samples = [];
  for (const hit of hits) {
    const at = Date.parse(hit);
    if (!Number.isFinite(at)) continue;
    const work = sumField(hours, at - span, at, 'work');
    const cache = sumField(hours, at - span, at, 'cache');
    if (cache <= 0) continue;
    const weight = (numeric(ceiling) - work) / cache;
    if (Number.isFinite(weight) && weight >= 0 && weight <= 1) samples.push(weight);
  }
  if (!samples.length) return { error: 'the hits have no cache reads in their window to weigh' };
  samples.sort((a, b) => a - b);
  const median = samples[Math.floor(samples.length / 2)];
  const weight = Math.round(median * 1_000) / 1_000;
  const residuals = hits
    .map((hit) => Date.parse(hit))
    .filter(Number.isFinite)
    .map((at) => {
      const predicted = sumField(hours, at - span, at, 'work')
        + Math.round(weight * sumField(hours, at - span, at, 'cache'));
      return {
        at: new Date(at).toISOString(),
        predicted,
        error: Math.round(((predicted - numeric(ceiling)) / numeric(ceiling)) * 1_000) / 1_000,
      };
    });
  return { weight, samples: samples.length, ceiling: numeric(ceiling), residuals };
}

// The short system message Claude Code writes when a plan limit stops a session.
// Anchored to the whole message: prose or prompts that merely quote it never match.
const LIMIT_HIT = /^(?:claude ai usage limit reached\|\d+|(?:\d+-hour|weekly|opus weekly|session) limit reached\s*[∙·]\s*resets\b.{0,60}|you've hit your (?:usage )?limit\b.{0,80})$/i;
const LIMIT_HIT_MAX = 160;

/** Only Claude Code's own error record counts — never user prompts, prose or subagent transcripts. */
function isLimitRecord(record) {
  if (record?.type !== 'assistant' || record.isSidechain) return false;
  if (record.isApiErrorMessage !== true && record.message?.model !== '<synthetic>') return false;
  const text = messageText(record.message).trim();
  return text.length <= LIMIT_HIT_MAX && LIMIT_HIT.test(text);
}

function messageText(message) {
  const content = message?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text).join('\n');
}

/** Times Claude Code hit a plan limit. The text is only tested, never kept. */
export function findLimitHits(
  projectsDir = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'projects'),
) {
  const hits = new Set();
  for (const file of collectFiles(projectsDir)) {
    for (const record of readJsonLines(file)) {
      if (!record?.timestamp || !record.message) continue;
      if (isLimitRecord(record)) hits.add(record.timestamp);
    }
  }
  return [...hits].sort();
}

/**
 * Claude's plan reference: the owner's own numbers in local/limits.json win;
 * otherwise the first observed limit hit gives the 5-hour ceiling actually
 * reached. Null until either exists: no public quota is invented.
 */
export function claudeReference(config = {}, hits = [], rows = []) {
  const own = config?.claude ?? {};
  if (numeric(own.window5h) || numeric(own.week)) {
    return {
      plan: own.plan ?? null,
      window5h: numeric(own.window5h) || null,
      week: numeric(own.week) || null,
      source: own.source || 'manual',
    };
  }
  const first = [...hits].sort()[0];
  if (!first) return null;
  const at = Date.parse(first);
  // Work tokens only: deriving a ceiling from the hit and then weighing the
  // same cache reads into it would be circular.
  const window5h = sumField(agentHours(rows), at - WINDOW_5H * HOUR, at, 'work');
  if (!window5h) return null; // a hit outside the ledger's hourly data says nothing about the ceiling
  return {
    plan: own.plan ?? null,
    window5h,
    week: null,
    source: `observed ${first.slice(0, 10)}`,
  };
}

export const LIMITS_CONFIG_PATH = join(PROJECTS_DIR, 'local', 'limits.json');
const HUBCTL = join(dirname(PROJECTS_DIR), 'agent-hub', 'hubctl', 'hubctl.mjs');

/** `hubctl usage --json`: Codex plan windows (asked to the account) and Go % per model. */
function hubctlUsage() {
  const result = spawnSync(process.execPath, [HUBCTL, 'usage', '--json', '--days', '30'], {
    encoding: 'utf8', timeout: 60_000, windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`hubctl usage exited ${result.status}: ${(result.stderr || '').trim().slice(0, 200)}`);
  return JSON.parse(result.stdout);
}

function readLimitsConfig(path = LIMITS_CONFIG_PATH) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return {};
  }
}

/**
 * The limits reading `costs --write` stores in the ledger. Codex and Go come
 * from hubctl (a failure leaves them null with the reason); Claude's part is
 * always computed locally from the ledger rows and the transcripts.
 */
export function collectLimits({
  rows = [],
  now = new Date(),
  runUsage = hubctlUsage,
  readConfig = readLimitsConfig,
  findHits = findLimitHits,
} = {}) {
  const config = readConfig() ?? {};
  let usage = null;
  let error = null;
  try {
    usage = runUsage();
  } catch (failure) {
    error = String(failure?.message ?? failure);
  }
  const summary = usage?.codex?.summary;
  const hits = findHits();
  return {
    measuredAt: now.toISOString(),
    codex: usage ? (summary ? {
      plan: summary.plan ?? null,
      source: usage.codex.source ?? null,
      measuredAt: summary.measuredAt ?? null,
      windows: (summary.windows ?? []).map((w) => ({
        label: w.label, usedPercent: w.usedPercent, resetsAt: w.resetsAt ?? null, windowMins: w.windowMins ?? null,
      })),
    } : null) : null,
    go: usage ? (usage.opencode?.models ?? []).map((m) => ({
      model: m.model, pct: Number.isFinite(m.pct) ? m.pct : null,
      cost: Number.isFinite(m.cost) ? m.cost : null, limit: m.limit ?? null,
    })) : null,
    goPlan: config.opencode?.plan ?? null,
    claude: {
      plan: config.claude?.plan ?? null,
      ...claudeWindows(rows, now, cacheWeight(config)),
      hits: hits.length,
      reference: claudeReference(config, hits, rows),
      // How much of a plan window cache reads eat. `fitted` only when the owner
      // wrote a ceiling in local/limits.json AND a hit is on record; otherwise
      // the published order of magnitude, labelled as a prior.
      quota: quotaWeight(config, rows, hits),
    },
    error,
  };
}

function quotaWeight(config, rows, hits) {
  const prior = cacheWeight(config);
  const own = config?.claude ?? {};
  const manual = Number(own.cacheWeight);
  if (Number.isFinite(manual) && manual >= 0 && manual <= 1) {
    return { weight: prior, source: 'manual', samples: 0 };
  }
  if (!numeric(own.window5h)) {
    return { weight: prior, source: 'prior', samples: 0, error: 'no plan ceiling in local/limits.json' };
  }
  const fitted = fitCacheWeight({ rows, hits, ceiling: own.window5h, agent: 'claude' });
  if (fitted.error) return { weight: prior, source: 'prior', samples: 0, error: fitted.error };
  return {
    weight: fitted.weight,
    source: 'fitted',
    samples: fitted.samples,
    ceiling: fitted.ceiling,
    residuals: fitted.residuals,
  };
}

/**
 * The limits reading for one `costs` run. A dry run stays local: it computes
 * Claude's part but does not ask the Codex account (that is `--write`'s job).
 */
export function limitsForRun({ write = false, ...options } = {}) {
  if (write) return collectLimits(options);
  return collectLimits({
    ...options,
    runUsage: () => { throw new Error('Codex/Go not read in a dry run; use --write'); },
  });
}

// ---------------------------------------------------------------- view

const HIGH = 0.8;

function roomState(pct, resetsAt, now) {
  if (resetsAt && Date.parse(resetsAt) <= now.getTime()) return 'reset';
  if (pct === null || pct === undefined) return 'none';
  return pct >= HIGH ? 'high' : 'ok';
}

export function roomRows(limits, now) {
  if (!limits) return [];
  const rows = [];
  const missing = (agent, label) => ({
    id: `${agent}-${label}`, agent, label, pct: null, source: 'unavailable', state: 'none',
  });
  const accounted = (agent, label, w, measuredAt, source = 'measured') => {
    if (!Number.isFinite(w?.usedPercent)) return missing(agent, label);
    const pct = w.usedPercent / 100;
    const resetsAt = w.resetsAt ?? null;
    const state = roomState(pct, resetsAt, now);
    return {
      id: `${agent}-${label}`, agent, label, pct: state === 'reset' ? null : pct,
      resetsAt, measuredAt, source, state,
    };
  };
  const codexWindows = limits.codex?.windows ?? [];
  const codexLabel = (w) => w.windowMins === 10080 || /^(weekly|semanal)$/i.test(w.label) ? 'week'
    : (w.windowMins >= 28 * 1440 && w.windowMins <= 31 * 1440) || /^(monthly|mensual)$/i.test(w.label) ? 'month' : w.label;
  for (const w of codexWindows) {
    rows.push(accounted('codex', codexLabel(w), w, limits.codex.measuredAt ?? limits.measuredAt));
  }
  if (limits.subscription) {
    for (const label of ['week', 'month']) {
      if (!rows.some((r) => r.agent === 'codex' && r.label === label)) rows.push(missing('codex', label));
    }
    for (const [, label] of GO_WINDOWS) {
      const manual = limits.subscription.goManual;
      const w = manual?.windows?.find((window) => window.label === label);
      rows.push(accounted('opencode', label, w, manual?.measuredAt, 'manual'));
    }
  }
  const go = new Map();
  for (const m of (limits.subscription ? [] : limits.go ?? [])) {
    const merged = go.get(m.model) ?? { model: m.model, pct: null, cost: 0, limit: m.limit };
    if (Number.isFinite(m.pct)) merged.pct = (merged.pct ?? 0) + m.pct;
    merged.cost += Number.isFinite(m.cost) ? m.cost : 0;
    go.set(m.model, merged);
  }
  for (const m of go.values()) {
    const pct = m.limit === null ? null : m.pct;
    rows.push({
      id: `opencode-${m.model}`, agent: 'opencode', label: m.model, pct, recordPct: null,
      used: m.cost, limit: m.limit, resetsAt: null, source: m.limit === null ? 'free' : 'estimated',
      state: roomState(pct, null, now), detail: '',
    });
  }
  const c = limits.claude;
  if (c) {
    const ref = c.reference;
    for (const [id, label, used, record, refLimit, end] of [
      ['claude-5h', '5h', c.window5h, c.record5h, ref?.window5h, c.window5h?.end],
      ['claude-week', '7d', c.week, c.recordWeek, ref?.week, c.week?.end],
    ]) {
      const account = limits.subscription?.claude;
      const snapshot = account?.windows?.find((w) => w.label === (label === '7d' ? 'week' : label));
      if (snapshot) {
        rows.push(accounted('claude', label, snapshot, account.measuredAt));
        continue;
      }
      // A plan window rations cache reads too, so the percentage is against
      // quota tokens; the work-only figure stays visible for comparison.
      const quota = used.quota ?? used.tokens;
      const pct = refLimit ? quota / refLimit : null;
      const recordPct = record?.tokens ? used.tokens / record.tokens : null;
      rows.push({
        id, agent: 'claude', label, pct, recordPct, used: used.tokens, quota, limit: refLimit ?? null,
        record: record?.tokens ?? 0, resetsAt: null, windowEnd: end ?? null,
        source: refLimit ? 'estimated' : 'record', refSource: ref?.source ?? null, plan: c.plan ?? null,
        // Being at your own record is not being near a limit: only a plan reference can alarm.
        state: pct === null ? (recordPct === null ? 'none' : 'ok') : roomState(pct, null, now), detail: '',
      });
    }
    if (limits.subscription) rows.push(missing('claude', 'month'));
  }
  return rows;
}

