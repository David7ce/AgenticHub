#!/usr/bin/env node
// router.mjs — pick a worker agent for a task, then hand off to hub-acp.mjs.
//
//   node router.mjs --prompt "..."
//   node router.mjs --prompt - < task.txt
//   node router.mjs --prompt "..." --explain      # print the pick, don't run it
//   node router.mjs --prompt "..." --force claude # skip the heuristic
//
// Every other hub-acp.mjs flag (--cwd, --mcp, --permission, --budget,
// --timeout, --config, --json, --no-save, --verbose) passes through
// unchanged -- this file's only job is choosing --agent, not re-doing
// what hub-acp.mjs already does for one agent run.
//
// Two workers are routing targets: opencode (cheap, fast) and claude
// (expensive, strongest reasoning). Hermes was removed from the registry on
// 2026-11-08; Codex is blocked by its ACP adapter. The hub itself orchestrates
// -- no registered agent decomposes tasks.
//
// Why a rule list and not a model call to classify the task: a classifier
// call would add cost and latency to every single routed prompt, including
// the cheap ones -- the opposite of what routing is for here. Verified
// cost/speed this fleet actually produced (acp/README.md "Verified" table,
// 2026-10-26/27): opencode ~$0.0006-0.0008 and ~5s; claude ~$0.23 and
// ~12-13s -- roughly 300-400x the cost for a model call that's slower too.
// Default cheap, escalate on explicit signal, never guess with another
// paid call.
//
// Health/cost awareness (2026-10-29) reads the last 24 h of this fleet's
// own audit log, logs/runs.jsonl, on top of the prompt rule list:
//   - the preferred agent having recent failures/timeouts (15 min) moves
//     the pick to the other one, if that one is healthy;
//   - a prompt that would escalate to claude does not, once claude's 24 h
//     spend has passed --cost-ceiling (default $2). --force claude still
//     overrides this.
// Live concurrency ("is the agent busy right now") is not observable from
// the log -- a run only gets a record when it finishes -- so this is
// health/cost-aware, not true load-aware.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
// Local registry first; a fresh clone runs with the shipped example.
export const DEFAULT_REGISTRY = existsSync(join(HERE, 'agents.json'))
  ? join(HERE, 'agents.json')
  : join(HERE, 'agents.example.json');
const HUB = join(HERE, 'hub-acp.mjs');
const DEFAULT_LOG = join(HERE, '..', '..', 'logs', 'runs.jsonl');

const CHEAP_AGENT = 'opencode';
const STRONG_AGENT = 'claude';

const RECENT_FAILURE_WINDOW_MS = 15 * 60 * 1000;
const STATS_WINDOW_MS = 24 * 60 * 60 * 1000;
const DEFAULT_COST_CEILING = 3.0;

// Two kinds of signal justify the ~300-400x cost step up, and only two:
//   - scope: the change reaches further than one edit;
//   - consequence: a mistake is expensive or irreversible.
//
// Difficulty words are deliberately absent. The bench (2026-10-30) put 15
// attempts through the cheap worker — module rebuilds, prose specs judged by a
// hidden test, a two-module construct — and it failed none, so "explain",
// "why", "debug", "edge case" and "trade-offs" were escalating ordinary work
// to the weekly Claude quota for no measured reason.
const SCOPE_PATTERNS = [
  /\bmulti-?file\b/i,
  /\bbreaking change\b/i,
  /\bmigrat(e|ion)\b/i,
  /\brefactor/i,
  /\bpublic (api|interface)\b/i,
  /\b(rename|move|delete) (across|every|all)\b/i,
  /\b(across|every|all) (the )?(files?|modules?|packages?|repos?)\b/i,
  /\b(several|multiple) (files?|modules?|packages?)\b/i,
  /\b(varios|varias|m[uú]ltiples) (archivos?|m[oó]dulos?|paquetes?)\b/i,
  /\b(multi-?archivo|multi-?m[oó]dulo)\b/i,
  /\b(renombrar|renombra|migrar|migraci[oó]n|refactorizar|refactoriza)\b/i,
];

