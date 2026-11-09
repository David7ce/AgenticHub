import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
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
