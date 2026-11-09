import { test } from "node:test";
import assert from "node:assert/strict";
import { automatedTitle, automatedCodexMeta } from "../src/core/automated.mjs";
import { applyFilters, emptyFilter } from "../src/core/filter.mjs";

test("automated sessions are recognised", () => {
  assert.ok(automatedTitle("Condense the tool payload below to under 100 words"));
  assert.ok(automatedTitle("Guardian review"));
  assert.ok(!automatedTitle("que te parece esta app"));
  assert.ok(automatedCodexMeta({ originator: "agent-hub-acp" }));
  assert.ok(automatedCodexMeta({ source: { subagent: { other: "guardian" } } }));
  assert.ok(!automatedCodexMeta({ originator: "codex-tui", source: "vscode" }));
  assert.ok(!automatedCodexMeta(null));
});

test("automated rows are hidden unless asked for", () => {
  const rows = [{ provider: "codex", id: "a", automated: true }, { provider: "codex", id: "b", automated: false }];
  assert.deepEqual(applyFilters(rows, emptyFilter()).map((r) => r.id), ["b"]);
  assert.equal(applyFilters(rows, { ...emptyFilter(), includeAutomated: true }).length, 2);
});
