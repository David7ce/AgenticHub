import { keyOf } from "./model.mjs";

/**
 * Selection is a set of "provider:id" keys. Keeping keys (not row objects)
 * means a selection survives a refresh: rows come back with new timestamps,
 * the key does not change.
 */
export function createSelection(initial = []) {
  return new Set(initial);
}

export function toggle(selection, conv) {
  const key = keyOf(conv);
  if (selection.has(key)) selection.delete(key);
  else selection.add(key);
  return selection;
}

export function selectAll(selection, rows) {
  for (const conv of rows) selection.add(keyOf(conv));
  return selection;
}

export function clearSelection(selection) {
  selection.clear();
  return selection;
}

/** Drops keys that no longer exist (deleted or filtered away) after a refresh. */
export function pruneSelection(selection, list) {
  const live = new Set(list.map(keyOf));
  for (const key of [...selection]) {
    if (!live.has(key)) selection.delete(key);
  }
  return selection;
}

export function selectedConversations(selection, list) {
  const byKey = new Map(list.map((conv) => [keyOf(conv), conv]));
  return [...selection].map((key) => byKey.get(key)).filter(Boolean);
}
