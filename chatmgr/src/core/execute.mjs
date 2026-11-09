import { PROVIDERS } from "./capabilities.mjs";
import { keyOf } from "./model.mjs";

/**
 * Runs a batch of provider actions one at a time and reports each outcome.
 * Order is sequential on purpose: two deletions in the same agent's store must
 * not race. A failure never stops the batch; an abort stops before the next
 * item and marks the rest cancelled.
 */
export async function runBatch(conversations, { providers, action, signal, onProgress } = {}) {
  const results = [];
  for (let index = 0; index < conversations.length; index += 1) {
    const conv = conversations[index];
    if (signal?.aborted) {
      results.push({ key: keyOf(conv), provider: conv.provider, id: conv.id, status: "cancelled" });
      continue;
    }
    const adapter = providers[conv.provider];
    let outcome;
    try {
      if (!adapter?.[action]) throw new Error(`provider ${conv.provider} has no ${action} action`);
      await adapter[action](conv, { run: providers.run });
      outcome = { key: keyOf(conv), provider: conv.provider, id: conv.id, status: "ok" };
    } catch (error) {
      outcome = {
        key: keyOf(conv),
        provider: conv.provider,
        id: conv.id,
        status: "failed",
        error: String(error?.message ?? error),
      };
    }
    results.push(outcome);
    onProgress?.({ index: index + 1, total: conversations.length, ...outcome });
  }
  return {
    results,
    ok: results.filter((row) => row.status === "ok").length,
    failed: results.filter((row) => row.status === "failed").length,
    cancelled: results.filter((row) => row.status === "cancelled").length,
  };
}

export async function executeDeletes(plan, { providers, backup = null, signal, onProgress } = {}) {
  const skipped = plan.blocked.map((row) => ({
    key: keyOf(row.conv),
    provider: row.conv.provider,
    id: row.conv.id,
    status: "blocked",
    code: row.code,
    error: row.message,
  }));

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
