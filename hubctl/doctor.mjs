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
import { spentTodayAll, spentTokensToday } from '../acp/spend-estimate.mjs';
import { toWsl } from '../acp/paths.mjs';
import { cacheAgeMs, describeLimits, dropReset, readLimitsCache } from '../acp/codex-limits.mjs';

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
    if (typeof grant.limits.maxDailyTokens === 'number') continue; // tokens are the real cap
    const models = (catalog?.models ?? []).filter((m) => m.agent === name && m.enabled !== false);
    if (name === 'claude' || !models.length) continue;
    if (!models.some((m) => m.costPerMillion && typeof m.costPerMillion === 'object')) {
      out.push(row('spend', 'warn', `${name} has a $${grant.limits.maxDailyUsd}/day cap but no model price in models.json (costPerMillion): the cap cannot trigger and spend shows tokens only`));
    }
  }
  return out;
}

// Codex's real allowance: the plan windows the account reports (`hubctl usage` refreshes the reading).
// Silent when there is no reading or it is a day old: a stale percentage is worse than none.
export function checkCodexLimits(reading, { now = Date.now(), warnAt = 85, staleMs = 24 * 3_600_000 } = {}) {
  if (!reading || cacheAgeMs(reading, now) > staleMs) return [];
  const cache = dropReset(reading, now); // a window that reset since the reading no longer counts
  if (!cache) return [];
  const worst = Math.max(...cache.windows.map((w) => w.usedPercent));
  const line = describeLimits(cache);
  if (cache.reached || worst >= 100) return [row('codex-limits', 'fail', `codex has used its plan allowance: ${line}; runs fail until it resets`)];
  if (worst >= warnAt) return [row('codex-limits', 'warn', `codex is at ${worst}% of a plan window: ${line}`)];
  return [row('codex-limits', 'ok', `codex plan usage: ${line}`)];
}

