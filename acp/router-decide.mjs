// router-decide.mjs — the routing rules: prompt signals, audit-log health, model pick.
import { readFileSync } from 'node:fs';
import {
  CHEAP_AGENT,
  DEFAULT_COST_CEILING,
  DEFAULT_REGISTRY,
  MODELS_PATH,
  RECENT_FAILURE_WINDOW_MS,
  STRONG_AGENT,
} from './router-config.mjs';
import { modelChain, readAgentEntry } from './router-failover.mjs';

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
