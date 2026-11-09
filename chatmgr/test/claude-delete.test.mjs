import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import * as claude from "../src/providers/claude.mjs";
import { createBackup, readManifest, restoreBackup } from "../src/core/backup.mjs";
import { executeDeletes } from "../src/core/execute.mjs";
import { BLOCK, buildDeletePlan } from "../src/core/plan.mjs";
import { claudeFixture, tempDir } from "./fixtures.mjs";

test("a backup is written before a claude delete, and it contains the sidecar", async () => {
  const { home, id, path, sidecarPath } = claudeFixture();
  const original = readFileSync(path, "utf8");
  const rows = claude.list({ home });
  const plan = buildDeletePlan(rows);
  assert.equal(plan.items.length, 1);

  const backupRoot = tempDir("chatmgr-backups-");
  const providers = {
    claude: {
      remove: async (conv, options) => {
        // The deletion callback must not run until the recoverable copy exists.
        const dirs = readdirSync(backupRoot);
        assert.equal(dirs.length, 1);
        const manifest = readManifest(join(backupRoot, dirs[0], "manifest.json"));
        assert.equal(manifest.items.length, 1);
        assert.ok(existsSync(join(backupRoot, dirs[0], manifest.items[0].copy)));
        assert.ok(
          existsSync(join(backupRoot, dirs[0], manifest.items[0].sidecar.copy, "subagents", "agent-1.jsonl")),
        );
        return claude.remove(conv, { ...options, home });
      },
    },
  };
  const backup = { create: (items) => createBackup(items, { root: backupRoot, providers }) };

  const result = await executeDeletes(plan, { providers, backup });
  assert.equal(result.ok, 1);
  assert.equal(result.failed, 0);
  assert.ok(result.backup?.manifestPath);
  assert.equal(existsSync(path), false);
  assert.equal(existsSync(sidecarPath), false);

  const manifest = readManifest(result.backup.manifestPath);
  assert.equal(manifest.items[0].id, id);
  assert.equal(readFileSync(join(manifest.dir, manifest.items[0].copy), "utf8"), original);
});

test("a claude session modified in the last ten minutes is blocked", () => {
  const { home, id, path } = claudeFixture();
  const now = Date.now();
  utimesSync(path, new Date(now - 60_000), new Date(now - 60_000));

  const rows = claude.list({ home, now });
  assert.equal(rows[0].running, true);

  const plan = buildDeletePlan(rows);
  assert.equal(plan.items.length, 0);
  assert.equal(plan.blocked[0].code, BLOCK.RUNNING);
  assert.ok(existsSync(path));

  const current = buildDeletePlan(claude.list({ home, now }), { currentKey: `claude:${id}` });
  assert.equal(current.blocked[0].code, BLOCK.CURRENT);

  // Anything that cannot report a boolean is blocked rather than guessed.
  const unknown = buildDeletePlan([{ ...rows[0], running: undefined }]);
  assert.equal(unknown.blocked[0].code, BLOCK.RUNNING_UNKNOWN);
});

test("a transcript outside ~/.claude/projects is rejected without deleting it", async () => {
  const { home, id } = claudeFixture();
  const outsideDir = tempDir("chatmgr-outside-");
  const outside = join(outsideDir, `${id}.jsonl`);
  writeFileSync(outside, '{"type":"user"}\n', "utf8");

  await assert.rejects(() => claude.remove({ id, sourcePath: outside }, { home }), /outside|project/);
  assert.ok(existsSync(outside));

  const traversing = `${join(home, "projects", "D--repo")}/../D--repo/${id}.jsonl`;
  await assert.rejects(() => claude.remove({ id, sourcePath: traversing }, { home }), /\.\./);

  // A traversal in the id never reaches the filesystem.
  await assert.rejects(
    () => claude.remove({ id: "../escape", sourcePath: join(home, "projects", "D--repo", `${id}.jsonl`) }, { home }),
    /unsafe.*session id/,
  );
});

test("restore copies the claude jsonl and its sidecar back", async () => {
  const { home, id, path, sidecarPath } = claudeFixture();
  const original = readFileSync(path, "utf8");
  const rows = claude.list({ home });
  const backup = await createBackup(rows, { root: tempDir("chatmgr-backups-"), providers: { claude } });

  await claude.remove(rows[0], { home });
  assert.equal(existsSync(path), false);
  assert.equal(existsSync(sidecarPath), false);

  const result = restoreBackup(backup.manifestPath);
  assert.equal(result.restored.length, 1);
  assert.equal(result.manual.length, 0);
  assert.equal(readFileSync(path, "utf8"), original);
  assert.equal(readFileSync(join(sidecarPath, "subagents", "agent-1.jsonl"), "utf8"), '{"type":"user"}\n');
  assert.equal(readFileSync(join(sidecarPath, "tool-results", "result.txt"), "utf8"), "subagent output\n");
  assert.equal(claude.list({ home })[0].id, id);
});