// Same early warning for the token cap used with flat subscriptions (Codex).
export function checkDailyTokens(consent, used, threshold = 0.8) {
  const out = [];
  for (const [name, grant] of Object.entries(consent ?? {})) {
    const cap = grant?.limits?.maxDailyTokens;
    if (name.startsWith('_') || !grant?.enabled || typeof cap !== 'number' || cap <= 0) continue;
    const n = used(name);
    const fmt = (v) => (v >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : `${Math.round(v / 1e3)}k`);
    if (n >= cap) out.push(row('tokens', 'fail', `${name} hit its daily token cap: ${fmt(n)} of ${fmt(cap)}; runs are refused until tomorrow — hand off to another agent`));
    else if (n >= cap * threshold) out.push(row('tokens', 'warn', `${name} at ${Math.round((n / cap) * 100)}% of its daily token cap (${fmt(n)} of ${fmt(cap)})`));
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

// The only automated guard is the pre-commit hook, and it does nothing until
// this clone sets core.hooksPath. A clone without it believes it is tested
// because the docs say so.
export function checkHooks(root, { hooksPath = null, exists = existsSync } = {}) {
  if (hooksPath === '.githooks') {
    return [exists(join(root, '.githooks', 'pre-commit'))
      ? row('hooks', 'ok', 'core.hooksPath=.githooks; pre-commit runs the checks')
      : row('hooks', 'warn', 'core.hooksPath=.githooks but .githooks/pre-commit is missing')];
  }
  return [row('hooks', 'warn', hooksPath
    ? `core.hooksPath is ${hooksPath}, not .githooks: the pre-commit checks do not run`
    : 'core.hooksPath is not set: the pre-commit checks do not run (git config core.hooksPath .githooks)')];
}

/** Probe http://127.0.0.1:<port><path> with a hard timeout; never throws. */
export function probeLocal(port, path = '/health', timeoutMs = 1500) {
  const code = `fetch('http://127.0.0.1:${port}${path}',{signal:AbortSignal.timeout(${timeoutMs})}).then(r=>process.exit(r.ok?0:2),()=>process.exit(1))`;
  const r = spawnSync(process.execPath, ['-e', code], { timeout: timeoutMs + 1500, windowsHide: true });
  return { ok: r.status === 0 };
}

// The AHP gateway is what VS Code's Agents window connects to (chat.remoteAgentHosts).
// logs/ahp-gateway.json exists once it has been generated, i.e. once someone meant to use it.
export function checkGateway(configured, health) {
  if (!configured || health == null) return [];
  return [health.ok
    ? row('gateway', 'ok', 'answers on /healthz (the AHP host for VS Code Agents is reachable)')
    : row('gateway', 'warn', 'configured but not answering on /healthz: start it with agent-hub/tools/run-ahp-gateway.ps1 or the AgentHub host in VS Code Agents fails')];
}

export function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Runs `run` until `isBad(result)` is false, at most `tries` times with a pause between.
// Probes of lazily started things (OpenCode's MCP servers) need time, not just a second look.
export function withRetries(run, isBad, { tries = 3, pauseMs = 2500, sleep = sleepSync } = {}) {
  let result = run();
  for (let i = 1; i < tries && isBad(result); i++) {
    sleep(pauseMs);
    result = run();
  }
  return result;
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

// The handoff is the baton for the next session: warn when commits landed well
// after it was last written, or when it names a commit that no longer exists.
export function checkHandoffFresh({ handoffMtimeMs, lastCommitMs, text = '', commitExists = () => true, maxHours = 24 }) {
  if (handoffMtimeMs == null) return [];
  const out = [];
  if (lastCommitMs != null && lastCommitMs - handoffMtimeMs > maxHours * 3_600_000) {
    const hours = Math.round((lastCommitMs - handoffMtimeMs) / 3_600_000);
    out.push(row('handoff', 'warn', `working/HANDOFF.md is ${hours}h older than the last commit; update it before relying on it`));
  }
  const hashes = new Set();
  for (const m of String(text).matchAll(/`([0-9a-f]{7,12})`/g)) {
    if (/\d/.test(m[1]) && /[a-f]/.test(m[1])) hashes.add(m[1]);
  }
  const gone = [...hashes].filter((h) => !commitExists(h));
  if (gone.length) out.push(row('handoff', 'warn', `working/HANDOFF.md names commit(s) not in git log: ${gone.join(', ')}`));
  if (!out.length) out.push(row('handoff', 'ok', 'working/HANDOFF.md is current'));
  return out;
}

function gitOut(root, args) {
  const r = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', windowsHide: true });
  return r.status === 0 ? r.stdout.trim() : null;
}

function handoffInputs(root, stateDir) {
  const file = join(stateDir, 'working', 'HANDOFF.md');
  if (!existsSync(file)) return null;
  const ct = gitOut(root, ['log', '-1', '--format=%ct']);
  return {
    handoffMtimeMs: statSync(file).mtimeMs,
    lastCommitMs: ct ? Number(ct) * 1000 : null,
    text: readFileSync(file, 'utf8'),
    commitExists: (hash) => gitOut(root, ['cat-file', '-e', `${hash}^{commit}`]) !== null,
  };
}

// Parses `opencode mcp list`. Missing servers are a fail: the daily surface
// could not reach the hub.
export function checkOpencodeMcp(output, expected = ['agent-hub', 'playwright']) {
  if (output == null) return [row('opencode', 'warn', 'opencode mcp list not run (OpenCode unavailable or --fast)')];
  const clean = String(output).replace(/\x1b\[[0-9;]*m/g, '');
  return expected.map((name) => {
    const state = new RegExp(`\\S\\s+${name}\\s+(\\w+)`).exec(clean)?.[1] ?? null;
    if (state === 'connected') return row('opencode', 'ok', `${name} connected`);
    // OpenCode starts MCP servers lazily: "pending" is a server still coming up,
    // not a broken one, so it must not fail the whole check.
    if (state === 'pending') return row('opencode', 'warn', `${name} is still starting in OpenCode (pending)`);
    return row('opencode', 'fail', `${name} is not connected in OpenCode`);
  });
}

function listCurrentDocs(root) {
  // The owner's batons (ROADMAP, HANDOFF, JOURNAL) live in working/ and are not
  // checked here: they are personal and git-ignored, not part of the public tree.
  const docs = ['AGENTS.md', 'README.md', 'docs/reference/agent/README.md'];
  const walk = (dir) => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (name === 'history' || name === 'node_modules' || name === 'results' || name === 'workspace-root' || name.startsWith('.')) continue;
      if (statSync(full).isDirectory()) walk(full);
      else if (name.endsWith('.md')) docs.push(relative(root, full));
    }
  };
  walk(root);
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

export function gatherDoctor({ root, stateDir = join(dirname(root), 'projects'), hub, readJson, inflight, locks, fast = false, codexCache = null }) {
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
  if (consent) checks.push(...checkDailySpend(consent, (name) => spentTodayAll(name, process.env.AGENT_HUB_LOG ?? join(stateDir, 'logs', 'runs.jsonl'))));
  if (consent) checks.push(...checkDailyTokens(consent, (name) => spentTokensToday(name)));
  if (consent?.codex?.enabled) checks.push(...checkCodexLimits(readLimitsCache(join(stateDir, 'logs', 'codex-limits.json'))));
  if (consent && catalog) checks.push(...checkUnpricedCaps(consent, catalog));
  if (registry) checks.push(...checkCodexAdapter(registry));
  if (catalog) {
    checks.push(...checkFrontier(catalog));
    // --fast (hubctl brief/wrap) skips the cache comparison on purpose: passing a
    // null cache used to turn "not looked at" into a permanent warning.
    if (!fast && registry?.agents?.codex) checks.push(...checkCodexModels(catalog, codexCache));
  }
  checks.push(...checkLinks(root, listCurrentDocs(root)));
  checks.push(...checkLeftovers(inflight, locks));
  const gatewayConfig = readJson(join(stateDir, 'logs', 'ahp-gateway.json'));
  if (gatewayConfig) checks.push(...checkGateway(true, probeLocal(gatewayConfig.listener?.port ?? 8765, '/healthz')));
  checks.push(...checkHooks(root, { hooksPath: gitOut(root, ['config', 'core.hooksPath']) }));
  const handoff = handoffInputs(root, stateDir);
  if (handoff) checks.push(...checkHandoffFresh(handoff));
  // OpenCode starts its MCP servers lazily; on a loaded machine the first listing
  // can say "not connected" for a server that is a moment from ready. Look up to
  // three times, a few seconds apart, before reporting a failure. --fast does not query OpenCode at all, so it must
  // not report that query as a warning either.
  if (!fast) {
    checks.push(...withRetries(
      () => checkOpencodeMcp(runOpencodeMcpList(root)),
      (found) => found.some((c) => c.level === 'fail'),
    ));
  }
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