const CONSEQUENCE_PATTERNS = [
  /\bsecurity\b/i,
  /\bvulnerab(le|ility)\b/i,
  /\b(credentials?|secrets?|tokens?|passwords?)\b/i,
  /\bpermissions?\b/i,
  /\b(payments?|billing|charges?|money)\b/i,
  /\bproduction\b/i,
  /\b(permisos?|secretos?|credenciales?|contrase[nñ]as?|pagos?|dinero|producci[oó]n|seguridad|vulnerabilidad)\b/i,
];

// A long ask usually carries more context, but length is not evidence: the
// bench's prose specs were ~500 chars and the cheap worker handled them. Kept
// as a weak signal at a threshold well above those, not as a difficulty proxy.
const LONG_PROMPT_CHARS = 1200;

/**
 * Pure, synchronous, free: no network call, no model, just the prompt
 * text and a short list of rules. Returns { agent, reason }.
 */
function decideFromPrompt(prompt) {
  const text = prompt ?? '';
  for (const [kind, patterns] of [
    ['scope', SCOPE_PATTERNS],
    ['consequence', CONSEQUENCE_PATTERNS],
  ]) {
    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match) {
        return {
          agent: STRONG_AGENT,
          reason: `${kind} signal /${pattern.source}/i: "${match[0]}"`,
        };
      }
    }
  }
  if (text.length > LONG_PROMPT_CHARS) {
    return {
      agent: STRONG_AGENT,
      reason: `prompt is ${text.length} chars (> ${LONG_PROMPT_CHARS}), a large context`,
    };
  }
  return { agent: CHEAP_AGENT, reason: 'no scope or consequence signal; the cheap worker handles it' };
}

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

/**
 * Prompt rules plus the audit-log health/cost overlay. Pure: `stats` and
 * `now` are passed in, so tests can pin both.
 *
 * `costCeiling` is USD over the last 24 h; 0 (or negative) disables the
 * cost rule. `health: false` disables the whole overlay.
 */
export function decideAgent(prompt, {
  stats = null,
  costCeiling = DEFAULT_COST_CEILING,
  health = true,
} = {}) {
  const base = decideFromPrompt(prompt);
  if (!health || !stats) return base;

  const cheap = stats[CHEAP_AGENT];
  const strong = stats[STRONG_AGENT];
  if (!cheap || !strong) return base;

  const cheapUnhealthy = cheap.recentFailures >= 2;
  const strongUnhealthy = strong.recentFailures >= 1;
  const strongOverBudget = costCeiling > 0 && strong.cost > costCeiling;

  if (base.agent === STRONG_AGENT) {
    if (strongUnhealthy && !cheapUnhealthy) {
      return {
        agent: CHEAP_AGENT,
        reason:
          `${base.reason}; but ${STRONG_AGENT} has ${strong.recentFailures} failure/timeout(s) ` +
          `in the last ${RECENT_FAILURE_WINDOW_MS / 60000} min`,
      };
    }
    if (strongOverBudget) {
      return {
        agent: CHEAP_AGENT,
        reason:
          `${base.reason}; but ${STRONG_AGENT} spent $${strong.cost.toFixed(2)} in 24 h ` +
          `(ceiling $${costCeiling.toFixed(2)}) -- use --force claude to override`,
      };
    }
    return base;
  }

  if (cheapUnhealthy && !strongUnhealthy) {
    return {
      agent: STRONG_AGENT,
      reason:
        `${base.reason}; but ${CHEAP_AGENT} has ${cheap.recentFailures} failure/timeout(s) ` +
        `in the last ${RECENT_FAILURE_WINDOW_MS / 60000} min, escalating`,
    };
  }

  return base;
}

const MODELS_PATH = join(HERE, '..', 'models.json');

