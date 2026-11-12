import assert from "node:assert/strict";
import test from "node:test";

import { BLOCK, buildArchivePlan, buildDeletePlan, describeArchivePlan, describePlan } from "../src/core/plan.mjs";

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
  assert.deepEqual(plan.items.map((r) => r.id), ["a", "b", "c"]);
  assert.deepEqual(plan.blocked.map((r) => [r.conv.id, r.code]), [["d", BLOCK.RUNNING]]);
  assert.deepEqual(plan.byProvider, { codex: 1, opencode: 1, claude: 1 });
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
    conv("claude", "c", { running: true }),
  ]);
  const text = describePlan(plan);
  assert.match(text, /2 Codex/);
  assert.match(text, /1 blocked/);
  assert.match(text, /running/);
});

test("archive plan only takes agents with a single-session archive command", () => {
  const plan = buildArchivePlan([
    conv("codex", "new"),
    conv("codex", "old", { archived: true }),
    conv("opencode", "idle"),
    conv("hermes", "h"),
    conv("codex", "busy", { running: true }),
  ]);
  assert.deepEqual(plan.items.map((r) => r.id), ["new", "old"]);
  assert.equal(plan.toArchive, 1);
  assert.equal(plan.toUnarchive, 1);
  assert.deepEqual(plan.blocked.map((r) => r.conv.id), ["idle", "h", "busy"]);
  assert.match(describeArchivePlan(plan), /1 archive · 1 unarchive · 3 blocked/);
});

import { currentKeyFrom } from "../src/core/plan.mjs";
test("currentKeyFrom: the flag wins, then Claude Code's own session id, else nothing", () => {
  assert.equal(currentKeyFrom({ "current-key": "codex:x" }, { CLAUDE_CODE_SESSION_ID: "abc" }), "codex:x");
  assert.equal(currentKeyFrom({}, { CLAUDE_CODE_SESSION_ID: "abc" }), "claude:abc");
  assert.equal(currentKeyFrom({ "current-key": true }, { CLAUDE_CODE_SESSION_ID: "abc" }), "claude:abc");
  assert.equal(currentKeyFrom({}, {}), null);
  // and a bulk delete that names the current session leaves it out
  const plan = buildDeletePlan([conv("claude", "abc"), conv("claude", "old")], { currentKey: currentKeyFrom({}, { CLAUDE_CODE_SESSION_ID: "abc" }) });
  assert.deepEqual(plan.items.map((c) => c.id), ["old"]);
  assert.equal(plan.blocked[0].code, "current-session");
});
