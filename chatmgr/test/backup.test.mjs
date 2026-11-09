import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { createBackup, readManifest, removeBackup, restoreBackup } from "../src/core/backup.mjs";
import { fakeProviders, tempDir, writeJsonl } from "./fixtures.mjs";

test("file-backed items are copied byte for byte and restorable", async () => {
  const root = tempDir("chatmgr-backups-");
  const original = join(root, "source", "session.jsonl");
  writeJsonl(original, [{ hello: "world" }]);
  const conv = { provider: "codex", id: "01a1-abc", title: "t", projectPath: "D:\\repo", lastActivity: 0, sourcePath: original };

  const { providers } = fakeProviders();
  const backup = await createBackup([conv], { root, providers, now: Date.UTC(2026, 10, 9, 12, 0, 0) });
  assert.ok(existsSync(backup.manifestPath));
  const manifest = readManifest(backup.manifestPath);
  assert.equal(manifest.items.length, 1);
  assert.equal(manifest.items[0].kind, "file");
  assert.equal(readFileSync(join(backup.dir, manifest.items[0].copy), "utf8"), readFileSync(original, "utf8"));

  // simulate deletion, then restore
  const { rmSync } = await import("node:fs");
  rmSync(original);
  const result = restoreBackup(backup.manifestPath);
  assert.equal(result.restored.length, 1);
  assert.ok(existsSync(original));
});

test("database-backed items are exported as a JSON dump and listed for manual import", async () => {
  const root = tempDir("chatmgr-backups-");
  const conv = { provider: "opencode", id: "ses_x", title: "t", projectPath: "D:/repo", lastActivity: 0, sourcePath: null };
  const { providers } = fakeProviders();
  const backup = await createBackup([conv], { root, providers });
  const manifest = readManifest(backup.manifestPath);
  assert.equal(manifest.items[0].kind, "dump");
  const dump = JSON.parse(readFileSync(join(backup.dir, manifest.items[0].copy), "utf8"));
  assert.equal(dump.id, "ses_x");

  const result = restoreBackup(backup.manifestPath);
  assert.equal(result.restored.length, 0);
  assert.equal(result.manual.length, 1);
});

test("a provider with no backup method aborts the backup instead of silently skipping", async () => {
  const root = tempDir("chatmgr-backups-");
  const conv = { provider: "claude", id: "x", title: "t", projectPath: "D:\\repo", lastActivity: 0, sourcePath: null };
  await assert.rejects(() => createBackup([conv], { root, providers: {} }), /no backup method/);
});

test("removing a backup is an explicit separate action", async () => {
  const root = tempDir("chatmgr-backups-");
  const conv = { provider: "codex", id: "z", title: "t", projectPath: "D:\\repo", lastActivity: 0, sourcePath: null };
  const { providers } = fakeProviders();
  const backup = await createBackup([conv], { root, providers });
  removeBackup(backup.dir);
  assert.equal(existsSync(backup.dir), false);
});
