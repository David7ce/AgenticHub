import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

/** Lists backup directories that carry a manifest, newest first. */
export function listBackups(root) {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const dir = join(root, entry.name);
      const manifestPath = join(dir, "manifest.json");
      if (!existsSync(manifestPath)) return null;
      let manifest;
      try {
        manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      } catch {
        return null;
      }
      return {
        dir,
        manifest: manifestPath,
        createdAt: manifest.createdAt,
        items: manifest.items?.length ?? 0,
        sizeBytes: directorySize(dir),
      };
    })
    .filter(Boolean)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

function directorySize(dir) {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) total += directorySize(full);
    else if (entry.isFile()) total += statSync(full).size;
  }
  return total;
}

/**
 * Removes backup folders (only ones that carry a manifest) older than `days`.
 * `dryRun` lists without removing. Returns the directories affected.
 */
export function pruneBackups(root, { days = 14, now = Date.now(), dryRun = false } = {}) {
  const limit = now - Math.max(0, days) * 86_400_000;
  const old = listBackups(root).filter((b) => {
    const when = Date.parse(b.createdAt);
    return Number.isFinite(when) && when < limit;
  });
  if (!dryRun) for (const b of old) rmSync(b.dir, { recursive: true, force: true });
  return old.map((b) => b.dir);
}
