// spend-codex.mjs — Codex token spend from its local rollout files.
//
// Each rollout (~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl) carries
// cumulative `token_count` events. We take the last one per session, so a
// session is attributed whole to the day of its last event (an approximation
// for sessions that span midnight). Read-only; no credentials are touched.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const DAY_MS = 86_400_000;

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (name.startsWith('rollout-') && name.endsWith('.jsonl')) out.push({ full, mtime: st.mtimeMs });
  }
  return out;
}

export function parseRollout(text) {
  let cwd = null, model = null, last = null, lastAt = null;
  for (const line of text.split('\n')) {
    if (!line.includes('"session_meta"') && !line.includes('"turn_context"') && !line.includes('"token_count"')) continue;
    let ev;
    try { ev = JSON.parse(line); } catch { continue; }
    const p = ev.payload ?? {};
    if (ev.type === 'session_meta') cwd = p.cwd ?? cwd;
    else if (ev.type === 'turn_context') model = p.model ?? model;
    else if (p.type === 'token_count' && p.info?.total_token_usage) {
      last = p.info.total_token_usage;
      lastAt = Date.parse(ev.timestamp ?? '');
    }
  }
  if (!last || !Number.isFinite(lastAt)) return null;
  return { cwd, model: model ?? '—', usage: last, at: lastAt };
}

export function readCodexSpend({ root = join(homedir(), '.codex', 'sessions'), range, dayKey, projectLabel, project = null } = {}) {
  const groups = new Map();
  for (const { full, mtime } of walk(root)) {
    if (range && mtime < range.from) continue;
    const s = parseRollout(readFileSync(full, 'utf8'));
    if (!s || (range && (s.at < range.from || s.at >= range.to))) continue;
    const where = s.cwd ? projectLabel(s.cwd) : { label: 'unknown', path: null };
    if (project && project !== where.label && project !== where.path) continue;
    const day = dayKey(s.at);
    const key = JSON.stringify([day, where.label, s.model]);
    if (!groups.has(key)) {
      groups.set(key, {
        date: day, project: where.label, projectPath: where.path, agent: 'codex', model: s.model,
        provider: 'openai', runs: 0, input: 0, output: 0, reasoning: 0,
        cacheRead: 0, cacheWrite: 0, costReportedUsd: 0, coverage: 'tokens-only',
      });
    }
    const g = groups.get(key);
    const u = s.usage;
    g.runs += 1;
    // input_tokens includes cached reads; keep them in their own column.
    g.input += Math.max(0, (u.input_tokens ?? 0) - (u.cached_input_tokens ?? 0));
    g.output += u.output_tokens ?? 0;
    g.reasoning += u.reasoning_output_tokens ?? 0;
    g.cacheRead += u.cached_input_tokens ?? 0;
    g.cacheWrite += u.cache_write_input_tokens ?? 0;
  }
  return { ok: true, rows: [...groups.values()], range: range ?? null };
}
