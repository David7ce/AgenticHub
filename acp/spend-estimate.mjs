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

/** Estimated USD spent today by hub-started Codex sessions. */
export function estimatedCodexToday({ now = new Date(), root, modelsPath = join(HERE, '..', 'models.json') } = {}) {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const result = readCodexSpend({
    ...(root ? { root } : {}),
    range: { from: start, to: start + 86_400_000 },
    dayKey: () => 'today',
    projectLabel: () => ({ label: '*', path: null }),
    prices: codexPrices(modelsPath),
    originator: HUB_ORIGINATOR,
  });
  return result.rows.reduce((sum, row) => sum + (row.costEstimatedUsd ?? 0), 0);
}

/** Reported cost from the audit log plus the Codex estimate. */
export function spentTodayAll(agentName, logPath, opts = {}) {
  const reported = spentToday(agentName, logPath, opts.now);
  return agentName === 'codex' ? reported + estimatedCodexToday(opts) : reported;
}
