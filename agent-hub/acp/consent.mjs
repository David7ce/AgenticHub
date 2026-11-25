// consent.mjs — the one definition of "may this agent run?".
//
// hub-acp.mjs, fanout-acp.mjs (through hub-acp) and the MCP server all gate on
// this, so a grant means the same thing no matter which door the call came
// through. The base rule is deliberately boring: enabled, acknowledged, not
// expired.
//
// A grant may also carry machine-readable `limits`, so the scope is enforced
// instead of living only in the free-text `scope` sentence:
//
//   "limits": {
//     "maxPermission": "allow-all",        // deny < allow-reads < ask < allow-all
//     "writeTrees": ["D:/Workspaces/..."], // where ask and allow-all may run
//     "maxBudgetUsd": 2,                   // requested budget is clamped to this
//     "maxDailyUsd": 5,                    // reported cost today (local day) for
//     "maxContextTokens": 200000            // this agent; at the cap runs are
//   }                                      // denied, below it the budget is
//                                          // clamped to what is left.
//                                          // maxContextTokens cancels a turn
//                                          // whose window crosses it; the caller
//                                          // can only tighten it with
//                                          // --max-context, never widen it.
//
// A grant without `limits` keeps the old behaviour. `writeTrees` applies to
// write-capable runs (`ask` and `allow-all`); a cwd under the system temp dir
// (bench scratch copies) is always allowed, because nothing there outlives the
// run. Worktrees made by fanout live in <repo>/.git/agent-worktrees/, i.e.
// inside the tree they came from, so they pass the same check.

import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { HUB_CONFIG } from './config.mjs';
import { isEnforcedReadOnly } from './readonly.mjs';

export const CONSENT_PATH = HUB_CONFIG.consentPath;

// `ask` sits above read-only and below full write access on purpose: it is
// write-capable, but a grant capped at `ask` means "supervised only" and must
// not admit `allow-all`.
export const PERMISSION_RANK = { deny: 0, 'allow-reads': 1, ask: 2, 'allow-all': 3 };

// ACP agents may act on native permissions without asking the hub. Until an
// independent enforcement mechanism is verified, restricted runs fail closed.
// Exception: an adapter listed in readonly.mjs runs restricted policies in a
// scratch session whose tools are removed by the agent itself.
//
// `ask` is not restricted: the hub holds every request it cannot decide
// itself. It is still a distinct consent cap below `allow-all` -- write-capable
// for the tree lock and writeTrees, but not full write access.
export function permissionSafetyReason(permission, agent = null) {
  return permission === 'allow-all' || permission === 'ask' || isEnforcedReadOnly(agent)
    ? null
    : 'Restricted permissions cannot be enforced: an ACP agent may execute tools without a permission request';
}

export function readConsent(path = CONSENT_PATH) {
  if (!existsSync(path)) return { ok: false, reason: `no consent file at ${path}`, grants: null };
  try {
    return { ok: true, grants: JSON.parse(readFileSync(path, 'utf8')) };
  } catch (err) {
    return { ok: false, reason: `cannot read consent.json: ${err.message}`, grants: null };
  }
}

// Canonical form of a path: symlinks and NTFS junctions resolved, so a link created inside an
// allowed tree cannot point outside it. A path that does not exist yet is resolved through its
// longest existing ancestor, which keeps `<tree>/new/dir` inside `<tree>`.
export function realPath(p) {
  let target = resolve(String(p));
  const missing = [];
  for (;;) {
    try {
      const real = realpathSync.native(target).replace(/^\\\\\?\\/, '');
      return missing.length ? resolve(real, ...[...missing].reverse()) : real;
    } catch {
      const parent = dirname(target);
      if (parent === target) return resolve(String(p));
      missing.push(basename(target));
      target = parent;
    }
  }
}

// Comparable form of a path: absolute, real, one separator, case-folded on Windows,
// no trailing separator.
export function normalizeTree(p, platform = process.platform) {
  let out = realPath(p).replace(/[\\/]+/g, '/');
  if (out.length > 1 && out.endsWith('/') && !/^[A-Za-z]:\/$/.test(out)) out = out.slice(0, -1);
  return platform === 'win32' ? out.toLowerCase() : out;
}

export function isInside(child, parent, platform = process.platform) {
  const c = normalizeTree(child, platform);
  const p = normalizeTree(parent, platform);
  return c === p || c.startsWith(p.endsWith('/') ? p : `${p}/`);
}

