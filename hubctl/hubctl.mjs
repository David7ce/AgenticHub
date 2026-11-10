#!/usr/bin/env node
/**
 * hubctl — the minimal control room.
 *
 * There is no database and no daemon here on purpose: the state already exists
 * in `consent.json`, `logs/runs.jsonl`, git worktrees and the two loopback
 * services. This reads those directly and renders one compact screen.
 *
 * Usage:
 *   node agent-hub/hubctl/hubctl.mjs status [--json] [--no-color]
 *   node agent-hub/hubctl/hubctl.mjs live [--once] [--json]
 *   node agent-hub/hubctl/hubctl.mjs doctor [--json] [--fast]
 *
 * Read-only: it never launches, stops or edits anything.
 */
import { pathToFileURL } from "node:url";
import { runStatus } from "./commands/status.mjs";
import { runLive } from "./commands/live.mjs";
import { runReport } from "./commands/report.mjs";
import { runSpend } from "./commands/spend.mjs";
import { runDoctor, runModels } from "./commands/doctor.mjs";
import { runAgent } from "./commands/run.mjs";
import { runHandoff } from "./commands/handoff.mjs";
import { runTasks } from "./commands/tasks.mjs";
import { attach } from "./commands/attach.mjs";
import { runWorktree } from "./commands/worktree.mjs";
import { runClean } from "./commands/clean.mjs";
import { runUsage } from "./commands/usage.mjs";
import { runBench } from "./commands/bench.mjs";
import { runPath } from "./commands/path.mjs";

export { buildHubArgs, inferSessionAgent, summarizeConsent } from "./common.mjs";
export {
  countWorktrees,
  gatherStatus,
  parseRuns,
  pickLatestBench,
  readInflight,
  renderStatus,
} from "./commands/status.mjs";
export { ageLabel, planPrune } from "./commands/worktree.mjs";
export { estimateGo, humanTokens } from "./commands/usage.mjs";

async function main() {
  const argv = process.argv.slice(2);
  const command = argv[0] ?? "status";
  if (command === "status") return runStatus(argv);
  if (command === "live") return runLive(argv);
  if (command === "report") return runReport(argv);
  if (command === "spend") return runSpend(argv);
  if (command === "doctor") return runDoctor(argv);
  if (command === "models") return runModels(argv);
  if (command === "run") return runAgent(argv);
  if (command === "handoff") return runHandoff(argv);
  if (command === "tasks") return runTasks(argv);
  if (command === "attach") return attach(argv);
  if (command === "path") return runPath(argv.slice(1));
  if (command === "bench") return runBench(argv.slice(1));
  if (command === "usage") return runUsage(argv.slice(1));
  if (command === "worktree") return runWorktree(argv.slice(1));
  if (command === "clean") return runClean(argv.slice(1));
  if (command === "-h" || command === "--help" || command === "help") {
    process.stdout.write(
      [
        "usage: hubctl <command>",
        "",
        "  status [--json] [--no-color]     one-shot snapshot",
        "  live [--once] [--json] [--interval MS] [--no-external]  who is working now; q quits, r refreshes, p pauses",
        "  report [--days N] [--json] [--no-color]   completed turns by agent and model",
        "  spend [--days N] [--date YYYY-MM-DD] [--by day,project,agent,model]",
        "  doctor [--json] [--fast]         config coherence: consent vs registry, limits, expiry, doc links, OpenCode MCP",
        "  models --codex [--json]          newest Codex model per family vs models.json (informational)",
        "  run <agent> [--worktree] [--model ID]   run one agent through hub-acp",
        "  handoff <agent> [--cwd DIR] [--note TEXT] [--dry-run]   relay this tree to another agent (quota ran out)",
        "  tasks add|list|show|run|done|block|cancel|retry   the thin work queue (hubctl tasks --help)",
        "  attach <session> [--agent NAME]  resume a session",
        "  path <path> [--json]             both spellings of one path (Windows/WSL)",
        "  bench [args...]                  run the benchmark (passes --dry-run, --reps, --model through)",
        "  usage [--days N] [--json]        estimated allowance spent, per Go model, plus the Claude window",
        "  clean [--yes] [--days N]         tidy clean worktrees and old chatmgr backups (dry run without --yes)",
        "  worktree [--prune] [--force]     list agent worktrees; --prune removes the clean ones",
        "",
      ].join("\n"),
    );
    return;
  }
  process.stderr.write(`unknown command: ${command}\n`);
  process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`hubctl: ${error.message}\n`);
    process.exitCode = 1;
  });
}
