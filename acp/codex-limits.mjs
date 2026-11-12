// codex-limits.mjs -- how much of Codex's plan allowance is used, as the account itself reports it.
//
// Codex on a ChatGPT plan is flat-rate: there is no price per token to estimate, there are usage
// windows. The Codex app server answers `account/rateLimits/read` with up to two windows
// (`primary`, `secondary`), each with usedPercent, windowDurationMins and resetsAt. Measured
// 2026-11-12 on a Plus plan: one window only, 10080 minutes (weekly), no 5-hour window (the way
// Claude has one). Which windows exist depends on the plan, so nothing here assumes either.
//
// Reading it starts `codex app-server` for a few seconds with the login Codex already has. No
// token is read, printed or stored; only the percentages, the plan name and the reset times are.

import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** Where the last reading is kept: <state dir>/logs/codex-limits.json. */
export const limitsPath = (stateDir) => join(stateDir, 'logs', 'codex-limits.json');

export function windowLabel(mins) {
  if (!Number.isFinite(mins) || mins <= 0) return 'window';
  if (mins === 10080) return 'weekly';
  if (mins % 1440 === 0) return `${mins / 1440}d`;
  if (mins % 60 === 0) return `${mins / 60}h`;
  return `${mins}min`;
}

const windowOf = (slot, w) => (w && Number.isFinite(w.usedPercent)
  ? {
    slot,
    label: windowLabel(w.windowDurationMins),
    usedPercent: w.usedPercent,
    windowMins: w.windowDurationMins ?? null,
    resetsAt: Number.isFinite(w.resetsAt) ? new Date(w.resetsAt * 1000).toISOString() : null,
  }
  : null);

/** The `result` of account/rateLimits/read -> what the hub keeps (no account id, no credits detail). */
export function summarizeLimits(result) {
  const snap = result?.rateLimits ?? null;
  if (!snap) return null;
  const windows = [windowOf('primary', snap.primary), windowOf('secondary', snap.secondary)].filter(Boolean);
  return {
    plan: snap.planType ?? null,
    windows,
    reached: snap.rateLimitReachedType ?? null,
    ordinaryUsageAllowed: result.ordinaryUsageAllowed ?? null,
    credits: snap.credits ? { has: !!snap.credits.hasCredits, unlimited: !!snap.credits.unlimited } : null,
  };
}

/**
 * The cache without the windows that already reset: their percentage belongs to the last period.
 * Null when none is left, so nothing is shown rather than a number that is no longer true.
 */
export function dropReset(cache, now = Date.now()) {
  if (!cache) return null;
  const windows = cache.windows.filter((w) => !w.resetsAt || Date.parse(w.resetsAt) > now);
  return windows.length ? { ...cache, windows } : null;
}

const DAYS = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];
const MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const pad = (n) => String(n).padStart(2, '0');
export function resetLabel(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '?';
  return `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** One line: "plus · semanal 74% (reinicia sáb 14 nov 01:53)" -- every window the plan has. */
export function describeLimits(summary) {
  if (!summary?.windows?.length) return null;
  const parts = summary.windows.map((w) => {
    const name = w.label === 'weekly' ? 'semanal' : w.label;
    return `${name} ${w.usedPercent}%${w.resetsAt ? ` (reinicia ${resetLabel(w.resetsAt)})` : ''}`;
  });
  return `${summary.plan ?? 'codex'} · ${parts.join(' · ')}`;
}

export function readLimitsCache(path) {
  try {
    const cache = JSON.parse(readFileSync(path, 'utf8'));
    return cache && Array.isArray(cache.windows) && cache.measuredAt ? cache : null;
  } catch {
    return null;
  }
}

export function writeLimitsCache(path, summary, now = new Date()) {
  mkdirSync(dirname(path), { recursive: true });
  const cache = { measuredAt: now.toISOString(), ...summary };
  writeFileSync(path, `${JSON.stringify(cache, null, 2)}\n`);
  return cache;
}

export const cacheAgeMs = (cache, now = Date.now()) => (cache ? now - Date.parse(cache.measuredAt) : Infinity);

/**
 * Asks a live `codex app-server`. Resolves { ok:true, summary } or { ok:false, error }; never throws and
 * always kills the server it started.
 */
export function queryCodexLimits({ command = 'codex', timeoutMs = 30_000, spawnImpl = spawn } = {}) {
  return new Promise((resolve) => {
    let child;
    let settled = false;
    let timer;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child?.kill(); } catch { /* already gone */ }
      resolve(value);
    };
    timer = setTimeout(() => finish({ ok: false, error: `no answer from codex app-server in ${timeoutMs} ms` }), timeoutMs);
    try {
      child = spawnImpl(command, ['app-server'], { shell: process.platform === 'win32', windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    } catch (error) {
      return finish({ ok: false, error: error.message });
    }
    child.on('error', (error) => finish({ ok: false, error: error.message }));
    child.on('exit', () => finish({ ok: false, error: 'codex app-server exited before answering' }));
    const waiting = new Map();
    let id = 0;
    let buffer = '';
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        try {
          const msg = JSON.parse(line);
          if (msg.id != null && waiting.has(msg.id)) { waiting.get(msg.id)(msg); waiting.delete(msg.id); }
        } catch { /* a banner line */ }
      }
    });
    const rpc = (method, params) => new Promise((ok) => {
      const n = ++id;
      waiting.set(n, ok);
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: n, method, params })}\n`);
    });
    (async () => {
      const init = await rpc('initialize', { clientInfo: { name: 'agent-hub', version: '1' }, capabilities: {} });
      if (init.error) return finish({ ok: false, error: init.error.message });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'initialized' })}\n`);
      const reply = await rpc('account/rateLimits/read', { excludeResetCreditDetails: true });
      if (reply.error) return finish({ ok: false, error: reply.error.message });
      const summary = summarizeLimits(reply.result);
      return finish(summary ? { ok: true, summary } : { ok: false, error: 'the answer had no rate limits' });
    })().catch((error) => finish({ ok: false, error: error.message }));
  });
}
