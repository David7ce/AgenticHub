// router-failover.mjs — who takes over when an agent or a model runs out of quota.
import { readFileSync } from 'node:fs';
import { isQuotaError } from './quota.mjs';
import { CHEAP_AGENT, STRONG_AGENT } from './router-config.mjs';

// A pool that is out of quota is not a failed task: it is the other pool's
// turn. Matched against the error text hub-acp reports, because neither
// provider exposes a distinct exit code for "exhausted".
export { isQuotaError };

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
