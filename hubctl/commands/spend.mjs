/**
 * `hubctl spend` — tokens by project and day.
 *
 * OpenCode exact, Claude cost-only, Codex from its rollouts. On Windows it
 * falls back to the WSL copy of the OpenCode database when the local one is
 * missing, by re-invoking this entry point on the other side.
 */
import { existsSync } from "node:fs";
import { toWsl } from "../../acp/paths.mjs";
import {
  defaultDbPath,
  forwardSpendArgs,
  mergeSpend,
  rangeFor,
  dayKey,
  projectLabel,
  readClaudeSpend,
  readOpenCodeSpend,
  readOpenCodeSpendViaWsl,
  renderSpend,
  toCsv,
} from "../spend.mjs";
import { readCodexSpend } from "../spend-codex.mjs";
import { HUBCTL_ENTRY, LOG_PATH, useColor } from "../common.mjs";

export async function runSpend(argv) {
  const value = (flag, fallback = null) => {
    const index = argv.indexOf(flag);
    return index === -1 ? fallback : argv[index + 1];
  };
  const by = String(value("--by", "day,project")).split(",").map((part) => part.trim()).filter(Boolean);
  const options = {
    days: Number(value("--days", 7)) || 7,
    date: value("--date"),
    from: value("--from"),
    to: value("--to"),
    utc: argv.includes("--utc"),
    project: value("--project"),
    includeSubagents: !argv.includes("--no-subagents"),
  };
  const explicitDb = value("--db") || process.env.OPENCODE_DB;
  const opencode =
    process.platform === "win32" && !explicitDb && !existsSync(defaultDbPath())
      ? readOpenCodeSpendViaWsl({
          hubctlWslPath: toWsl(HUBCTL_ENTRY),
          args: forwardSpendArgs(argv),
        })
      : readOpenCodeSpend({ ...options, dbPath: explicitDb || undefined });
  // Internal: the WSL side of a Windows `spend` call returns only its rows.
  if (argv.includes("--opencode-only")) {
    process.stdout.write(`${JSON.stringify(opencode)}\n`);
    return;
  }
  const claude = readClaudeSpend({
    ...options,
    logPath: value("--log") || LOG_PATH,
  });
  const utc = argv.includes("--utc");
  const codex = readCodexSpend({
    range: rangeFor({ ...options, utc }),
    dayKey: (ms) => dayKey(ms, utc),
    projectLabel,
    project: options.project ?? null,
  });
  const result = mergeSpend(opencode, claude, codex);
  if (argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  if (argv.includes("--csv")) {
    process.stdout.write(`${toCsv(result.rows, by)}\n`);
    return;
  }
  if (result.warnings.length) {
    for (const warning of result.warnings) process.stderr.write(`[spend] ${warning}\n`);
  }
  process.stdout.write(`${renderSpend(result.rows, {
    color: Boolean(useColor) && !argv.includes("--no-color"),
    by,
  })}\n`);
}
