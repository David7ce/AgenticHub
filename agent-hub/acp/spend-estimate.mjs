// spend-estimate.mjs — what an agent spent today, including agents whose runs
// report no cost (Codex).
//
// logs/runs.jsonl only carries a dollar figure when the provider reports one.
// Codex does not, so its daily cap could never trigger. For Codex we price the
// tokens of the sessions the hub started (originator "agent-hub-acp") with the
// per-model estimates in models.json. A model without a price counts as zero
// (never invented); `hubctl doctor` already warns about that.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readCodexSpend, priceOf } from './codex-spend.mjs';
import { spentToday } from './consent.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const HUB_ORIGINATOR = 'agent-hub-acp';

function codexPrices(modelsPath) {
  const prices = {};
  try {
    for (const m of JSON.parse(readFileSync(modelsPath, 'utf8')).models ?? []) {
      if (m.agent === 'codex' && priceOf(m)) prices[m.id] = priceOf(m);
    }
  } catch { /* no catalogue: nothing priced */ }
  return prices;
}

function codexRowsToday({ now = new Date(), root, modelsPath = join(HERE, '..', 'models.json') } = {}) {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  return readCodexSpend({
    ...(root ? { root } : {}),
    range: { from: start, to: start + 86_400_000 },
    dayKey: () => 'today',
    projectLabel: () => ({ label: '*', path: null }),
    prices: codexPrices(modelsPath),
    originator: HUB_ORIGINATOR,
  }).rows;
}

/** Estimated USD spent today by hub-started Codex sessions. */
export function estimatedCodexToday(opts = {}) {
  return codexRowsToday(opts).reduce((sum, row) => sum + (row.costEstimatedUsd ?? 0), 0);
}

/**
 * Tokens used today by hub-started Codex sessions: fresh input plus output
 * (reasoning is already inside output, cached reads are not counted). This is
 * what a flat subscription actually rations, so `limits.maxDailyTokens` caps it.
 */
export function codexTokensToday(opts = {}) {
  return codexRowsToday(opts).reduce((sum, row) => sum + (row.input ?? 0) + (row.output ?? 0), 0);
}

/** Tokens today for agents that report them through rollouts (Codex); 0 for the rest. */
export function spentTokensToday(agentName, opts = {}) {
  return agentName === 'codex' ? codexTokensToday(opts) : 0;
}

/** Reported cost from the audit log plus the Codex estimate. */
export function spentTodayAll(agentName, logPath, opts = {}) {
  const reported = spentToday(agentName, logPath, opts.now);
  return agentName === 'codex' ? reported + estimatedCodexToday(opts) : reported;
}
