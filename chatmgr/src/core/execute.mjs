import { PROVIDERS } from "./capabilities.mjs";
import { keyOf } from "./model.mjs";

/**
 * Runs a batch of provider actions one at a time and reports each outcome.
 * Order is sequential on purpose: two deletions in the same agent's store must
 * not race. A failure never stops the batch; an abort stops before the next
 * item and marks the rest cancelled.
 */
export async function runBatch(conversations, { providers, action, signal, onProgress } = {}) {
  const slots = new Array(conversations.length);
  let finished = 0;
  const runOne = async (conv, index) => {
    if (signal?.aborted) {
      slots[index] = { key: keyOf(conv), provider: conv.provider, id: conv.id, status: "cancelled" };
      return;
    }
    const adapter = providers[conv.provider];
    let outcome;
    try {
      const name = typeof action === "function" ? action(conv) : action;
      if (!adapter?.[name]) throw new Error(`provider ${conv.provider} has no ${name} action`);
      await adapter[name](conv, { run: providers.run });
      outcome = { key: keyOf(conv), provider: conv.provider, id: conv.id, status: "ok", action: name };
    } catch (error) {
      outcome = {
        key: keyOf(conv),
        provider: conv.provider,
        id: conv.id,
        status: "failed",
        error: String(error?.message ?? error),
      };
    }
    slots[index] = outcome;
    finished += 1;
    onProgress?.({ index: finished, total: conversations.length, ...outcome });
  };
  // Same agent: one at a time (two deletions in one store must not race).
  // Different agents touch different stores, so they run side by side.
  const lanes = new Map();
  conversations.forEach((conv, index) => {
    if (!lanes.has(conv.provider)) lanes.set(conv.provider, []);
    lanes.get(conv.provider).push([conv, index]);
  });
  await Promise.all([...lanes.values()].map(async (lane) => {
    for (const [conv, index] of lane) await runOne(conv, index);
  }));
  const results = slots;
  return {
    results,
    ok: results.filter((row) => row.status === "ok").length,
    failed: results.filter((row) => row.status === "failed").length,
    cancelled: results.filter((row) => row.status === "cancelled").length,
  };
}

const skippedFrom = (plan) =>
  plan.blocked.map((row) => ({
    key: keyOf(row.conv),
    provider: row.conv.provider,
    id: row.conv.id,
    status: "blocked",
    code: row.code,
    error: row.message,
  }));

export async function executeDeletes(plan, { providers, backup = null, signal, onProgress } = {}) {
  const skipped = skippedFrom(plan);

  if (plan.items.length === 0) {
    return { results: skipped, ok: 0, failed: 0, cancelled: 0, blocked: skipped.length, backup: null };
  }

  let backupInfo = null;
  if (backup) {
    try {
      backupInfo = await backup.create(plan.items);
    } catch (error) {
      return {
        results: [
          ...skipped,
          ...plan.items.map((conv) => ({
            key: keyOf(conv),
            provider: conv.provider,
            id: conv.id,
            status: "failed",
            error: `backup failed, nothing deleted: ${error?.message ?? error}`,
          })),
        ],
        ok: 0,
        failed: plan.items.length,
        cancelled: 0,
        blocked: skipped.length,
        backup: null,
        abortedByBackup: true,
      };
    }
  }

  const batch = await runBatch(plan.items, { providers, action: "remove", signal, onProgress });
  return { ...batch, results: [...skipped, ...batch.results], blocked: skipped.length, backup: backupInfo };
}

export const describeResult = (row) =>
  `${PROVIDERS[row.provider]?.label ?? row.provider} ${row.id} — ${row.status}${row.error ? `: ${row.error}` : ""}`;

/**
 * Archive/unarchive a selection. The action is chosen per row from its current
 * archived flag, so the same key toggles in both directions.
 */
export async function executeArchive(plan, { providers, signal, onProgress } = {}) {
  const skipped = skippedFrom(plan);
  if (plan.items.length === 0) {
    return { results: skipped, ok: 0, failed: 0, cancelled: 0, blocked: skipped.length };
  }
  const batch = await runBatch(plan.items, {
    providers,
    action: (conv) => (conv.archived ? "unarchive" : "archive"),
    signal,
    onProgress,
  });
  return { ...batch, results: [...skipped, ...batch.results], blocked: skipped.length };
}
