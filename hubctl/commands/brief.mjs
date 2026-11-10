/**
 * `hubctl brief` — the state of the world in <=40 lines, for a session that
 * has just started. It only reads: `doctor --fast`, git status of the watched
 * repos, the newest audit lines, today's spend and the "Pendiente" section of
 * `working/HANDOFF.md`.
 */
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { basename, isAbsolute, join, resolve } from "node:path";
import { spentTodayAll } from "../../acp/spend-estimate.mjs";
import { gatherDoctor } from "../doctor.mjs";
import { readLocks } from "../live.mjs";
import { CONSENT_PATH, HUB, LOCKS_DIR, LOG_PATH, ROOT, readJson, summarizeConsent } from "../common.mjs";
import { parseRuns, readInflight } from "./status.mjs";

export const MAX_LINES = 40;
const MAX_WIDTH = 118;

/** Watched repos: one path per line (relative to the workspace root's parent), `#` comments. */
export function parseWatchList(text, base) {
  const out = [];
  for (const raw of String(text ?? "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    out.push(isAbsolute(line) ? line : resolve(base, line));
  }
  return out;
}

/** The lines of the `## Pendiente...` section, up to the next `## `, blanks dropped. */
export function pendingSection(markdown) {
  const lines = String(markdown ?? "").split(/\r?\n/);
  const start = lines.findIndex((line) => /^##\s+Pendiente\b/i.test(line));
  if (start < 0) return [];
  const body = [];
  for (const line of lines.slice(start + 1)) {
    if (/^##\s/.test(line)) break;
    if (line.trim()) body.push(line.trimEnd());
  }
  return body;
}

function gitDirty(dir) {
  if (!existsSync(dir)) return { dir, name: basename(dir), missing: true, changed: 0 };
  const result = spawnSync("git", ["-C", dir, "status", "--porcelain"], { encoding: "utf8", windowsHide: true });
  if (result.status !== 0) return { dir, name: basename(dir), missing: true, changed: 0 };
  const changed = result.stdout.split("\n").filter((line) => line.trim()).length;
  return { dir, name: basename(dir), missing: false, changed };
}

export function gatherBrief({
  root = ROOT,
  hub = HUB,
  logPath = LOG_PATH,
  consentPath = CONSENT_PATH,
  now = new Date(),
  doctor = null,
  dirty = gitDirty,
} = {}) {
  const report =
    doctor ??
    gatherDoctor({
      root,
      hub,
      readJson,
      inflight: readInflight(),
      locks: readLocks(LOCKS_DIR),
      fast: true,
      codexCache: null,
    });

  const watchFile = join(root, "working", "repos-vigilados.txt");
  const watched = existsSync(watchFile)
    ? parseWatchList(readFileSync(watchFile, "utf8"), resolve(root, ".."))
    : [];
  const repos = [root, ...watched.filter((dir) => resolve(dir) !== resolve(root))].map(dirty);

  const runs = parseRuns(existsSync(logPath) ? readFileSync(logPath, "utf8") : "", 5);
  const agents = summarizeConsent(readJson(consentPath)).map((row) => row.name);
  const spend = Object.fromEntries(agents.map((name) => [name, spentTodayAll(name, logPath, { now })]));

  const handoff = join(root, "working", "HANDOFF.md");
  const pending = existsSync(handoff) ? pendingSection(readFileSync(handoff, "utf8")) : null;

  return {
    now: now.toISOString(),
    doctor: {
      ok: report.ok,
      counts: report.counts,
      issues: report.checks.filter((c) => c.level !== "ok").map((c) => ({ level: c.level, check: c.check, detail: c.detail })),
    },
    repos,
    runs,
    spend,
    pending,
  };
}

const clip = (text, width = MAX_WIDTH) => (text.length > width ? `${text.slice(0, width - 1)}…` : text);

export function renderBrief(brief) {
  const lines = [];
  const { counts } = brief.doctor;
  lines.push(`BRIEF ${brief.now.replace("T", " ").slice(0, 16)}  doctor: ${counts.ok} ok · ${counts.warn} warn · ${counts.fail} fail`);
  for (const issue of brief.doctor.issues) lines.push(clip(`  ${issue.level === "fail" ? "FAIL" : "warn"} ${issue.check}: ${issue.detail}`));

  const dirty = brief.repos.filter((repo) => repo.changed > 0);
  const missing = brief.repos.filter((repo) => repo.missing);
  lines.push(
    dirty.length
      ? `repos sin commitear: ${dirty.map((repo) => `${repo.name} (${repo.changed})`).join(", ")}`
      : `repos: ${brief.repos.length - missing.length} limpios`,
  );
  if (missing.length) lines.push(`  no encontrados: ${missing.map((repo) => repo.name).join(", ")}`);

  if (brief.runs.length) {
    lines.push("últimas ejecuciones:");
    for (const run of brief.runs) {
      const seconds = run.durationMs == null ? "?" : `${(run.durationMs / 1000).toFixed(1)}s`;
      lines.push(`  ${String(run.time ?? "?").slice(0, 16).replace("T", " ")}  ${run.agent} ${run.status} ${seconds}`);
    }
  } else {
    lines.push("últimas ejecuciones: ninguna");
  }
  const spent = Object.entries(brief.spend)
    .filter(([, usd]) => usd > 0)
    .map(([name, usd]) => `${name} $${usd.toFixed(2)}`);
  lines.push(`gasto hoy: ${spent.length ? spent.join(" · ") : "$0"}`);

  if (brief.pending == null) {
    lines.push("pendiente: no hay working/HANDOFF.md");
  } else if (brief.pending.length) {
    lines.push("pendiente (working/HANDOFF.md):");
    const room = Math.max(0, MAX_LINES - lines.length);
    const shown = brief.pending.slice(0, room > 1 ? room - 1 : 0);
    for (const line of shown) lines.push(clip(`  ${line}`));
    if (shown.length < brief.pending.length) lines.push(`  … ${brief.pending.length - shown.length} líneas más en HANDOFF.md`);
  }
  return lines.slice(0, MAX_LINES).join("\n");
}

export async function runBrief(argv) {
  const brief = gatherBrief();
  process.stdout.write(argv.includes("--json") ? `${JSON.stringify(brief, null, 2)}\n` : `${renderBrief(brief)}\n`);
}
