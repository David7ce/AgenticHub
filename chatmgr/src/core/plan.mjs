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
  if (conv.runningUnknown || caps.runtimeStatus !== "reliable") {
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

export function describePlan(plan) {
  const parts = Object.entries(plan.byProvider).map(([id, n]) => `${n} ${PROVIDERS[id]?.label ?? id}`);
  const children = plan.descendants ? ` · ${plan.descendants} child session${plan.descendants === 1 ? "" : "s"}` : "";
  const blocked = plan.blocked.length
    ? ` · ${plan.blocked.length} blocked (${[...new Set(plan.blocked.map((row) => row.code))].join(", ")})`
    : "";
  return `${parts.length ? parts.join(" · ") : "nothing to delete"}${children}${blocked}`;
}
