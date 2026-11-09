import { PROVIDERS } from "./capabilities.mjs";
import { keyOf } from "./model.mjs";

export const BLOCK = {
  RUNNING: "running",
  RUNNING_UNKNOWN: "running-unknown",
  UNSUPPORTED: "unsupported",
  CURRENT: "current-session",
};

export function blockReason(conv, { currentKey = null } = {}) {
  const caps = PROVIDERS[conv.provider];
  if (!caps) return { code: BLOCK.UNSUPPORTED, message: `unknown provider ${conv.provider}` };
  if (keyOf(conv) === currentKey) {
    return { code: BLOCK.CURRENT, message: "this is the conversation you are in" };
  }
  if (!caps.delete) {
    return { code: BLOCK.UNSUPPORTED, message: caps.unsupportedReason ?? "delete is not supported" };
  }
  if (conv.running) {
    return { code: BLOCK.RUNNING, message: "session is running right now" };
  }
  // "heuristic" is allowed only when the provider actually reported a boolean
  // (Claude uses a ten-minute mtime window). Anything missing fails closed.
  if (conv.runningUnknown || typeof conv.running !== "boolean") {
    return {
      code: BLOCK.RUNNING_UNKNOWN,
      message: "runtime status cannot be determined reliably; deletion is blocked",
    };
  }
  if (caps.runtimeStatus === "unknown" || caps.runtimeStatus === "none") {
    return {
      code: BLOCK.RUNNING_UNKNOWN,
      message: "runtime status cannot be determined reliably; deletion is blocked",
    };
  }
  return null;
}

/**
 * Splits a selection into what may be deleted and why the rest may not.
 * Nothing here touches the disk: the plan is what the confirmation dialog
 * shows, and executeDeletes refuses to act on a blocked row.
 */
export function buildDeletePlan(conversations, options = {}) {
  const items = [];
  const blocked = [];
  for (const conv of conversations) {
    const reason = blockReason(conv, options);
    if (reason) blocked.push({ conv, ...reason });
    else items.push(conv);
  }
  return {
    items,
    blocked,
    byProvider: countBy(items),
    blockedByProvider: countBy(blocked.map((row) => row.conv)),
    destructive: items.length > 0,
    descendants: items.reduce((sum, conv) => sum + (conv.childCount ?? 0), 0),
    sideEffects: [...new Set(items.map((conv) => PROVIDERS[conv.provider]?.sideEffects).filter(Boolean))],
    scope: "local",
  };
}

function countBy(list) {
  const out = {};
  for (const conv of list) out[conv.provider] = (out[conv.provider] ?? 0) + 1;
  return out;
}

/**
 * Archiving is a capability, not a promise: only Codex can archive a single
 * session through its CLI. A running session is not archived either, and an
 * already-archived row is unarchived by the same action.
 */
export function buildArchivePlan(conversations, options = {}) {
  const items = [];
  const blocked = [];
  for (const conv of conversations) {
    const caps = PROVIDERS[conv.provider];
    let reason = null;
    if (!caps) reason = { code: BLOCK.UNSUPPORTED, message: `unknown provider ${conv.provider}` };
    else if (!caps.archive) {
      reason = {
        code: BLOCK.UNSUPPORTED,
        message: `${caps.label} has no single-session archive command`,
      };
    } else if (conv.running) reason = { code: BLOCK.RUNNING, message: "session is running right now" };
    else if (conv.runningUnknown || caps.runtimeStatus !== "reliable") {
      reason = { code: BLOCK.RUNNING_UNKNOWN, message: "runtime status cannot be determined reliably" };
    }
    if (reason) blocked.push({ conv, ...reason });
    else items.push(conv);
  }
  return {
    items,
    blocked,
    byProvider: countBy(items),
    blockedByProvider: countBy(blocked.map((row) => row.conv)),
    toArchive: items.filter((conv) => !conv.archived).length,
    toUnarchive: items.filter((conv) => conv.archived).length,
  };
}

export function describeArchivePlan(plan) {
  const parts = [];
  if (plan.toArchive) parts.push(`${plan.toArchive} archive`);
  if (plan.toUnarchive) parts.push(`${plan.toUnarchive} unarchive`);
  const blocked = plan.blocked.length ? ` · ${plan.blocked.length} blocked` : "";
  return `${parts.length ? parts.join(" · ") : "nothing to archive"}${blocked}`;
}

export function describePlan(plan) {
  const parts = Object.entries(plan.byProvider).map(([id, n]) => `${n} ${PROVIDERS[id]?.label ?? id}`);
  const children = plan.descendants ? ` · ${plan.descendants} child session${plan.descendants === 1 ? "" : "s"}` : "";
  const blocked = plan.blocked.length
    ? ` · ${plan.blocked.length} blocked (${[...new Set(plan.blocked.map((row) => row.code))].join(", ")})`
    : "";
  return `${parts.length ? parts.join(" · ") : "nothing to delete"}${children}${blocked}`;
}
