import assert from "node:assert/strict";
import test from "node:test";

import {
  clearSelection,
  createSelection,
  pruneSelection,
  selectAll,
  selectedConversations,
  toggle,
} from "../src/core/selection.mjs";
import { sortConversations } from "../src/core/model.mjs";

const conv = (provider, id, lastActivity = 0) => ({
  provider,
  id,
  title: id,
  projectPath: "D:\\repo",
  lastActivity,
  archived: false,
  running: false,
});

test("toggle adds then removes one row without touching others", () => {
  const selection = createSelection();
  toggle(selection, conv("codex", "a"));
  toggle(selection, conv("claude", "b"));
  assert.deepEqual([...selection].sort(), ["claude:b", "codex:a"]);
  toggle(selection, conv("codex", "a"));
  assert.deepEqual([...selection], ["claude:b"]);
});

test("select all applies to the filtered rows, not the whole table", () => {
  const selection = createSelection();
  selectAll(selection, [conv("codex", "a"), conv("codex", "b")]);
  assert.equal(selection.size, 2);
  // selecting again is idempotent
  selectAll(selection, [conv("codex", "a")]);
  assert.equal(selection.size, 2);
  clearSelection(selection);
  assert.equal(selection.size, 0);
});

test("a refresh prunes deleted rows but keeps surviving selections", () => {
  const selection = createSelection(["codex:a", "codex:b", "claude:c"]);
  pruneSelection(selection, [conv("codex", "a"), conv("claude", "c")]);
  assert.deepEqual([...selection].sort(), ["claude:c", "codex:a"]);
});

test("selectedConversations resolves keys against the current list", () => {
  const selection = createSelection(["codex:a", "gone:z"]);
  const rows = selectedConversations(selection, [conv("codex", "a")]);
  assert.deepEqual(rows.map((r) => r.id), ["a"]);
});

test("sorting is newest first and stable across providers", () => {
  const sorted = sortConversations([conv("codex", "old", 1), conv("claude", "new", 9), conv("hermes", "mid", 5)]);
  assert.deepEqual(sorted.map((r) => r.id), ["new", "mid", "old"]);
});
