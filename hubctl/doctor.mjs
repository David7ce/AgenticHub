// doctor.mjs — "is the hub's configuration coherent?" in one call.
//
// `status` answers "what is the hub doing"; `doctor` answers "would the next
// dispatch behave the way the docs say". Each check is a pure function over
// data already on disk, so the tests feed it fixtures. Read-only: it never
// fixes anything, it says what to fix.
//
// Levels: ok · warn (works, but drifts from intent) · fail (a dispatch would
// be wrong or impossible). `hubctl doctor` exits 1 when anything fails.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, relative, resolve } from 'node:path';
import { PERMISSION_RANK } from '../acp/consent.mjs';
import { spentTodayAll } from '../acp/spend-estimate.mjs';
import { toWsl } from '../acp/paths.mjs';

const DAY = 86_400_000;

// Consent trees are written with Windows drive letters. A WSL doctor run can
// still check them by translating the path before stat().
export function pathExists(target, { platform = process.platform } = {}) {
  if (existsSync(target)) return true;
  if (platform === 'win32') return false;
  try { return existsSync(toWsl(target)); } catch { return false; }
}
const EXPIRY_WARN_DAYS = 14;

const row = (check, level, detail) => ({ check, level, detail });

// Registry and gate must name the same agents: a registered agent without a
// grant is an accident waiting to be "fixed" by someone adding enabled:true.
export function checkRegistryConsent(registry, consent) {
  const out = [];
  const registered = Object.keys(registry?.agents ?? {});
  const granted = Object.keys(consent ?? {}).filter((name) => !name.startsWith('_'));
  for (const name of registered) {
    if (!granted.includes(name)) out.push(row('registry', 'fail', `${name} is in acp/agents.json but has no consent entry (add one, enabled:false if unsure)`));
  }
  for (const name of granted) {
    if (consent[name]?.enabled === true && !registered.includes(name)) {
      out.push(row('registry', 'fail', `${name} is enabled in consent.json but not in acp/agents.json`));
    }
  }
  if (!out.length) out.push(row('registry', 'ok', `${registered.length} agents, all with a consent entry`));
  return out;
}

export function checkGrants(consent, { now = Date.now(), exists = existsSync } = {}) {
  const out = [];
  for (const [name, grant] of Object.entries(consent ?? {})) {
    if (name.startsWith('_') || grant?.enabled !== true) continue;
    if (grant.overseerAck !== true) out.push(row('consent', 'warn', `${name} is enabled but not acknowledged`));

    const expires = grant.expires ? Date.parse(grant.expires) : null;
    if (!expires) out.push(row('consent', 'warn', `${name} has no expiry`));
    else if (expires <= now) out.push(row('consent', 'fail', `${name} expired on ${grant.expires}`));
    else {
      const days = Math.ceil((expires - now) / DAY);
      out.push(row('consent', days <= EXPIRY_WARN_DAYS ? 'warn' : 'ok', `${name} expires in ${days} d (${grant.expires.slice(0, 10)})`));
    }

    const limits = grant.limits;
    if (!limits) {
      out.push(row('limits', 'warn', `${name} has no machine-readable limits; its scope is prose only`));
      continue;
    }
    if (limits.maxPermission !== undefined && PERMISSION_RANK[limits.maxPermission] === undefined) {
      out.push(row('limits', 'fail', `${name} limits.maxPermission is invalid: ${limits.maxPermission}`));
    }
    for (const tree of limits.writeTrees ?? []) {
      if (!exists(tree)) out.push(row('limits', 'fail', `${name} write tree does not exist: ${tree}`));
    }
    out.push(row('limits', 'ok',
      `${name}: max ${limits.maxPermission ?? 'any'}, ${limits.writeTrees ? `${limits.writeTrees.length} write trees` : 'any tree'}` +
      `, budget ${typeof limits.maxBudgetUsd === 'number' ? `≤ $${limits.maxBudgetUsd}` : 'not capped by consent'}` +
      `${typeof limits.maxDailyUsd === 'number' ? `, ≤ $${limits.maxDailyUsd}/day` : ''}`));

    // The prose scope often promises a per-call cap. If the enforced value
    // disagrees, one of the two is wrong and only the owner can say which.
    const promised = String(grant.scope ?? '').match(/(\d+(?:[.,]\d+)?)\s*USD/i);
    if (promised) {
      const amount = Number(promised[1].replace(',', '.'));
      if (limits.maxBudgetUsd !== amount) {
        out.push(row('budget', 'warn',
          `${name} scope text says ${amount} USD per call but consent enforces ` +
          `${typeof limits.maxBudgetUsd === 'number' ? `$${limits.maxBudgetUsd}` : 'no cap'} (MCP default is $3)`));
      }
    }
  }
  return out;
}

