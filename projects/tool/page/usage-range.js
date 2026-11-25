// usage-range.js — what the IA page shows for a calendar selection, from the
// ledger rows alone. Pure functions; `range` is [startISO, endISO] or null (all).

const RANGE_AGENTS = ['claude', 'opencode', 'codex'];
const RANGE_FIELDS = ['input_tokens', 'cache_write_tokens', 'cache_read_tokens', 'output_tokens', 'reasoning_tokens', 'unknown_tokens'];

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
