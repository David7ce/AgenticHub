/**
 * `hubctl doctor` — config coherence (consent vs registry, limits, expiry,
 * doc links, OpenCode MCP). `hubctl models --codex` is informational and only
 * compares the local Codex cache against models.json.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { compareCodexCatalog, gatherDoctor, latestCodexModels, renderDoctor } from "../doctor.mjs";
import { readLocks } from "../live.mjs";
import { HUB, LOCKS_DIR, ROOT, STATE_DIR, readJson, useColor, yellow } from "../common.mjs";
import { readInflight } from "./status.mjs";

function defaultCodexCache() {
  if (process.env.CODEX_MODELS_CACHE) return process.env.CODEX_MODELS_CACHE;
  const local = join(homedir(), ".codex", "models_cache.json");
  if (existsSync(local)) return local;
  if (process.platform !== "win32") {
    const win = join("/mnt/c/Users", process.env.USER || process.env.USERNAME || "user", ".codex", "models_cache.json");
    if (existsSync(win)) return win;
  }
  return local;
}
const CODEX_CACHE = defaultCodexCache();

// Informational only: the newest model per Codex family that the local Codex
// knows about, and whether models.json lists it. It never edits the file.
export async function runModels(argv) {
  if (!argv.includes("--codex")) {
    process.stderr.write("usage: hubctl models --codex [--json]\n");
    process.exitCode = 1;
    return;
  }
  const cache = readJson(CODEX_CACHE);
  if (!cache) {
    process.stdout.write(`no Codex models cache at ${CODEX_CACHE}\n`);
    return;
  }
  const rows = compareCodexCatalog(readJson(join(HUB, "models.json")), latestCodexModels(cache));
  if (argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify({ fetchedAt: cache.fetched_at ?? null, families: rows }, null, 2)}\n`);
    return;
  }
  const lines = [`codex models · cache ${cache.fetched_at ?? "?"}`, ""];
  for (const r of rows) {
    lines.push(`${r.family.padEnd(6)} ${r.latest.padEnd(16)} ${r.inCatalog ? "in models.json" : yellow("missing from models.json")}`);
  }
  process.stdout.write(`${lines.join("\n")}\n`);
}

export async function runDoctor(argv) {
  const report = gatherDoctor({
    root: ROOT,
    stateDir: STATE_DIR,
    hub: HUB,
    readJson,
    inflight: readInflight(),
    locks: readLocks(LOCKS_DIR),
    fast: argv.includes("--fast"),
    codexCache: readJson(CODEX_CACHE),
  });
  if (argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}
`);
  } else {
    const color = useColor && !argv.includes("--no-color");
    process.stdout.write(`${renderDoctor(report, { paint: color ? (code, text) => `[${code}m${text}[0m` : undefined })}
`);
  }
  if (!report.ok) process.exitCode = 1;
}
