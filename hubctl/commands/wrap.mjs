/**
 * `hubctl wrap` — a DRAFT of the end-of-session JOURNAL entry, built from facts
 * that already exist: commits since the last wrap, failed or costly runs,
 * doctor warnings and repos with uncommitted work. It prints; it writes only
 * with `--write --yes`, which also moves the marker (`working/.ultimo-wrap`).
 * `--mark` moves the marker without touching the JOURNAL (you pasted the draft yourself).
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { gatherDoctor } from "../doctor.mjs";
import { readLocks } from "../live.mjs";
import { HUB, LOCKS_DIR, LOG_PATH, ROOT, STATE_DIR, readJson } from "../common.mjs";
import { readInflight } from "./status.mjs";
import { gitDirty, parseWatchList } from "./brief.mjs";
import { resolve } from "node:path";

const git = (root, args) => {
  const r = spawnSync("git", ["-C", root, ...args], { encoding: "utf8", windowsHide: true });
  return r.status === 0 ? r.stdout : null;
};

/** The marker is `<ISO time>\n<HEAD hash>`; a missing or odd file means "since 24 h ago". */
export function parseMarker(text) {
  const [time, hash] = String(text ?? "").split(/\r?\n/).map((s) => s.trim());
  const ms = Date.parse(time);
  return Number.isFinite(ms) ? { time: new Date(ms).toISOString(), hash: hash || null } : null;
}

export function pickRuns(jsonl, sinceIso) {
  const since = Date.parse(sinceIso);
  const out = [];
  for (const line of String(jsonl ?? "").split("\n")) {
    if (!line.trim()) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    if (!(Date.parse(rec.time) >= since)) continue;
    const cost = typeof rec.cost === "number" ? rec.cost : rec.cost?.amount;
    const failed = rec.status && rec.status !== "ok";
    if (failed || (typeof cost === "number" && cost > 0)) {
      out.push({
        time: String(rec.time).slice(11, 16),
        agent: rec.agent ?? "?",
        status: rec.status ?? "?",
        cost: typeof cost === "number" ? cost : null,
        prompt: String(rec.prompt ?? "").replace(/\s+/g, " ").slice(0, 70),
      });
    }
  }
  return out;
}

export function buildDraft({ now, commits, runs, issues, dirty }) {
  const day = now.toISOString().slice(0, 10);
  const hour = now.toISOString().slice(11, 16);
  const lines = [`## ${day} (${hour}) — TÍTULO`, ""];
  if (commits.length) {
    lines.push("- **Commits**:");
    for (const c of commits) lines.push(`  - \`${c.hash}\` ${c.subject}`);
  } else {
    lines.push("- **Commits**: ninguno desde el último wrap.");
  }
  if (runs.length) {
    lines.push("- **Runs con fallo o coste**:");
    for (const r of runs) lines.push(`  - ${r.time} ${r.agent} ${r.status}${r.cost ? ` $${r.cost.toFixed(2)}` : ""} — ${r.prompt}`);
  }
  if (issues.length) {
    lines.push("- **Avisos de doctor**:");
    for (const i of issues) lines.push(`  - ${i.level} ${i.check}: ${i.detail}`);
  }
  const open = dirty.filter((d) => d.changed > 0);
  if (open.length) lines.push(`- **Sin commitear**: ${open.map((d) => `${d.name} (${d.changed})`).join(", ")}`);
  lines.push("- **Siguiente paso**: …");
  return lines.join("\n");
}

/** Insert the entry right under the `# …` title so the newest stays first. */
export function insertEntry(journal, draft) {
  const eol = journal.includes("\r\n") ? "\r\n" : "\n";
  const lines = journal.split(/\r?\n/);
  const at = lines[0]?.startsWith("# ") ? 1 : 0;
  lines.splice(at, 0, "", ...draft.split("\n"));
  return lines.join(eol).replace(/(\r?\n){3,}/g, `${eol}${eol}`);
}

export async function runWrap(argv) {
  const markerPath = join(STATE_DIR, "working", ".ultimo-wrap");
  const journalPath = join(STATE_DIR, "working", "JOURNAL.md");
  const now = new Date();
  const head = git(ROOT, ["rev-parse", "HEAD"])?.trim() ?? null;
  const writeMarker = () => writeFileSync(markerPath, `${now.toISOString()}\n${head ?? ""}\n`);

  if (argv.includes("--mark")) {
    writeMarker();
    process.stdout.write("marker moved\n");
    return;
  }

  const marker = parseMarker(existsSync(markerPath) ? readFileSync(markerPath, "utf8") : "");
  const sinceIso = marker?.time ?? new Date(now - 24 * 3_600_000).toISOString();
  const range = marker?.hash && git(ROOT, ["cat-file", "-e", `${marker.hash}^{commit}`]) !== null
    ? [`${marker.hash}..HEAD`]
    : [`--since=${sinceIso}`];
  const commits = (git(ROOT, ["log", "--format=%h%x1f%s", ...range]) ?? "")
    .split("\n").filter(Boolean).map((l) => { const [hash, subject] = l.split("\x1f"); return { hash, subject }; });

  const report = gatherDoctor({ root: ROOT, stateDir: STATE_DIR, hub: HUB, readJson, inflight: readInflight(), locks: readLocks(LOCKS_DIR), fast: true, codexCache: null });
  const issues = report.checks.filter((c) => c.level !== "ok");
  const watchFile = join(STATE_DIR, "working", "repos-vigilados.txt");
  const watched = existsSync(watchFile) ? parseWatchList(readFileSync(watchFile, "utf8"), resolve(ROOT, "..")) : [];
  const dirty = [ROOT, ...watched.filter((d) => resolve(d) !== resolve(ROOT))].map(gitDirty);
  const runs = pickRuns(existsSync(LOG_PATH) ? readFileSync(LOG_PATH, "utf8") : "", sinceIso);

  const draft = buildDraft({ now, commits, runs, issues, dirty });
  if (argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify({ since: sinceIso, commits, runs, issues, dirty, draft }, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${draft}\n`);

  if (argv.includes("--write")) {
    if (!argv.includes("--yes")) {
      process.stderr.write("\nnothing written: --write needs --yes (replace TÍTULO and the last bullet afterwards)\n");
      process.exitCode = 1;
      return;
    }
    writeFileSync(journalPath, insertEntry(readFileSync(journalPath, "utf8"), draft));
    writeMarker();
    process.stderr.write("\nappended to working/JOURNAL.md; marker moved\n");
  }
}
