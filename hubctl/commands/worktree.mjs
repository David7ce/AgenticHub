/**
 * `hubctl worktree` — list agent checkouts; prune the clean ones.
 *
 * A worktree kept after a fan-out is kept because it has changes: removing it
 * is discarding work, so it takes --force. It looks in the hub's own repository and in every
 * repository named with `--repo PATH` (repeatable): fan-out worktrees live inside the repo they
 * were made from (`<repo>/.git/agent-worktrees/`), e.g. CharStudio.
 */
import { statSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { removeWorktree, repoInfo, worktreeHasChanges } from "../../acp/worktree.mjs";
import { ROOT } from "../common.mjs";
import { countWorktrees } from "./status.mjs";

/** The repositories to look in: the hub's own, plus every `--repo PATH`. */
export function repoRoots(argv, base = ROOT) {
  const extra = argv.flatMap((arg, i) => (arg === "--repo" && argv[i + 1] ? [resolve(argv[i + 1])] : []));
  return [...new Set([base, ...extra])];
}

/** Agent worktrees of every root, each tagged with its repo. A root that is not a git repository is skipped. */
export function agentWorktrees(roots) {
  const rows = [];
  for (const root of roots) {
    const info = repoInfo(root);
    if (!info) {
      process.stderr.write(`hubctl: ${root} is not a git repository, skipped\n`);
      continue;
    }
    const listing = spawnSync("git", ["-C", root, "worktree", "list", "--porcelain"], { encoding: "utf8", windowsHide: true });
    const { agentCheckouts } = countWorktrees(listing.status === 0 ? listing.stdout : "");
    for (const entry of agentCheckouts) {
      let ageDays = null;
      try { ageDays = (Date.now() - statSync(entry.path).mtimeMs) / 86_400_000; } catch { /* gone */ }
      rows.push({ repo: info.root, path: entry.path, dirty: worktreeHasChanges(entry.path), ageDays });
    }
  }
  return rows;
}

export function planPrune(rows, { force = false } = {}) {
  const remove = [];
  const keep = [];
  for (const row of rows) {
    if (row.dirty && !force) keep.push(row);
    else remove.push(row);
  }
  return { remove, keep };
}

export function ageLabel(days) {
  if (days == null || !Number.isFinite(days)) return "?";
  if (days < 1) return `${Math.max(1, Math.round(days * 24))}h`;
  return `${Math.round(days)}d`;
}

export async function runWorktree(argv) {
  const asJson = argv.includes("--json");
  const prune = argv.includes("--prune");
  const force = argv.includes("--force");

  const roots = repoRoots(argv);
  if (!roots.some((root) => repoInfo(root))) {
    process.stderr.write("hubctl worktree: none of the given paths is a git repository\n");
    process.exitCode = 1;
    return;
  }
  const rows = agentWorktrees(roots);

  if (prune) {
    const { remove, keep } = planPrune(rows, { force });
    const removed = [];
    const failed = [];
    for (const row of remove) {
      if (removeWorktree(row.repo, row.path)) removed.push(row.path);
      else failed.push(row.path);
    }
    if (asJson) {
      process.stdout.write(JSON.stringify({ removed, kept: keep.map((r) => r.path), failed }, null, 2) + "\n");
      return;
    }
    process.stdout.write(`removed ${removed.length} worktree(s), kept ${keep.length}\n`);
    for (const path of keep) process.stdout.write(`  kept   ${path} (has changes)\n`);
    for (const path of failed) process.stdout.write(`  failed ${path}\n`);
    return;
  }

  if (asJson) {
    process.stdout.write(JSON.stringify({ worktrees: rows }, null, 2) + "\n");
    return;
  }
  if (!rows.length) {
    process.stdout.write("no agent worktrees\n");
    return;
  }
  process.stdout.write(`agent worktrees · ${rows.length}\n\n`);
  for (const row of rows) {
    process.stdout.write(
      `${(row.dirty ? "dirty" : "clean").padEnd(6)}${ageLabel(row.ageDays).padEnd(5)}${row.path}\n`,
    );
  }
  process.stdout.write("\n--prune removes the clean ones; --force also removes dirty ones; --repo PATH looks in another repository too.\n");
}
