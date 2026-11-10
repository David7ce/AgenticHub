// Sessions a person never typed into: tool-payload summarizers, auto-review
// guardians, runs started by the hub itself. They are real files and can be
// deleted, but listing them by default buries the conversations that matter.

const AUTO_TITLE = [/^Condense the tool payload/i, /^Guardian review/i];

export const automatedTitle = (title) => AUTO_TITLE.some((re) => re.test(String(title ?? "")));

/**
 * Scratch checkouts the hub and its tests create under the OS temp folder
 * (hub-bench-*, hub-failover-*, hub-mcp-*): sessions run there are never ones a
 * person opened.
 */
export const automatedPath = (path) => /[\\/]hub-(bench|failover|mcp|worktree|test)[-\w]*([\\/]|$)/i.test(String(path ?? ""));

/** Codex rollout meta: started by the hub (originator) or by a sub-agent. */
export function automatedCodexMeta(meta) {
  if (!meta) return false;
  if (meta.originator === "agent-hub-acp") return true;
  return typeof meta.source === "object" && meta.source !== null && "subagent" in meta.source;
}
