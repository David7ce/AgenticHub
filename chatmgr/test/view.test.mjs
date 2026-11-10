import { test } from "node:test";
import assert from "node:assert/strict";
import { counterText, deleteTargets, pageSizeFor } from "../src/core/view.mjs";

const keyOf = (r) => r.id;

test("page size follows the terminal and never drops below the minimum", () => {
  assert.equal(pageSizeFor(40), 30);
  assert.equal(pageSizeFor(12), 5);
  assert.equal(pageSizeFor(undefined), 20);
  assert.equal(pageSizeFor(0), 20);
});

test("Ctrl+D acts on the marked rows, else on the cursor row, else on nothing", () => {
  const rows = [{ id: "a" }, { id: "b" }, { id: "c" }];
  assert.deepEqual(deleteTargets(rows, new Set(["a", "c"]), rows[1], keyOf).map(keyOf), ["a", "c"]);
  assert.deepEqual(deleteTargets(rows, new Set(), rows[1], keyOf).map(keyOf), ["b"]);
  assert.deepEqual(deleteTargets([], new Set(), undefined, keyOf), []);
});

test("the counter shows what is visible and says what is hidden", () => {
  assert.equal(counterText({ visible: 2, total: 3, selected: 0 }), "2 of 3 conversations (1 hidden by filters) · 0 selected");
  assert.equal(counterText({ visible: 3, total: 3, selected: 1, status: "deleting 1…" }), "3 of 3 conversations · 1 selected · deleting 1…");
});

import { fitLine } from "../src/core/view.mjs";

test("a long row is cut to one terminal line and never contains a line break", () => {
  const long = "OpenCode  2026-11-10 02:00  Restore\nfanout " + "x".repeat(300);
  const line = fitLine(long, 120);
  assert.ok(line.length <= 116);
  assert.ok(line.endsWith("…"));
  assert.ok(!line.includes("\n"));
  assert.equal(fitLine("short", 120), "short");
  assert.ok(fitLine("a".repeat(500), undefined).length <= 96);
});
