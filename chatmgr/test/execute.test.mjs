import assert from "node:assert/strict";
import test from "node:test";

import { executeArchive, executeDeletes, runBatch } from "../src/core/execute.mjs";
import { buildArchivePlan, buildDeletePlan } from "../src/core/plan.mjs";
import { fakeProviders, tempDir } from "./fixtures.mjs";
import { createBackup } from "../src/core/backup.mjs";

const conv = (provider, id, extra = {}) => ({
  provider,
  id,
  title: id,
  projectPath: "D:\\repo",
  lastActivity: 0,
  archived: false,
  running: false,
  sourcePath: null,
  ...extra,
});

test("partial failures are reported per item and do not stop the batch", async () => {
  const { providers, calls } = fakeProviders({ b: "throw" });
  const plan = buildDeletePlan([conv("codex", "a"), conv("codex", "b"), conv("opencode", "c")]);
  const result = await executeDeletes(plan, { providers });

  assert.deepEqual(calls, ["remove:a", "remove:b", "remove:c"]);
  assert.equal(result.ok, 2);
  assert.equal(result.failed, 1);
  const failed = result.results.find((row) => row.id === "b");
  assert.equal(failed.status, "failed");
  assert.match(failed.error, /boom/);
});

test("an abort before the first item deletes nothing", async () => {
  const { providers, calls } = fakeProviders();
  const plan = buildDeletePlan([conv("codex", "a"), conv("codex", "b")]);
  const controller = new AbortController();
  controller.abort();
  const result = await executeDeletes(plan, { providers, signal: controller.signal });
  assert.deepEqual(calls, []);
  assert.equal(result.cancelled, 2);
  assert.equal(result.ok, 0);
});

test("an abort mid-batch finishes the current item and cancels the rest", async () => {
  const controller = new AbortController();
  const { providers } = fakeProviders();
  providers.codex.remove = async (row) => {
    controller.abort(); // the user cancels while the first deletion runs
  };
  const plan = buildDeletePlan([conv("codex", "a"), conv("codex", "b")]);
  const result = await executeDeletes(plan, { providers, signal: controller.signal });
  assert.deepEqual(result.results.map((row) => row.status), ["ok", "cancelled"]);
});

test("blocked rows never reach a provider and appear in the results", async () => {
  const { providers, calls } = fakeProviders();
  const plan = buildDeletePlan([conv("codex", "a"), conv("claude", "c"), conv("codex", "d", { running: true })]);
  const result = await executeDeletes(plan, { providers });
  assert.deepEqual(calls, ["remove:a"]);
  assert.equal(result.blocked, 2);
  assert.deepEqual(result.results.filter((row) => row.status === "blocked").map((row) => row.id), ["c", "d"]);
});

test("a failed backup deletes nothing", async () => {
  const { providers, calls } = fakeProviders();
  providers.opencode.exportDump = async () => {
    throw new Error("disk full");
  };
  const plan = buildDeletePlan([conv("opencode", "a")]);
  const result = await executeDeletes(plan, {
    providers,
    backup: { create: (items) => createBackup(items, { root: tempDir("chatmgr-bk-"), providers }) },
  });
  assert.deepEqual(calls, []);
  assert.equal(result.failed, 1);
  assert.match(result.results[0].error, /backup failed/);
});

test("progress is reported after every item", async () => {
  const { providers } = fakeProviders();
  const seen = [];
  await runBatch([conv("codex", "a"), conv("codex", "b")], {
    providers,
    action: "remove",
    onProgress: (row) => seen.push(`${row.index}/${row.total}:${row.status}`),
  });
  assert.deepEqual(seen, ["1/2:ok", "2/2:ok"]);
});

test("archive picks archive or unarchive per row and keeps going after a failure", async () => {
  const { providers, calls } = fakeProviders({ old: "throw" });
  const plan = buildArchivePlan([
    conv("codex", "new"),
    conv("codex", "old", { archived: true }),
    conv("codex", "newer"),
    conv("claude", "c"),
  ]);
  const result = await executeArchive(plan, { providers });
  assert.deepEqual(calls, ["archive:new", "unarchive:old", "archive:newer"]);
  assert.equal(result.ok, 2);
  assert.equal(result.failed, 1);
  assert.equal(result.blocked, 1);
  assert.deepEqual(result.results.filter((row) => row.status === "ok").map((row) => row.action), ["archive", "archive"]);
  assert.equal(result.results.find((row) => row.id === "old").status, "failed");
});