// Checks one request against a grant's limits. Pure apart from tmpdir(), which
// callers can override for tests.
export function checkLimits(limits, request = {}, { scratch = tmpdir(), platform = process.platform } = {}) {
  if (!limits || typeof limits !== 'object') return { ok: true };
  const permission = request.permission ?? 'deny';
  const result = { ok: true };

  if (limits.maxPermission !== undefined) {
    const max = PERMISSION_RANK[limits.maxPermission];
    if (max === undefined) return { ok: false, reason: `consent limits.maxPermission is invalid: ${limits.maxPermission}` };
    if ((PERMISSION_RANK[permission] ?? 0) > max) {
      return { ok: false, reason: `permission ${permission} exceeds the grant (max ${limits.maxPermission})` };
    }
  }

  if ((permission === 'allow-all' || permission === 'ask') && Array.isArray(limits.writeTrees) && request.cwd) {
    const allowed =
      isInside(request.cwd, scratch, platform) ||
      limits.writeTrees.some((tree) => isInside(request.cwd, tree, platform));
    if (!allowed) {
      return { ok: false, reason: `permission ${permission} is not granted for ${request.cwd} (not under limits.writeTrees)` };
    }
  }

  // Effective cap = the tighter of the per-call cap and what is left today.
  let cap = Infinity;
  let why = null;
  if (typeof limits.maxBudgetUsd === 'number' && Number.isFinite(limits.maxBudgetUsd)) {
    cap = limits.maxBudgetUsd;
    why = `the grant's per-call ${limits.maxBudgetUsd}`;
  }
  if (typeof limits.maxDailyUsd === 'number' && Number.isFinite(limits.maxDailyUsd)) {
    const spent = Number(request.spentToday) || 0;
    const left = limits.maxDailyUsd - spent;
    if (left <= 0.01) {
      return { ok: false, reason: `daily cap reached (${spent.toFixed(2)} of ${limits.maxDailyUsd} spent today)` };
    }
    if (left < cap) {
      cap = Math.round(left * 100) / 100;
      why = `what is left of today's ${limits.maxDailyUsd} (${cap})`;
    }
  }
  // A flat subscription has no dollar price to cap; its rationed unit is tokens.
  if (typeof limits.maxDailyTokens === 'number' && Number.isFinite(limits.maxDailyTokens)) {
    const used = Number(request.spentTokensToday) || 0;
    if (used >= limits.maxDailyTokens) {
      return { ok: false, reason: `daily token cap reached (${used} of ${limits.maxDailyTokens} tokens used today)` };
    }
  }
  // The context window is rationed too: every further tool step re-reads the
  // whole prefix, so a turn past this ceiling is cut like a budget overrun.
  if (limits.maxContextTokens !== undefined) {
    if (!Number.isFinite(limits.maxContextTokens) || limits.maxContextTokens <= 0) {
      return { ok: false, reason: `consent limits.maxContextTokens is invalid: ${limits.maxContextTokens}` };
    }
    result.contextLimit = Math.floor(limits.maxContextTokens);
  }
  // A budget that is not a positive number means "no watchdog" to hub-acp
  // (`--budget 0`, or a typo that parses to NaN). Under a capped grant that is
  // not the caller's to switch off: it gets the cap, like a missing budget.
  if (cap !== Infinity && (!(request.budget > 0) || request.budget > cap)) {
    result.budget = cap;
    if (request.budget !== undefined) result.note = `budget ${request.budget} clamped to ${why}`;
  }
  return result;
}

// Reported cost of this agent's runs on the local calendar day of `now`.
// Reads the audit log; a missing or unreadable log counts as nothing spent.
//
// The log rotates at 10 MB (log-rotation.mjs) to `<base>-<timestamp>.jsonl`. An
// archive last written today still holds part of today's spend, so it is read
// too: otherwise the day the log rotates is a day the cap starts again at zero.
export function spentToday(agentName, logPath, now = new Date()) {
  const day = now.toDateString();
  const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const files = [logPath];
  try {
    const ext = extname(logPath);
    const prefix = `${basename(logPath, ext)}-`;
    for (const name of readdirSync(dirname(logPath))) {
      if (!name.startsWith(prefix) || !name.endsWith(ext)) continue;
      const file = join(dirname(logPath), name);
      if (statSync(file).mtimeMs >= dayStart) files.push(file);
    }
  } catch { /* no directory, or an archive vanished: the live log is still counted */ }

  let total = 0;
  for (const file of files) {
    let text;
    try { text = readFileSync(file, 'utf8'); } catch { continue; }
    for (const line of text.split('\n')) {
      if (!line.includes(`"agent":"${agentName}"`)) continue;
      let rec;
      try { rec = JSON.parse(line); } catch { continue; }
      if (rec.agent !== agentName || !rec.time || new Date(rec.time).toDateString() !== day) continue;
      const amount = typeof rec.cost === 'number' ? rec.cost : rec.cost?.amount;
      if (typeof amount === 'number' && Number.isFinite(amount)) total += amount;
    }
  }
  return total;
}

// `request` is optional ({ permission, cwd, budget }); without it only the
// base rule is checked, which is what status displays use.
export function testConsent(agentName, path = CONSENT_PATH, request = null) {
  const read = readConsent(path);
  if (!read.ok) return { ok: false, reason: read.reason };

  const entry = read.grants?.[agentName];
  if (!entry || entry.enabled !== true) {
    return { ok: false, reason: 'no consent recorded (enabled is not true)' };
  }
  if (entry.overseerAck !== true) {
    return { ok: false, reason: 'Overseer has not acknowledged this grant' };
  }
  if (entry.expires) {
    const expires = Date.parse(entry.expires);
    // A date that does not parse must not read as "never expires".
    if (Number.isNaN(expires)) {
      return { ok: false, reason: `consent "expires" is not a date: ${entry.expires}` };
    }
    if (expires < Date.now()) return { ok: false, reason: `consent expired on ${entry.expires}` };
  }
  if (request) return checkLimits(entry.limits, request);
  return { ok: true };
}
