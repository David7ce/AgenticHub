/**
 * `hubctl handoff` — relay this tree to another agent because the previous
 * pool ran out.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildHandoffPrompt } from "../handoff.mjs";
import { LOG_PATH } from "../common.mjs";
import { runAgent } from "./run.mjs";

export async function runHandoff(argv) {
  const target = argv[1];
  if (!target || target.startsWith("-")) {
    throw new Error("usage: hubctl handoff <agent> [--cwd DIR] [--note TEXT] [--from AGENT] [--dry-run] [run flags]");
  }
  const rest = argv.slice(2);
  const take = (flag) => {
    const i = rest.indexOf(flag);
    if (i === -1) return null;
    const v = rest[i + 1];
    rest.splice(i, 2);
    return v ?? null;
  };
  const note = take("--note") ?? "";
  const from = take("--from") ?? "claude";
  const dry = rest.includes("--dry-run");
  if (dry) rest.splice(rest.indexOf("--dry-run"), 1);
  const cwdFlag = rest.indexOf("--cwd");
  const cwd = resolve(cwdFlag === -1 ? process.cwd() : rest[cwdFlag + 1]);
  const prompt = buildHandoffPrompt({
    cwd, target, from, note,
    logText: existsSync(LOG_PATH) ? readFileSync(LOG_PATH, "utf8") : "",
  });
  if (dry) {
    process.stdout.write(`${prompt}
`);
    return;
  }
  const flags = cwdFlag === -1 ? ["--cwd", cwd, ...rest] : rest;
  return runAgent(["run", target, "--prompt", prompt, ...flags]);
}