// Relative markdown links whose target is missing. External links, anchors
// and mailto are ignored; so are history snapshots, which are frozen on purpose.
const LINK = /\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
// A dollar cap on an agent whose runs report no cost can never trigger.
export function checkUnpricedCaps(consent, catalog) {
  const out = [];
  for (const [name, grant] of Object.entries(consent ?? {})) {
    if (name.startsWith('_') || !grant?.enabled || typeof grant?.limits?.maxDailyUsd !== 'number') continue;
    const models = (catalog?.models ?? []).filter((m) => m.agent === name && m.enabled !== false);
    if (name === 'claude' || !models.length) continue;
    if (!models.some((m) => m.costPerMillion && typeof m.costPerMillion === 'object')) {
      out.push(row('spend', 'warn', `${name} has a $${grant.limits.maxDailyUsd}/day cap but no model price in models.json (costPerMillion): the cap cannot trigger and spend shows tokens only`));
    }
  }
  return out;
}

// Warn before the daily cap bites: at 80 % the next run may be refused.
export function checkDailySpend(consent, spent, threshold = 0.8) {
  const out = [];
  for (const [name, grant] of Object.entries(consent ?? {})) {
    const cap = grant?.limits?.maxDailyUsd;
    if (name.startsWith('_') || !grant?.enabled || typeof cap !== 'number' || cap <= 0) continue;
    const used = spent(name);
    if (used >= cap) out.push(row('spend', 'fail', `${name} hit its daily cap: $${used.toFixed(2)} of $${cap}; runs are refused until tomorrow — hand off to another agent`));
    else if (used >= cap * threshold) out.push(row('spend', 'warn', `${name} at ${Math.round((used / cap) * 100)}% of its daily cap ($${used.toFixed(2)} of $${cap})`));
  }
  return out;
}

export function findBrokenLinks(files, { read = (p) => readFileSync(p, 'utf8'), exists = existsSync } = {}) {
  const broken = [];
  for (const file of files) {
    let text;
    try { text = read(file); } catch { continue; }
    // Links inside code are examples, not references.
    text = text.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '');
    for (const match of text.matchAll(LINK)) {
      const target = match[1];
      if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('#')) continue;
      const path = decodeURIComponent(target.split('#')[0]);
      if (!path) continue;
      if (!exists(resolve(dirname(file), path))) broken.push({ file, target });
    }
  }
  return broken;
}

export function checkLinks(root, files, deps) {
  const broken = findBrokenLinks(files, deps);
  if (!broken.length) return [row('docs', 'ok', `${files.length} current docs, no broken relative links`)];
  return broken.map(({ file, target }) => row('docs', 'warn', `${relative(root, file).replace(/\\/g, '/')} → ${target}`));
}

export function checkLeftovers(inflight, locks) {
  const out = [];
  for (const run of inflight) {
    if (run.alive === false) out.push(row('inflight', 'warn', `stale inflight for pid ${run.pid} (${run.agent}); the process is gone`));
  }
  for (const lock of locks) {
    if (lock.alive === false) out.push(row('locks', 'warn', `stale tree lock on ${lock.cwd} (pid ${lock.pid} is gone)`));
  }
  if (!out.length) out.push(row('runtime', 'ok', `${inflight.length} inflight, ${locks.length} locks, none stale`));
  return out;
}

// Parses `opencode mcp list`. Missing servers are a fail: the daily surface
// could not reach the hub.
export function checkOpencodeMcp(output, expected = ['agent-hub', 'playwright']) {
  if (output == null) return [row('opencode', 'warn', 'opencode mcp list not run (OpenCode unavailable or --fast)')];
  const clean = String(output).replace(/\x1b\[[0-9;]*m/g, '');
  return expected.map((name) =>
    new RegExp(`✓\\s+${name}\\s+connected`).test(clean)
      ? row('opencode', 'ok', `${name} connected`)
      : row('opencode', 'fail', `${name} is not connected in OpenCode`));
}

function listCurrentDocs(root) {
  // The owner's batons (ROADMAP, HANDOFF, JOURNAL) live in working/ and are not
  // checked here: they are personal and git-ignored, not part of the public tree.
  const docs = ['AGENTS.md', 'README.md', 'CLAUDE.md', 'docs/agent/README.md'];
  const walk = (dir) => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (name === 'history' || name === 'node_modules' || name === 'results') continue;
      if (statSync(full).isDirectory()) walk(full);
      else if (name.endsWith('.md')) docs.push(relative(root, full));
    }
  };
  walk(join(root, 'agent-hub'));
  return [...new Set(docs)].map((p) => join(root, p)).filter((p) => existsSync(p));
}

function runOpencodeMcpList(root) {
  const opts = { encoding: 'utf8', timeout: 60_000, windowsHide: true };
  // OpenCode runs natively on Windows since 2026-11-09 (opencode.cmd acp); the
  // WSL reach-in was retired with the registry entry.
  const result = process.platform === 'win32'
    ? spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'opencode mcp list'],
      { ...opts, cwd: root, windowsVerbatimArguments: true })
    : spawnSync('opencode', ['mcp', 'list'], { ...opts, cwd: root });
  return result.status === 0 ? result.stdout : null;
}

// --- Codex -------------------------------------------------------------------

