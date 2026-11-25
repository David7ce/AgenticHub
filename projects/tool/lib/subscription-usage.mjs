import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { DIST_DIR, PROJECTS_DIR } from './paths.mjs';

const GO_API = 'https://opencode.ai/inference/go/v1';
export const GO_PLANS = ['go', 'go-plus', 'go-teams'];
export const CLAUDE_USAGE_PATH = join(PROJECTS_DIR, 'local', 'claude-usage.json');
export const CLAUDE_LIVE_PATH = join(DIST_DIR, 'shared', 'claude-usage-live.js');
export const GO_USAGE_PATH = join(PROJECTS_DIR, 'local', 'go-usage.json');
export const CODEX_ACCOUNT_PATH = join(PROJECTS_DIR, 'local', 'codex-account.json');
export const GO_WINDOWS = [['weekly', 'week'], ['monthly', 'month'], ['rolling', '5h']];
export const CLAUDE_WINDOWS = [['seven_day', 'week'], ['five_hour', '5h']];
const validPercent = (p) => Number.isFinite(p) && p >= 0 && p <= 100;
const positive = (n) => Number.isFinite(n) && n > 0;
const iso = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value))
  ? new Date(value).toISOString() : null;

export function hasChatGptConnection(list) {
  if (!Array.isArray(list)) return false;
  const connections = list.find((p) => p?.id === 'openai')?.connections;
  return Array.isArray(connections) && connections.length === 1
    && connections[0]?.type === 'credential' && connections[0]?.method === 'oauth';
}

export function readOpenAiConnection() {
  const args = ['--standalone', 'auth', 'list', '--format', 'json'];
  const win = process.platform === 'win32';
  try {
    const out = spawnSync(win ? process.env.ComSpec || 'cmd.exe' : 'opencode',
      win ? ['/d', '/s', '/c', `"opencode" ${args.join(' ')}`] : args,
      { timeout: 10_000, encoding: 'utf8', windowsHide: true, windowsVerbatimArguments: win });
    return out.status === 0 && hasChatGptConnection(JSON.parse(out.stdout));
  } catch { return false; }
}

/** User-copied console readings only. Never access credentials or console sessions. */
export function readGoUsage(path = GO_USAGE_PATH) {
  return readUsageSnapshot(path, GO_WINDOWS);
}

export function goModelReferences(payload) {
  if (!Array.isArray(payload?.data)) return [];
  return payload.data.flatMap((m) => {
    const input = m?.cost?.text?.input?.price;
    const output = m?.cost?.text?.output?.price;
    const monthly = Object.fromEntries(GO_PLANS.flatMap((plan) => {
      const amount = m?.go?.monthly_usage?.[plan];
      return positive(amount) ? [[plan, amount]] : [];
    }));
    if (typeof m?.id !== 'string' || !positive(input) || !positive(output) || !Object.keys(monthly).length) return [];
    const cache = m.cost.text.input.cache;
    const rate = (n) => Number.isFinite(n) && n >= 0;
    const writes = typeof cache?.write === 'object' && cache.write ? Object.values(cache.write).filter(rate) : [];
    return [{
      id: m.id, name: typeof m.name === 'string' ? m.name : m.id, input, output, monthly,
      cacheRead: rate(cache?.read) ? cache.read : 0,
      cacheWrite: rate(cache?.write) ? cache.write : writes.length ? Math.min(...writes) : 0,
    }];
  });
}

/** Session-start buckets priced at base rates, not provider or billing-window measurements. */
export function estimateGoLocal(rows, models, now = new Date()) {
  const byModel = new Map(models.map((m) => [m.id, m]));
  const result = Object.create(null);
  const monday = new Date(now);
  monday.setUTCHours(0, 0, 0, 0);
  monday.setUTCDate(monday.getUTCDate() - (monday.getUTCDay() + 6) % 7);
  const recentStart = now.getTime() - 30 * 86400_000;
  for (const row of rows) {
    if (row.agent !== 'opencode' || row.source !== 'opencode') continue;
    const id = /^(.*) \(opencode-go\)$/.exec(row.model ?? '')?.[1];
    const model = byModel.get(id);
    if (!model) continue;
    const at = Date.parse(`${row.date}T${String(row.hour ?? 0).padStart(2, '0')}:00:00Z`);
    if (!Number.isFinite(at) || at > now || at < Math.min(monday.getTime(), recentStart)) continue;
    const usd = ((row.input_tokens ?? 0) * model.input + (row.output_tokens ?? 0) * model.output
      + (row.cache_read_tokens ?? 0) * (model.cacheRead ?? 0)
      + (row.cache_write_tokens ?? 0) * (model.cacheWrite ?? 0)) / 1e6;
    if (!(usd > 0)) continue;
    const periods = result[id] ??= { weekUsd: 0, recentUsd: 0 };
    if (at >= monday) periods.weekUsd += usd;
    if (at >= recentStart) periods.recentUsd += usd;
  }
  return result;
}

/** Optional figures copied from the official Codex dashboard, not quota readings. */
export function readCodexAccountStats(path = CODEX_ACCOUNT_PATH) {
  try {
    const input = JSON.parse(readFileSync(path, 'utf8'));
    const measuredOn = /^\d{4}-\d{2}-\d{2}$/.test(input.measuredOn) ? input.measuredOn : null;
    const stats = Object.fromEntries(['lifetimeTokens', 'peakTokens', 'longestChatMinutes', 'currentStreakDays', 'longestStreakDays']
      .filter((k) => Number.isSafeInteger(input[k]) && input[k] >= 0).map((k) => [k, input[k]]));
    return measuredOn && Object.keys(stats).length ? { measuredOn, ...stats } : null;
  } catch { return null; }
}

export async function readGoModels(request = fetch) {
  try {
    const res = await request(`${GO_API}/models`, { credentials: 'omit', signal: AbortSignal.timeout(7000) });
    return res.ok ? goModelReferences(await res.json()) : [];
  } catch { return []; }
}

export function claudeStatusWindows(input, now = new Date()) {
  return CLAUDE_WINDOWS.flatMap(([field, label]) => {
    const data = input?.rate_limits?.[field];
    const resets = new Date(Number.isFinite(data?.resets_at) ? data.resets_at * 1000 : NaN);
    return validPercent(data?.used_percentage) && resets > now
      ? [{ label, usedPercent: data.used_percentage, resetsAt: resets.toISOString() }] : [];
  });
}

function readUsageSnapshot(path, definitions) {
  try {
    const data = JSON.parse(readFileSync(path, 'utf8'));
    const measuredAt = iso(data.measuredAt);
    const windows = definitions.flatMap(([, label]) => {
      const window = data.windows?.find((w) => w?.label === label);
      const resetsAt = iso(window?.resetsAt);
      return validPercent(window?.usedPercent) && resetsAt && resetsAt > measuredAt
        ? [{ label, usedPercent: window.usedPercent, resetsAt }] : [];
    });
    return measuredAt && windows.length ? { measuredAt, windows } : null;
  } catch { return null; }
}

export function readClaudeUsage(path = CLAUDE_USAGE_PATH) {
  return readUsageSnapshot(path, CLAUDE_WINDOWS);
}

// A classic local script works from file://, where a fetch of a sibling JSON file can be blocked.
export function claudeLiveScript(snapshot) {
  return `window.acceptClaudeUsage?.(${JSON.stringify(snapshot).replace(/</g, '\\u003c')});\n`;
}
