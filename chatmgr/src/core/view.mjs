// view.mjs — the panel's decisions that are not drawing, so they can be tested.
// tui.tsx only needs OpenCode's runtime to render; these do not.

/** Rows that fit: terminal height minus the fixed chrome, never below `min`. */
export function pageSizeFor(termRows, { chrome = 10, min = 5, fallback = 30 } = {}) {
  const rows = Number(termRows);
  return Math.max(min, (Number.isFinite(rows) && rows > 0 ? rows : fallback) - chrome);
}

/** What Ctrl+D acts on: the marked rows, or the row under the cursor if none. */
export function deleteTargets(rows, selectedKeys, cursorRow, keyOf) {
  const marked = rows.filter((row) => selectedKeys.has(keyOf(row)));
  if (marked.length) return marked;
  return cursorRow ? [cursorRow] : [];
}

/** The header counter reflects what is on screen, not what the CLI loaded. */
export function counterText({ visible, total, selected, status = "" }) {
  const hidden = total > visible ? ` (${total - visible} hidden by filters)` : "";
  return `${visible} of ${total} conversations${hidden} · ${selected} selected${status ? ` · ${status}` : ""}`;
}
