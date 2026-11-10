/**
 * `hubctl clean` — one place to tidy what agents leave behind.
 *
 * Dry run by default: it prints what it would remove. `--yes` removes it.
 *  - agent worktrees with no changes (a dirty one is work: it needs
 *    `hubctl worktree --prune --force` on purpose, never this command)
 *  - chatmgr safety backups older than --days (default 14)
 */
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { removeWorktree, repoInfo, worktreeHasChanges } from "../../acp/worktree.mjs";
import { pruneBackups } from "../../chatmgr/src/core/backup-store.mjs";
import { HUB, ROOT } from "../common.mjs";
import { countWorktrees } from "./status.mjs";

export function planClean({ worktrees = [], backups = [] } = {}) {
  return {
    worktrees: worktrees.filter((w) => !w.dirty).map((w) => w.path),
    keptDirty: worktrees.filter((w) => w.dirty).map((w) => w.path),
    backups,
  };
}

export async function runClean(argv) {
  const apply = argv.includes("--yes");
  const asJson = argv.includes("--json");
  const daysIndex = argv.indexOf("--days");
  const days = daysIndex === -1 ? 14 : Number(argv[daysIndex + 1]);
  if (!Number.isFinite(days) || days < 0) throw new Error("--days needs a number >= 0");

  const info = repoInfo(ROOT);
  let worktrees = [];
  if (info) {
    const listing = spawnSync("git", ["-C", ROOT, "worktree", "list", "--porcelain"], { encoding: "utf8", windowsHide: true });
    const { agentCheckouts } = countWorktrees(listing.status === 0 ? listing.stdout : "");
    worktrees = agentCheckouts.map((entry) => {
      let ageDays = null;
      try { ageDays = (Date.now() - statSync(entry.path).mtimeMs) / 86_400_000; } catch { /* gone */ }
      return { path: entry.path, dirty: worktreeHasChanges(entry.path), ageDays };
    });
  }

  const backupRoot = join(HUB, "chatmgr", "backups");
  const oldBackups = existsSync(backupRoot) ? pruneBackups(backupRoot, { days, dryRun: true }) : [];
  const plan = planClean({ worktrees, backups: oldBackups });

  const done = { worktrees: [], backups: [], failed: [] };
  if (apply) {
    for (const path of plan.worktrees) (removeWorktree(info.root, path) ? done.worktrees : done.failed).push(path);
    if (plan.backups.length) done.backups = pruneBackups(backupRoot, { days });
  }

  if (asJson) {
    process.stdout.write(JSON.stringify({ apply, days, plan, done }, null, 2) + "\n");
    return;
  }
  const verb = apply ? "removed" : "would remove";
  const nothing = !plan.worktrees.length && !plan.backups.length;
  process.stdout.write(`clean · ${apply ? "applying" : "dry run (add --yes to apply)"}\n\n`);
  process.stdout.write(`worktrees  ${verb} ${plan.worktrees.length} clean`);
  process.stdout.write(plan.keptDirty.length ? `, keeping ${plan.keptDirty.length} with changes\n` : "\n");
  for (const path of plan.worktrees) process.stdout.write(`  ${path}\n`);
  for (const path of plan.keptDirty) process.stdout.write(`  kept (changes) ${path}\n`);
  process.stdout.write(`backups    ${verb} ${plan.backups.length} older than ${days} day(s)\n`);
  for (const path of plan.backups) process.stdout.write(`  ${path}\n`);
  for (const path of done.failed) process.stdout.write(`  failed ${path}\n`);
  if (nothing && !plan.keptDirty.length) process.stdout.write("\nnothing to clean\n");
}
