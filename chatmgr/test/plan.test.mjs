import assert from "node:assert/strict";
import test from "node:test";

import { BLOCK, buildDeletePlan, describePlan } from "../src/core/plan.mjs";

const conv = (provider, id, extra = {}) => ({
  provider,
  id,
  title: id,
  projectPath: "D:\\repo",
  lastActivity: 0,
  archived: false,
  running: false,
  ...extra,
});

test("deletable rows form the plan; unsupported and running are blocked", () => {
  const plan = buildDeletePlan([
    conv("codex", "a"),
    conv("opencode", "b"),
    conv("claude", "c"),
    conv("codex", "d", { running: true }),
  ]);
  assert.deepEqual(plan.items.map((r) => r.id), ["a", "b"]);
  assert.deepEqual(
    plan.blocked.map((r) => [r.conv.id, r.code]),
    [["c", BLOCK.UNSUPPORTED], ["d", BLOCK.RUNNING]],
  );
  assert.deepEqual(plan.byProvider, { codex: 1, opencode: 1 });
});

test("unknown runtime status blocks deletion even when the CLI supports it", () => {
  const plan = buildDeletePlan([conv("codex", "x", { runningUnknown: true })]);
  assert.equal(plan.items.length, 0);
  assert.equal(plan.blocked[0].code, BLOCK.RUNNING_UNKNOWN);
});

test("the session you are in can never be selected for deletion", () => {
  const plan = buildDeletePlan([conv("opencode", "here")], { currentKey: "opencode:here" });
  assert.equal(plan.items.length, 0);
  assert.equal(plan.blocked[0].code, BLOCK.CURRENT);
});

test("describePlan names counts per agent and the blocked codes", () => {
  const plan = buildDeletePlan([
    conv("codex", "a"),
    conv("codex", "b"),
    conv("claude", "c"),
  ]);
  const text = describePlan(plan);
  assert.match(text, /2 Codex/);
  assert.match(text, /1 blocked/);
  assert.match(text, /unsupported/);
});