const FAMILY = /^gpt-(\d+(?:\.\d+)?)-(sol|terra|luna|astra)$/;

// The frozen adapter embeds Codex 0.137 and fails on 6.x models; the hub must
// never launch it again. Only what is executed counts, not the notes.
export function checkCodexAdapter(registry) {
  const codex = registry?.agents?.codex;
  if (!codex) return [];
  const launched = JSON.stringify([codex.command, codex.args, codex.platforms]);
  if (launched.includes('@zed-industries/codex-acp')) {
    return [row('codex', 'fail', 'codex uses the frozen @zed-industries/codex-acp; use @agentclientprotocol/codex-acp')];
  }
  const pin = (codex.args ?? []).find((arg) => /codex-acp@\d/.test(arg));
  return pin
    ? [row('codex', 'ok', `adapter ${pin}`)]
    : [row('codex', 'warn', 'codex adapter is not pinned to an exact version')];
}

// Highest version per family in ~/.codex/models_cache.json.
export function latestCodexModels(cache) {
  const latest = {};
  for (const model of cache?.models ?? []) {
    const match = FAMILY.exec(model.slug ?? '');
    if (!match) continue;
    const [, version, family] = match;
    if (!latest[family] || Number(version) > Number(latest[family].version)) {
      latest[family] = { slug: model.slug, version };
    }
  }
  return latest;
}

export function compareCodexCatalog(catalog, latest) {
  const ids = new Set((catalog?.models ?? []).filter((m) => m.agent === 'codex').map((m) => m.id));
  return Object.entries(latest).map(([family, { slug }]) => ({ family, latest: slug, inCatalog: ids.has(slug) }));
}

export function checkCodexModels(catalog, cache) {
  if (!cache) return [row('models', 'warn', '~/.codex/models_cache.json not found; cannot tell whether models.json is current')];
  const rows = compareCodexCatalog(catalog, latestCodexModels(cache));
  const behind = rows.filter((r) => !r.inCatalog);
  if (!behind.length) return [row('models', 'ok', `codex catalog current: ${rows.map((r) => r.latest).join(', ')}`)];
  return behind.map((r) => row('models', 'warn', `models.json is behind: newest ${r.family} is ${r.latest}`));
}

export function checkFrontier(catalog) {
  const on = (catalog?.models ?? []).filter((m) => m.tier === 'frontier' && m.enabled === true);
  if (!on.length) return [row('models', 'ok', 'frontier models (Astra, Opus) are explicit-only')];
  return on.map((m) => row('models', 'warn', `${m.id} is frontier but enabled for routing; it should be explicit-only`));
}

export function gatherDoctor({ root, hub, readJson, inflight, locks, fast = false, codexCache = null }) {
  const consent = readJson(join(hub, 'consent.json'));
  const localRegistry = join(hub, 'acp', 'agents.json');
  const usingExample = !existsSync(localRegistry);
  const registry = readJson(usingExample ? join(hub, 'acp', 'agents.example.json') : localRegistry);
  const catalog = readJson(join(hub, 'models.json'));
  const checks = [];
  if (!consent) checks.push(row('consent', 'fail', 'consent.json is missing or not valid JSON'));
  if (!registry) checks.push(row('registry', 'fail', 'acp/agents.json is missing or not valid JSON'));
  else if (usingExample) checks.push(row('registry', 'warn', 'using agents.example.json; copy it to acp/agents.json and set your agent paths'));
  if (consent && registry) checks.push(...checkRegistryConsent(registry, consent));
  if (consent) checks.push(...checkGrants(consent, { exists: pathExists }));
  if (consent) checks.push(...checkDailySpend(consent, (name) => spentTodayAll(name, process.env.AGENT_HUB_LOG ?? join(root, 'logs', 'runs.jsonl'))));
  if (consent && catalog) checks.push(...checkUnpricedCaps(consent, catalog));
  if (registry) checks.push(...checkCodexAdapter(registry));
  if (catalog) {
    checks.push(...checkFrontier(catalog));
    if (registry?.agents?.codex) checks.push(...checkCodexModels(catalog, codexCache));
  }
  checks.push(...checkLinks(root, listCurrentDocs(root)));
  checks.push(...checkLeftovers(inflight, locks));
  checks.push(...checkOpencodeMcp(fast ? null : runOpencodeMcpList(root)));
  const counts = { ok: 0, warn: 0, fail: 0 };
  for (const check of checks) counts[check.level] += 1;
  return { now: new Date().toISOString(), ok: counts.fail === 0, counts, checks };
}

export function renderDoctor(report, { paint = (_, text) => text } = {}) {
  const mark = { ok: paint('32', 'ok  '), warn: paint('33', 'warn'), fail: paint('31', 'FAIL') };
  const lines = report.checks.map((c) => `${mark[c.level]}  ${c.check.padEnd(9)} ${c.detail}`);
  lines.push('', `${report.counts.ok} ok · ${report.counts.warn} warn · ${report.counts.fail} fail`);
  return lines.join('\n');
}
