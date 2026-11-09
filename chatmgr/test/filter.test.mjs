import assert from "node:assert/strict";
import test from "node:test";

import { applyFilters, emptyFilter, normalizeFilter } from "../src/core/filter.mjs";
import { formatLocalDate, parseLocalDate } from "../src/core/time.mjs";

const at = (iso) => new Date(iso).getTime();
const rows = [
  { provider: "codex", id: "a", title: "Parser fix", projectPath: "D:\\repo", lastActivity: at("2026-11-08T23:59:59"), archived: false, running: false },
  { provider: "codex", id: "b", title: "Old parser", projectPath: "D:\\repo", lastActivity: at("2026-11-08T00:00:00"), archived: true, running: false },
  { provider: "claude", id: "c", title: "Loader refactor", projectPath: "D:\\Other", lastActivity: at("2026-11-07T12:00:00"), archived: false, running: false },
  { provider: "hermes", id: "d", title: "Telegram", projectPath: "D:\\repo\\", lastActivity: at("2026-11-09T08:00:00"), archived: false, running: false },
];

test("before date means before local midnight, not before UTC midnight", () => {
  const cutoff = parseLocalDate("2026-11-08");
  assert.equal(formatLocalDate(cutoff), "2026-11-08");
  assert.equal(new Date(cutoff).getHours(), 0);

  const before = applyFilters(rows, { ...emptyFilter(), before: "2026-11-08" });
  // 2026-11-08 00:00:00 is exactly midnight, so it is NOT before it.
  assert.deepEqual(before.map((r) => r.id).sort(), ["c"]);

  const onTheNinth = applyFilters(rows, { ...emptyFilter(), before: "2026-11-09" });
  assert.deepEqual(onTheNinth.map((r) => r.id).sort(), ["a", "c"]);
});

test("rejects impossible dates instead of guessing", () => {
  assert.throws(() => parseLocalDate("2026-02-30"), /not a real date/);
  assert.throws(() => parseLocalDate("08/11/2026"), /YYYY-MM-DD/);
});

test("filters combine with AND: agent, exact project path, activity window", () => {
  const filtered = applyFilters(rows, {
    agents: ["codex"],
    project: "d:/REPO/",
    before: "2026-11-09",
  });
  assert.deepEqual(filtered.map((r) => r.id), ["a"]);
});

test("exact project path does not match a sibling or a parent", () => {
  assert.deepEqual(applyFilters(rows, { project: "D:\\rep" }).map((r) => r.id), []);
  assert.deepEqual(applyFilters(rows, { project: "D:\\Other" }).map((r) => r.id), ["c"]);
  // trailing separator and case are folded
  assert.deepEqual(applyFilters(rows, { project: "d:\\repo\\" }).map((r) => r.id).sort(), ["a", "d"]);
});

test("archived rows are hidden unless asked for", () => {
  assert.deepEqual(applyFilters(rows, {}).map((r) => r.id).sort(), ["a", "c", "d"]);
  assert.deepEqual(applyFilters(rows, { includeArchived: true }).map((r) => r.id).sort(), ["a", "b", "c", "d"]);
  const archivedOnly = applyFilters(rows, { includeArchived: true, before: "2026-11-08" });
  assert.deepEqual(archivedOnly.map((r) => r.id).sort(), ["c"]);
});

test("free text searches title and path, case-insensitively", () => {
  assert.deepEqual(applyFilters(rows, { query: "parser" }).map((r) => r.id).sort(), ["a"]);
  assert.deepEqual(applyFilters(rows, { query: "d:\\repo" }).map((r) => r.id).sort(), ["a", "d"]);
});

test("normalizeFilter turns an empty agent list into no filter", () => {
  assert.equal(normalizeFilter({ agents: [] }).agents, null);
  assert.deepEqual(normalizeFilter({ agents: ["codex", "codex"] }).agents, ["codex"]);
});