/** Read the local catalog; a missing/broken file degrades to no model hint. */
export function readCatalog(path = MODELS_PATH) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return { providers: {}, models: [] }; }
}

function modelFor(catalog, agent) {
  // `frontier` (Astra, Opus) is never an automatic pick, even if someone
  // flips it to enabled: it is reached only through an explicit --model.
  const models = (catalog?.models ?? []).filter((m) => m.enabled && m.agent === agent && m.tier !== 'frontier');
  const order = { default: 0, strong: 0.5, review: 1, light: 1.5, fallback: 2, capacity: 3, 'free-text': 4 };
  models.sort((a, b) => (order[a.tier] ?? 9) - (order[b.tier] ?? 9));
  return models[0] ?? null;
}

/**
 * Advisory route: which worker, which model, which topology, and why.
 * It never launches anything; `--explain` prints it and the caller decides.
 */
export function decideRoute(prompt, {
  stats = null,
  costCeiling = DEFAULT_COST_CEILING,
  dailyCeiling = 3,
  health = true,
  force = null,
  review = false,
  catalog = null,
} = {}) {
  const base = force
    ? { agent: force, reason: '--force override' }
    : decideAgent(prompt, { stats, costCeiling, health });
  const catalogData = catalog ?? readCatalog();

  // Daily ceiling is a hard stop for escalation, not a per-call budget.
  let agent = base.agent;
  let reason = base.reason;
  if (stats && dailyCeiling > 0) {
    const spent = (stats.opencode?.cost ?? 0) + (stats.claude?.cost ?? 0);
    if (spent >= dailyCeiling && agent === STRONG_AGENT) {
      agent = CHEAP_AGENT;
      reason = `${reason}; daily ceiling reached ($${spent.toFixed(2)} >= $${dailyCeiling.toFixed(2)})`;
    }
  }

  const model = modelFor(catalogData, agent);
  const wantsReview = review || /\b(review|revisa|revisión|cross-?check|second opinion)\b/i.test(String(prompt ?? ''));
  const topology = wantsReview && agent === CHEAP_AGENT ? 'review' : 'solo';
  const fallbacks = modelChain(readAgentEntry(
    process.env.AGENT_HUB_REGISTRY ?? DEFAULT_REGISTRY,
    agent,
  )).filter((id) => id !== model?.id);

  return {
    agent,
    model: model?.id ?? null,
    tier: model?.tier ?? null,
    topology,
    reason,
    fallbacks,
  };
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

function usageAndExit(code) {
  process.stderr.write(
    `usage: node router.mjs --prompt TEXT|- [--force opencode|claude] [--explain] [--json] [--review]\n` +
      `       [--cost-ceiling USD (default ${DEFAULT_COST_CEILING}, 0 disables)] [--daily-ceiling USD (default 3)]\n` +
      `       [--no-health]\n` +
      `       [--no-failover] [--log FILE] [hub-acp.mjs options...]\n`,
  );
  process.exit(code);
}

// Same approach hub-acp.mjs uses for `--prompt -`: a synchronous read of
// fd 0. Read here (not left as '-' for hub-acp.mjs to read itself)
// because the classifier needs the real text before it can decide --
// the resolved string is what gets passed through, stdin is consumed
// exactly once.
function readPrompt(promptArg) {
  if (promptArg !== '-') return promptArg;
  return readFileSync(0, 'utf8');
}

// A pool that is out of quota is not a failed task: it is the other pool's
// turn. Matched against the error text hub-acp reports, because neither
// provider exposes a distinct exit code for "exhausted".
export function isQuotaError(text) {
  if (!text) return false;
  return /\b(429|quota|rate.?limit|usage limit|weekly limit|insufficient|exceeded|allowance|credits?)\b/i.test(
    text,
  );
}

/**
 * Who takes over when `agent` is out of quota. The registry entry may list
 * `agentFallbacks` (in order); without it the old two-pool swap applies.
 */
export function agentChain(entry, agent) {
  const listed = (entry?.agentFallbacks ?? []).filter((n) => typeof n === 'string' && n && n !== agent);
  return listed.length ? [...new Set(listed)] : [otherAgent(agent)];
}

export function otherAgent(agent) {
  return agent === CHEAP_AGENT ? STRONG_AGENT : CHEAP_AGENT;
}

// ── model fallback ──────────────────────────────────────────────────────────
//
// The registry's defaultConfig.model is a free model on purpose (spend policy),
// and free pools answer "Free usage limit reached" hours before the paid ones
// are touched. That is not a failed task, it is a price step: walk the agent's
// `modelFallbacks` in order and let the first model that answers do the work.
//
// The order in agents.json is by price and measured quality (2026-11-03,
// USD per million tokens input/output from `opencode models`):
//   opencode/deepseek-v4.1-flash-free   0/0
//   opencode-go/deepseek-v4.1-flash     0.15/0.60  best agentic score in the catalog
//   opencode-go/claude-haiku-5-5        0.10/0.50  review tier, cheapest capable
//   opencode-go/mimo-v2.5               0.14/0.28  cheapest paid output
//
// An explicit --model is a decision, not a hint: the chain is not walked.

export function modelChain(entry, { requested } = {}) {
  if (requested) return [requested];
  const chain = [entry?.defaultConfig?.model, ...(entry?.modelFallbacks ?? [])];
  return [...new Set(chain.filter((name) => typeof name === 'string' && name.trim()))];
}

export function readAgentEntry(registryPath, name) {
  try {
    const raw = JSON.parse(readFileSync(registryPath, 'utf8'));
    return raw?.agents?.[name] ?? null;
  } catch {
    return null;
  }
}

/** True when the failure is "this pool is empty", not "this task failed". */
export function shouldTryNextModel(result) {
  if (!result || result.ok === true) return false;
  return isQuotaError(result.error ?? result.status ?? '');
}

/** "free: failed → go: ok", for the audit line and the answer to the caller. */
export function describeAttempts(attempts) {
  return (attempts ?? []).map((attempt) => `${attempt.model}: ${attempt.status}`).join(' → ');
}

function main() {
  const argv = process.argv.slice(2);
  let promptArg = null;
  let force = null;
  let explain = false;
  let jsonOut = false;
  let review = false;
  let dailyCeiling = 3;
  let health = true;
  let failover = true;
  let costCeiling = DEFAULT_COST_CEILING;
  let logPath = DEFAULT_LOG;
  const passthrough = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--prompt') {
      promptArg = argv[++i];
    } else if (arg === '--force') {
      force = argv[++i];
    } else if (arg === '--explain') {
      explain = true;
    } else if (arg === '--json') {
      jsonOut = true;
    } else if (arg === '--review') {
      review = true;
    } else if (arg === '--daily-ceiling') {
      dailyCeiling = Number(argv[++i]);
      if (!Number.isFinite(dailyCeiling) || dailyCeiling < 0) {
        process.stderr.write('--daily-ceiling must be zero or a positive number\n');
        process.exit(1);
      }
    } else if (arg === '--no-failover') {
      failover = false;
    } else if (arg === '--no-health') {
      health = false;
    } else if (arg === '--cost-ceiling') {
      costCeiling = Number(argv[++i]);
      if (!Number.isFinite(costCeiling) || costCeiling < 0) {
        process.stderr.write('--cost-ceiling must be zero or a positive number\n');
        process.exit(1);
      }
    } else if (arg === '--log') {
      logPath = argv[++i];
    } else if (arg === '--help' || arg === '-h') {
      usageAndExit(0);
    } else {
      passthrough.push(arg);
    }
  }

  if (promptArg === null) usageAndExit(1);
  if (force && force !== CHEAP_AGENT && force !== STRONG_AGENT) {
    process.stderr.write(`--force must be ${CHEAP_AGENT} or ${STRONG_AGENT}\n`);
    process.exit(1);
  }

  const prompt = readPrompt(promptArg);
  const stats = health ? readRunStats(logPath) : null;
  const decision = decideRoute(prompt, {
    stats, costCeiling, dailyCeiling, health, force, review,
  });

  if (explain) {
    if (jsonOut) {
      process.stdout.write(`${JSON.stringify({ ...decision, stats }, null, 2)}\n`);
    } else {
      process.stdout.write(
        `${decision.agent}  model=${decision.model ?? '?'}  topology=${decision.topology}  (${decision.reason})\n`,
      );
      if (decision.fallbacks.length) process.stdout.write(`fallbacks: ${decision.fallbacks.join(', ')}\n`);
      if (stats) process.stdout.write(`stats: ${describeStats(stats)}\n`);
    }
    return;
  }

  process.stderr.write(`[router] -> ${decision.agent}: ${decision.reason}\n`);

  const run = (agent, model) => {
    const extra = model ? ['--model', model] : [];
    const result = spawnSync(
      process.execPath,
      [HUB, '--agent', agent, '--prompt', prompt, ...passthrough, ...extra],
      {
        // stdout is captured rather than inherited: with --json the quota
        // error lives inside the JSON, and the router has to read it to know
        // the next model is worth trying. The kept attempt is re-emitted, so
        // the caller still sees exactly one answer.
        stdio: ['inherit', 'pipe', 'pipe'],
        windowsHide: true,
        maxBuffer: 64 * 1024 * 1024,
      },
    );
    const stdout = result.stdout ? result.stdout.toString() : '';
    const stderr = result.stderr ? result.stderr.toString() : '';
    if (stderr) process.stderr.write(stderr);
    return { status: result.status ?? 1, stdout, stderr };
  };

  // Both streams: the quota message is on stderr for a human run and inside
  // the JSON on stdout for --json.
  const failureText = (result) => `${result.stderr}\n${result.stdout}`;
  const emit = (result) => {
    if (result.stdout) process.stdout.write(result.stdout);
  };

  // Free pool first, then the paid Go models in price order -- unless the
  // caller named a model, which is a decision and is never substituted.
  const explicitModel =
    passthrough.includes('--model') ||
    passthrough.some((arg) => arg.startsWith('model=')) ||
    passthrough.some((arg, i) => arg === '--config' && String(passthrough[i + 1]).startsWith('model='));
  const registryPath = process.env.AGENT_HUB_REGISTRY ?? DEFAULT_REGISTRY;
  const chain = explicitModel
    ? [null]
    : modelChain(readAgentEntry(registryPath, decision.agent));

  const tryAgent = (agent, models) => {
    const attempts = models.length ? models : [null];
    let last = { status: 1, stdout: '', stderr: '' };
    for (const [index, model] of attempts.entries()) {
      last = run(agent, model);
      if (last.status === 0) return last;
      if (!failover || !isQuotaError(failureText(last))) return last;
      const next = attempts[index + 1];
      if (!next) return last;
      process.stderr.write(`[router] ${model} is out of quota; retrying on ${next}\n`);
    }
    return last;
  };

  let outcome = tryAgent(decision.agent, chain);
  if (outcome.status !== 0 && failover && isQuotaError(failureText(outcome))) {
    let from = decision.agent;
    for (const fallback of agentChain(readAgentEntry(registryPath, decision.agent), decision.agent)) {
      process.stderr.write(`[router] ${from} is out of quota; retrying on ${fallback}
`);
      // That agent has its own model chain; a model id from the first one
      // would be meaningless here.
      const fallbackChain = explicitModel ? [null] : modelChain(readAgentEntry(registryPath, fallback));
      outcome = tryAgent(fallback, fallbackChain);
      if (outcome.status === 0 || !isQuotaError(failureText(outcome))) break;
      from = fallback;
    }
  }
  emit(outcome);
  process.exit(outcome.status);
}

// Importable for tests without executing the CLI.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
