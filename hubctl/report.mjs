// report.mjs — completed turns by agent and model over a time window.
//
// `live` answers "what is happening"; `report` answers "what has this fleet
// actually been doing": success, failures, timeouts, p50/p95 latency and
// reported cost. It reads the append-only audit log, never the network.

const STATUSES = new Set(['ok', 'failed', 'timeout', 'empty', 'budget']);

// Why a turn did not end ok, from its status and error text. Order matters:
// quota and auth errors also carry the generic -32603 code. Each cause points
// at a different fix, which is the point of separating them.
const CAUSES = [
  ['quota', /usage limit|session limit|hour limit|weekly limit|rate limit|quota|exhaust/i],
  ['auth', /authentication required|unauthori[sz]ed|code -32000/i],
  ['network', /EAI_AGAIN|ENOTFOUND|ECONN|endpoint is unavailable|upstream request failed|internal service failure/i],
  ['config', /set_config_option|unknown config option|invalid params|does not advertise/i],
  ['spawn', /spawn |ENOENT|EINVAL|exited \(code|server exited/i],
  ['agent-error', /-32603|internal error/i],
];

export function classifyFailure(entry) {
  const status = entry?.status;
  if (status === 'ok') return null;
  if (status === 'budget') return 'budget';
  if (status === 'empty') return 'empty';
  if (status === 'timeout') return entry.cancelAck === false ? 'timeout-unacked' : 'timeout';
  const text = String(entry?.error ?? entry?.reason ?? '');
  for (const [cause, pattern] of CAUSES) if (pattern.test(text)) return cause;
  return text.trim() ? 'other' : 'unknown';
}

function percentile(sorted, fraction) {
  if (!sorted.length) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1));
  return sorted[index];
}

/**
 * Build one row per agent+model. Probes and denied/rejected calls are skipped:
 * they never did work, and counting them would make a healthy agent look busy.
 */
export function collectReport(text, { now = Date.now(), days = 7 } = {}) {
  const windowMs = Math.max(1, days) * 86_400_000;
  const rows = new Map();
  const causes = {};
  let skipped = 0;

  for (const line of String(text ?? '').split('\n')) {
    if (!line.trim()) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    const status = entry.status ?? '?';
    if (status === 'probe' || status === 'denied' || status === 'rejected') { skipped += 1; continue; }
    if (!STATUSES.has(status)) continue;
    const when = Date.parse(entry.time ?? entry.ts ?? '');
    if (!Number.isFinite(when) || now - when > windowMs || when > now) continue;
    const agent = entry.agent ?? '?';
    const model = entry.model ?? '—';
    const key = `${agent}\u0000${model}`;
    if (!rows.has(key)) {
      rows.set(key, {
        agent, model, runs: 0, ok: 0, failed: 0, timeout: 0, empty: 0, budget: 0,
        cost: 0, durations: [], last: null,
      });
    }
    const row = rows.get(key);
    row.runs += 1;
    row[status] = (row[status] ?? 0) + 1;
    const cause = classifyFailure(entry);
    if (cause) causes[cause] = (causes[cause] ?? 0) + 1;
    if (status === 'ok' && Number.isFinite(entry.durationMs)) row.durations.push(entry.durationMs);
    const amount = entry.cost?.amount;
    if (Number.isFinite(amount)) row.cost += amount;
    if (row.last == null || when > row.last) row.last = when;
  }

  const out = [...rows.values()].map((row) => {
    const sorted = row.durations.slice().sort((a, b) => a - b);
    return {
      agent: row.agent,
      model: row.model,
      runs: row.runs,
      ok: row.ok,
      failed: row.failed,
      timeout: row.timeout,
      empty: row.empty,
      budget: row.budget,
      p50Ms: percentile(sorted, 0.5),
      p95Ms: percentile(sorted, 0.95),
      costUsd: Number(row.cost.toFixed(4)),
      last: row.last ? new Date(row.last).toISOString() : null,
    };
  });
  out.sort((a, b) => a.agent.localeCompare(b.agent) || a.model.localeCompare(b.model));

  return {
    days,
    now: new Date(now).toISOString(),
    runs: out.reduce((sum, row) => sum + row.runs, 0),
    skipped,
    causes,
    rows: out,
  };
}

function seconds(ms) {
  if (ms == null) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

function ago(iso, now) {
  if (!iso) return '—';
  const ms = now - Date.parse(iso);
  if (!Number.isFinite(ms)) return '—';
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h`;
  return `${Math.round(ms / 86_400_000)}d`;
}

export function renderReport(report, { color = true, now = Date.now(), width = 110 } = {}) {
  const paint = color
    ? { bold: (s) => `\x1b[1m${s}\x1b[0m`, dim: (s) => `\x1b[2m${s}\x1b[0m`, green: (s) => `\x1b[32m${s}\x1b[0m`, yellow: (s) => `\x1b[33m${s}\x1b[0m` }
    : { bold: (s) => s, dim: (s) => s, green: (s) => s, yellow: (s) => s };

  const stamp = new Date(now).toISOString().replace('T', ' ').slice(0, 16);
  const lines = [
    `${paint.bold('AGENTHUB REPORT')} ${paint.dim(stamp)}${paint.dim(`  ·  last ${report.days} day(s)  ·  ${report.runs} turn(s)`)}`,
    '',
  ];
  if (!report.rows.length) {
    lines.push(paint.dim('  no completed turns in this window'));
    return lines.join('\n');
  }

  const headers = ['agent', 'model', 'runs', 'ok', 'fail', 'tout', 'p50', 'p95', 'cost', 'last'];
  const widths = [10, 28, 5, 4, 5, 5, 7, 7, 9, 5];
  const line = (cells) => '  ' + cells.map((cell, i) => String(cell).padEnd(widths[i])).join(' ');
  lines.push(paint.dim(line(headers)));
  for (const row of report.rows) {
    const cells = [
      row.agent,
      row.model.length > widths[1] ? `${row.model.slice(0, widths[1] - 1)}…` : row.model,
      row.runs, row.ok, row.failed, row.timeout,
      seconds(row.p50Ms), seconds(row.p95Ms),
      `$${row.costUsd.toFixed(2)}`, ago(row.last, now),
    ];
    const text = line(cells);
    lines.push(row.failed || row.timeout ? paint.yellow(text) : text);
  }
  const causes = Object.entries(report.causes ?? {}).sort((a, b) => b[1] - a[1]);
  if (causes.length) {
    lines.push('', `  ${paint.bold('not ok, by cause')}  ${causes.map(([cause, count]) => `${cause} ${count}`).join(' · ')}`);
  }
  if (report.skipped) lines.push('', paint.dim(`  ${report.skipped} probe/denied/rejected line(s) skipped`));
  lines.push(paint.dim('  cost is what the provider reported; flat-rate pools report $0'));
  return lines.join('\n');
}
