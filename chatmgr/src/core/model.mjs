/**
 * The one shape every provider adapter returns. Anything the UI needs to
 * render a row or decide a deletion lives here; provider-specific fields stay
 * in the adapter.
 *
 * @typedef {Object} Conversation
 * @property {string} provider   "opencode" | "codex" | "claude" | "hermes"
 * @property {string} id         provider-native session id
 * @property {string} title
 * @property {string} projectPath  absolute directory, original spelling
 * @property {number} lastActivity epoch ms
 * @property {boolean} archived
 * @property {boolean} running    true when the agent says it is live
 * @property {boolean} [runningUnknown] provider could not tell
 * @property {string} [sourcePath] file the record came from, when file-backed
 * @property {number} [sizeBytes]
 */

export const keyOf = (conv) => `${conv.provider}:${conv.id}`;

/** Windows-safe comparison key: separators folded, case folded, no trailing slash. */
export function normPath(path) {
  if (!path) return "";
  let out = String(path).replace(/\//g, "\\").replace(/\\+$/, "");
  // A drive-letter path is a Windows path wherever this runs (WSL, CI on Linux),
  // and Windows paths are case-insensitive.
  return process.platform === "win32" || /^[a-z]:/i.test(out) ? out.toLowerCase() : out;
}

export function samePath(a, b) {
  return normPath(a) === normPath(b);
}

/** Sorts newest activity first; running rows bubble above idle ones on a tie. */
export function sortConversations(list) {
  return [...list].sort((a, b) => {
    if (b.lastActivity !== a.lastActivity) return b.lastActivity - a.lastActivity;
    if (a.running !== b.running) return a.running ? 1 : -1;
    return keyOf(a).localeCompare(keyOf(b));
  });
}
