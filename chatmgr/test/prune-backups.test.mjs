import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pruneBackups } from "../src/core/backup-store.mjs";

function backup(root, name, createdAt) {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({ createdAt, items: [] }));
  return dir;
}

test("pruneBackups removes only manifest folders older than the limit", () => {
  const root = mkdtempSync(join(tmpdir(), "chatmgr-prune-"));
  const now = Date.parse("2026-11-20T00:00:00Z");
  const old = backup(root, "old", "2026-11-01T00:00:00Z");
  const fresh = backup(root, "fresh", "2026-11-19T00:00:00Z");
  const stray = join(root, "not-a-backup");
  mkdirSync(stray);

  assert.deepEqual(pruneBackups(root, { days: 14, now, dryRun: true }), [old]);
  assert.ok(existsSync(old), "dry run removes nothing");

  assert.deepEqual(pruneBackups(root, { days: 14, now }), [old]);
  assert.ok(!existsSync(old));
  assert.ok(existsSync(fresh));
  assert.ok(existsSync(stray), "folders without a manifest are never touched");
});
