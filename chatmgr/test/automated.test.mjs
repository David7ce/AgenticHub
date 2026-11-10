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

test("automated rows are shown by default and can be hidden", () => {
  const rows = [{ provider: "codex", id: "a", automated: true }, { provider: "codex", id: "b", automated: false }];
  assert.equal(applyFilters(rows, emptyFilter()).length, 2);
  assert.deepEqual(applyFilters(rows, { ...emptyFilter(), includeAutomated: false }).map((r) => r.id), ["b"]);
});

import { automatedPath } from "../src/core/automated.mjs";
test("scratch checkouts under the temp folder are automated, real projects are not", () => {
  assert.ok(automatedPath("C:/Users/d7/AppData/Local/Temp/hub-bench-core-render-module-1RTAJr"));
  assert.ok(automatedPath("C:\\Users\\d7\\AppData\\Local\\Temp\\hub-failover-6Pql0W\\repo"));
  assert.ok(automatedPath("/tmp/hub-mcp-abc"));
  assert.ok(!automatedPath("D:/Workspaces/AgentHub"));
  assert.ok(!automatedPath(""));
});
