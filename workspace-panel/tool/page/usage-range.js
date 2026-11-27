// usage-range.js — what the IA page shows for a calendar selection, from the
// ledger rows alone. Pure functions; `range` is [startISO, endISO] or null (all).

const RANGE_AGENTS = ['claude', 'opencode', 'codex', 'zen', 'other'];
const RANGE_FIELDS = ['input_tokens', 'cache_write_tokens', 'cache_read_tokens', 'output_tokens', 'reasoning_tokens', 'unknown_tokens'];

/** Model family is not billing evidence: e.g. Haiku running on Go belongs to Go. */
function billingOf(row, openAiViaChatGpt) {
  const provider = /\(([^()]+)\)$/.exec(row.model ?? '')?.[1];
  if (provider === 'opencode-go') return 'opencode';
  // OpenCode Zen: free or pay-as-you-go models, outside the Go allowance.
  if (provider === 'opencode') return 'zen';
  if (row.source === 'claude-code' && (!provider || provider === 'anthropic')) return 'claude';
  if ((row.source === 'codex' && (!provider || provider === 'openai'))
      || (row.source === 'opencode' && provider === 'openai' && openAiViaChatGpt)) return 'codex';
  return 'other';
}

/** Rows timed per step (message, call or reply); totals at a session start would pile a day into one hour. */
function hasStepHour(row) {
  if (!Number.isInteger(row.hour)) return false;
  if (row.source === 'claude-code') return true;
  if (row.source === 'codex') return !(Number(row.unknown_tokens) > 0);
  return row.stepHours === true;
}

/**
 * Share of the Go allowance that known local usage represents, at base rates.
 * Each model has its own monthly allowance for the plan (the week is half of
 * it); a model without one is left out. An estimate, not an account reading.
 */
function goShare(local, models, plan) {
  let week = 0;
  let month = 0;
  let used = false;
  for (const model of models ?? []) {
    const limit = Number(model?.monthly?.[plan]);
    const spent = local?.[model.id];
    if (!(limit > 0) || !spent) continue;
    week += (Number(spent.weekUsd) || 0) / (limit / 2);
    month += (Number(spent.recentUsd) || 0) / limit;
    used = used || spent.weekUsd > 0 || spent.recentUsd > 0;
  }
  return used ? { week, month } : null;
}

/**
 * History of one subscription measured the same way for all: the day with
 * most work and runs of consecutive days with any work. A streak is current
 * while it reaches today or yesterday (today may not have started yet).
 */
function activityStats(rows, today) {
  const byDay = new Map();
  for (const row of rows) {
    const value = workOf(row);
    if (value > 0) byDay.set(row.date, (byDay.get(row.date) ?? 0) + value);
  }
  if (!byDay.size) return null;
  const days = [...byDay.keys()].sort();
  const next = (day) => new Date(Date.parse(`${day}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
  let peakDay = days[0];
  let longestStreak = 0;
  let run = 0;
  let previous = null;
  for (const day of days) {
    if (byDay.get(day) > byDay.get(peakDay)) peakDay = day;
    run = previous && next(previous) === day ? run + 1 : 1;
    longestStreak = Math.max(longestStreak, run);
    previous = day;
  }
  const last = days[days.length - 1];
  const current = last === today || next(last) === today ? run : 0;
  return { peakDay, peakWork: byDay.get(peakDay), currentStreak: current, longestStreak, activeDays: days.length };
}

function billedRows(rows, openAiViaChatGpt) {
  return rows.map((row) => ({
    ...row, client: row.agent, agent: billingOf(row, openAiViaChatGpt),
    model: row.model?.replace(/ \((opencode-go|opencode|openai|anthropic)\)$/, '') || 'unknown-model',
  }));
}

function modelScopeKey(row) {
  return JSON.stringify([row.agent, row.model]);
}

/** Work tokens: input + output + cache writes + undisclosed (same as workTokens in costs.mjs). */
function workOf(row) {
  return (Number(row.input_tokens) || 0) + (Number(row.output_tokens) || 0)
    + (Number(row.cache_write_tokens) || 0) + (Number(row.unknown_tokens) || 0);
}

/** Work tokens per date over every agent, rows without an hour included. */
function dailyWork(rows) {
  const days = new Map();
  for (const row of rows) {
    if (!row.date) continue;
    days.set(row.date, (days.get(row.date) || 0) + workOf(row));
  }
  return days;
}

function inRange(rows, range) {
  if (!range) return rows;
  return rows.filter((row) => row.date >= range[0] && row.date <= range[1]);
}

/** Groups by `keyFn`, sorted by work tokens, then key. */
function rankBy(rows, keyFn) {
  const groups = new Map();
  for (const row of rows) {
    const key = keyFn(row);
    const g = groups.get(key) || { key, work: 0, cacheRead: 0 };
    g.work += workOf(row);
    if (row.inferred) g.inferredWork = (g.inferredWork ?? 0) + workOf(row);
    g.cacheRead += Number(row.cache_read_tokens) || 0;
    groups.set(key, g);
  }
  return [...groups.values()].sort((a, b) => b.work - a.work || String(a.key).localeCompare(String(b.key)));
}

/** Agents, top 8 projects and models, and token totals per agent for the range. */
function breakdown(rows, range) {
  const selected = inRange(rows, range);
  const totals = Object.fromEntries(RANGE_AGENTS.map((agent) => [agent, Object.fromEntries(RANGE_FIELDS.map((f) => [f, 0]))]));
  for (const row of selected) {
    if (!totals[row.agent]) continue;
    for (const field of RANGE_FIELDS) totals[row.agent][field] += Number(row[field]) || 0;
  }
  return {
    agents: rankBy(selected, (row) => row.agent),
    projects: rankBy(selected, (row) => row.project).slice(0, 8),
    models: rankBy(selected, (row) => `${row.agent} · ${row.model}`).slice(0, 8),
    totals,
  };
}
