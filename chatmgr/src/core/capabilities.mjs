/**
 * What each agent can actually do, verified against the installed CLIs on
 * 2026-11-09. Capabilities are explicit so the UI can disable an action and
 * point at the original interface instead of guessing or editing storage.
 *
 * - opencode 2.2.6: `opencode session delete <id>` deletes the session and its
 *   children. No archive command. Running state from session_v2 busy/idle.
 * - codex 0.167.0: `codex delete --force <id>`, `codex archive <id>`. A live
 *   writer holds thread-writer-locks/<id>.lock.
 * - claude 2.1.319: `claude --resume <id>`. No per-session delete; `claude
 *   purge` is project-wide and `claude rm` is background-agents only, so the
 *   manager must not delete transcripts.
 * - hermes 0.23.0: `hermes sessions delete --yes <id>`. Archive is bulk-filter
 *   only, so single-session archive is unsupported on purpose.
 */
export const PROVIDERS = {
  opencode: {
    id: "opencode",
    label: "OpenCode",
    list: true,
    preview: true,
    resume: true,
    archive: false,
    delete: true,
    runtimeStatus: "reliable",
    deleteScope: "local",
    resumeHint: "Open the session in OpenCode",
    sideEffects:
      "deletes the session, its child sessions and their messages; git worktrees and project files are not touched",
  },
  codex: {
    id: "codex",
    label: "Codex",
    list: true,
    preview: true,
    resume: true,
    archive: true,
    delete: true,
    runtimeStatus: "reliable",
    deleteScope: "local",
    resumeHint: "codex resume <id>",
    sideEffects: "removes the rollout file, its thread record and its index entry; no worktree is involved",
  },
  claude: {
    id: "claude",
    label: "Claude Code",
    list: true,
    preview: true,
    resume: true,
    archive: false,
    delete: false,
    runtimeStatus: "unknown",
    deleteScope: "local",
    resumeHint: "claude --resume <id>",
    unsupportedReason:
      "Claude Code has no per-session delete command; use the /resume picker or `claude purge` for a whole project.",
  },
  hermes: {
    id: "hermes",
    label: "Hermes",
    list: true,
    preview: true,
    resume: true,
    archive: false,
    delete: true,
    runtimeStatus: "reliable",
    deleteScope: "local",
    resumeHint: "hermes chat --resume <id>",
    sideEffects:
      "removes the session, its messages and its transcripts; `hermes worktree` is a separate audit and is never run here",
  },
};

export const providerList = () => Object.values(PROVIDERS);

export function capabilitiesOf(providerId) {
  return PROVIDERS[providerId] ?? null;
}
