import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPruneAutomatedPlan, parseOlderThan } from "../src/core/plan.mjs";

const DAY = 86_400_000;
const NOW = Date.parse("2026-11-10T12:00:00Z");
const conv = (id, extra = {}) => ({
  provider: "opencode",
  id,
  title: id,
  projectPath: "C:/x",
  lastActivity: NOW - 10 * DAY,
  archived: false,
  running: false,
  automated: true,
  ...extra,
});

test("parseOlderThan accepts 7d or 7 and rejects anything else", () => {
  assert.equal(parseOlderThan("7d"), 7);
  assert.equal(parseOlderThan("14"), 14);
  assert.equal(parseOlderThan(undefined), null);
  assert.throws(() => parseOlderThan("soon"));
  assert.throws(() => parseOlderThan("-3d"));
});

test("only automated sessions are picked; people's sessions are never touched", () => {
  const plan = buildPruneAutomatedPlan([conv("a"), conv("human", { automated: false })], { now: NOW });
  assert.deepEqual(plan.items.map((c) => c.id), ["a"]);
});

test("--older-than and --agent narrow the pick", () => {
  const list = [
    conv("old"),
    conv("fresh", { lastActivity: NOW - 1 * DAY }),
    conv("codex-old", { provider: "codex" }),
  ];
  const week = buildPruneAutomatedPlan(list, { now: NOW, olderThanDays: 7 });
  assert.deepEqual(week.items.map((c) => c.id).sort(), ["codex-old", "old"].sort().filter((id) => week.items.some((c) => c.id === id)));
  assert.ok(!week.items.some((c) => c.id === "fresh"));
  const onlyOpencode = buildPruneAutomatedPlan(list, { now: NOW, agents: ["opencode"] });
  assert.ok(!onlyOpencode.items.some((c) => c.provider === "codex"));
});

test("running and current sessions are blocked, not deleted", () => {
  const plan = buildPruneAutomatedPlan([conv("busy", { running: true }), conv("me")], { now: NOW, currentKey: "opencode:me" });
  assert.equal(plan.items.length, 0);
  assert.deepEqual(plan.blocked.map((b) => b.code).sort(), ["current-session", "running"]);
});
