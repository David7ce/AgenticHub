// router-stats.mjs — the last 24 h of the audit log, per routing target.
import { existsSync, readFileSync } from 'node:fs';
import {
  CHEAP_AGENT,
  DEFAULT_LOG,
  RECENT_FAILURE_WINDOW_MS,
  STATS_WINDOW_MS,
  STRONG_AGENT,
} from './router-config.mjs';

/**
 * Read this fleet's audit log and summarize the last 24 h per routing
 * target. Missing/unreadable log -> zeroed stats (routing still works).
 *
 * Exported for tests: pass an explicit `now` to make windows deterministic.
 */
export function readRunStats(logPath = DEFAULT_LOG, now = Date.now()) {
  const empty = () => ({
    runs: 0,
    ok: 0,
    failures: 0,
    recentFailures: 0,
    timeouts: 0,
    cost: 0,
    lastRun: null,
    lastFailure: null,
  });
  const stats = { [CHEAP_AGENT]: empty(), [STRONG_AGENT]: empty() };
  if (!logPath || !existsSync(logPath)) return stats;

  let lines;
  try {
    lines = readFileSync(logPath, 'utf8').split('\n');
  } catch {
    return stats;
  }

  for (const line of lines) {
    if (!line.trim()) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue; // append-only log: one corrupt line shouldn't break routing
    }

    // Only completed agent turns count. Skip probes (no model call) and
    // denied/rejected entries (nothing ran), and the fan-out summary row
    // (no `agent` field -- its children each have their own record).
    const agent = record.agent;
    if (!agent || !(agent in stats)) continue;
    if (record.transport !== 'acp') continue;
    if (!['ok', 'failed', 'timeout', 'empty'].includes(record.status)) continue;

    const when = Date.parse(record.time ?? '');
    if (!Number.isFinite(when)) continue;
    const age = now - when;
    if (age < 0 || age > STATS_WINDOW_MS) continue;

    const stat = stats[agent];
    stat.runs += 1;
    stat.lastRun = when;
    if (record.status === 'ok') stat.ok += 1;
    else {
      stat.failures += 1;
      stat.lastFailure = when;
      if (age <= RECENT_FAILURE_WINDOW_MS) stat.recentFailures += 1;
    }
    if (record.status === 'timeout') stat.timeouts += 1;
    const amount = record.cost?.amount;
    if (typeof amount === 'number' && Number.isFinite(amount)) stat.cost += amount;
  }

  return stats;
}

export function describeStats(stats) {
  const one = (name) => {
    const s = stats?.[name];
    if (!s) return `${name}: no data`;
    return (
      `${name}: ${s.runs} run(s)/24h, ${s.recentFailures} recent failure(s), ` +
      `$${s.cost.toFixed(4)}/24h`
    );
  };
  return `${one(CHEAP_AGENT)}; ${one(STRONG_AGENT)}`;
}
