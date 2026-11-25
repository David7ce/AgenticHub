/**
 * `hubctl clean` — one place to tidy what agents leave behind.
 *
 * Dry run by default: it prints what it would remove. `--yes` removes it.
 *  - agent worktrees with no changes (a dirty one is work: it needs
 *    `hubctl worktree --prune --force` on purpose, never this command)
 *  - orphaned inflight records whose process is gone (a live or unknown pid
 *    stays: from the other side of the WSL boundary "dead" cannot be proven)
 */
import { rmSync } from "node:fs";
import { removeWorktree } from "../../acp/worktree.mjs";
import { readInflight } from "./status.mjs";
import { agentWorktrees, repoRoots } from "./worktree.mjs";

export function planClean({ worktrees = [], inflight = [] } = {}) {
  return {
    worktrees: worktrees.filter((w) => !w.dirty).map((w) => w.path),
    keptDirty: worktrees.filter((w) => w.dirty).map((w) => w.path),
    inflight: inflight.filter((run) => run.alive === false && run.file).map((run) => run.file),
  };
}

export async function runClean(argv) {
  const apply = argv.includes("--yes");
  const asJson = argv.includes("--json");
  const worktrees = agentWorktrees(repoRoots(argv));
  const repoOf = new Map(worktrees.map((w) => [w.path, w.repo]));

  const plan = planClean({ worktrees, inflight: readInflight() });

  const done = { worktrees: [], inflight: [], failed: [] };
  if (apply) {
    for (const path of plan.worktrees) (removeWorktree(repoOf.get(path), path) ? done.worktrees : done.failed).push(path);
    for (const file of plan.inflight) {
      try { rmSync(file, { force: true }); done.inflight.push(file); } catch { done.failed.push(file); }
    }
  }

  if (asJson) {
    process.stdout.write(JSON.stringify({ apply, plan, done }, null, 2) + "\n");
    return;
  }
  const verb = apply ? "removed" : "would remove";
  const nothing = !plan.worktrees.length && !plan.inflight.length;
  process.stdout.write(`clean · ${apply ? "applying" : "dry run (add --yes to apply)"}\n\n`);
  process.stdout.write(`worktrees  ${verb} ${plan.worktrees.length} clean`);
  process.stdout.write(plan.keptDirty.length ? `, keeping ${plan.keptDirty.length} with changes\n` : "\n");
  for (const path of plan.worktrees) process.stdout.write(`  ${path}\n`);
  for (const path of plan.keptDirty) process.stdout.write(`  kept (changes) ${path}\n`);
  process.stdout.write(`inflight   ${verb} ${plan.inflight.length} orphaned\n`);
  for (const file of plan.inflight) process.stdout.write(`  ${file}\n`);
  for (const path of done.failed) process.stdout.write(`  failed ${path}\n`);
  if (nothing && !plan.keptDirty.length) process.stdout.write("\nnothing to clean\n");
}
