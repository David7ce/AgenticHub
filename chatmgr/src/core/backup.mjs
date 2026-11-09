import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, copyFileSync, cpSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { keyOf } from "./model.mjs";

/**
 * A deletion is only allowed after a recoverable backup exists. File-backed
 * providers are copied byte for byte; database-backed providers are exported
 * as JSON through their own read path. The manifest is the restore contract:
 * it lists every item, where its copy lives, and how to put it back.
 */
export function backupDirName(now = Date.now()) {
  const d = new Date(now);
  const pad = (n) => String(n).padStart(2, "0");
  return [
    d.getFullYear(),
    pad(d.getMonth() + 1),
    pad(d.getDate()),
    "-",
    pad(d.getHours()),
    pad(d.getMinutes()),
    pad(d.getSeconds()),
  ].join("");
}

/**
 * @param {Object[]} conversations
 * @param {Object} options
 * @param {string} options.root     directory that will hold this backup
 * @param {Object} options.providers provider modules with optional exportDump()
 * @param {number} [options.now]
 */
export async function createBackup(conversations, { root, providers, now = Date.now() }) {
  const dir = join(root, backupDirName(now));
  mkdirSync(dir, { recursive: true });
  const manifest = { createdAt: new Date(now).toISOString(), dir, items: [] };

  for (const conv of conversations) {
    const entry = {
      key: keyOf(conv),
      provider: conv.provider,
      id: conv.id,
      title: conv.title,
      projectPath: conv.projectPath,
      lastActivity: conv.lastActivity,
      restore: null,
    };

    if (conv.sourcePath && existsSync(conv.sourcePath)) {
      const copy = join(dir, conv.provider, `${conv.id}${conv.sourcePath.endsWith(".jsonl") ? ".jsonl" : ""}`);
      mkdirSync(dirname(copy), { recursive: true });
      copyFileSync(conv.sourcePath, copy);
      entry.kind = "file";
      entry.copy = relative(dir, copy);
      entry.original = conv.sourcePath;
      entry.restore = "copy back to original path";
      // Claude keeps subagent transcripts and tool output in <sessionId>/ next
      // to the jsonl. It is part of the same session and must come back too.
      // Re-derive the path if the row predates it, so a folder created between
      // listing and backup is still captured before the delete.
      const sidecarPath =
        conv.sidecarPath ??
        (conv.provider === "claude" ? join(dirname(conv.sourcePath), String(conv.id)) : null);
      if (sidecarPath && existsSync(sidecarPath)) {
        const sidecarCopy = join(dir, conv.provider, `${conv.id}-sidecar`);
        mkdirSync(dirname(sidecarCopy), { recursive: true });
        cpSync(sidecarPath, sidecarCopy, { recursive: true });
        entry.sidecar = { copy: relative(dir, sidecarCopy), original: sidecarPath };
      }
    } else {
      const adapter = providers[conv.provider];
      if (!adapter?.exportDump) {
        throw new Error(`no backup method for ${conv.provider}:${conv.id}`);
      }
      const dump = await adapter.exportDump(conv);
      const copy = join(dir, conv.provider, `${conv.id}.json`);
      mkdirSync(dirname(copy), { recursive: true });
      writeFileSync(copy, JSON.stringify(dump, null, 2), "utf8");
      entry.kind = "dump";
      entry.copy = relative(dir, copy);
      entry.restore = `re-import with the ${conv.provider} CLI; the dump is a faithful export, not a live record`;
    }

    manifest.items.push(entry);
  }

  const manifestPath = join(dir, "manifest.json");
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
  return { dir, manifestPath, manifest };
}

export function readManifest(manifestPath) {
  return JSON.parse(readFileSync(manifestPath, "utf8"));
}

/** Restores file-backed items; dump-backed items are reported for manual import. */
export function restoreBackup(manifestPath) {
  const manifest = readManifest(manifestPath);
  const restored = [];
  const manual = [];
  for (const item of manifest.items) {
    if (item.kind === "file") {
      const copy = join(manifest.dir, item.copy);
      if (!existsSync(copy)) {
        manual.push({ ...item, reason: "backup copy is missing" });
        continue;
      }
      const sidecarCopy = item.sidecar ? join(manifest.dir, item.sidecar.copy) : null;
      if (sidecarCopy && !existsSync(sidecarCopy)) {
        manual.push({ ...item, reason: "sidecar backup copy is missing" });
        continue;
      }
      mkdirSync(dirname(item.original), { recursive: true });
      copyFileSync(copy, item.original);
      if (sidecarCopy) {
        mkdirSync(dirname(item.sidecar.original), { recursive: true });
        cpSync(sidecarCopy, item.sidecar.original, { recursive: true });
      }
      restored.push(item);
    } else {
      manual.push({ ...item, reason: "dump must be imported with the provider CLI" });
    }
  }
  return { restored, manual };
}

/** Explicit, separate step: never called from the deletion path. */
export function removeBackup(dir) {
  rmSync(dir, { recursive: true, force: true });
  return dir;
}
