/**
 * `hubctl init` — the three setup steps of a fresh clone, in one command.
 *
 * Copies the two tracked examples to their local, git-ignored names and turns
 * the pre-commit hook on. It never overwrites a file that exists and never
 * grants anything: every grant in consent.example.json is disabled, so a fresh
 * clone still runs nothing until its owner edits consent.json.
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { HUB } from "../common.mjs";

const COPIES = [
  ["consent.example.json", "consent.json"],
  [join("acp", "agents.example.json"), join("acp", "agents.json")],
];

function git(hub, args) {
  const result = spawnSync("git", ["-C", hub, ...args], { encoding: "utf8", windowsHide: true });
  return { ok: result.status === 0, out: String(result.stdout ?? "").trim() };
}

/** What init would do, without doing it: [{ step, action: "create" | "keep" | "set" | "leave", detail }] */
export function planInit(hub = HUB, { exists = existsSync, hooksPath = git(hub, ["config", "core.hooksPath"]).out } = {}) {
  const plan = COPIES.map(([from, to]) =>
    exists(join(hub, to))
      ? { step: to, action: "keep", detail: "already there, not touched" }
      : exists(join(hub, from))
        ? { step: to, action: "create", detail: `copied from ${from}`, from, to }
        : { step: to, action: "leave", detail: `${from} is missing` },
  );
  if (hooksPath === ".githooks") plan.push({ step: "pre-commit hook", action: "keep", detail: "core.hooksPath=.githooks" });
  else if (hooksPath) plan.push({ step: "pre-commit hook", action: "leave", detail: `core.hooksPath is ${hooksPath}; not changed` });
  else plan.push({ step: "pre-commit hook", action: "set", detail: "git config core.hooksPath .githooks" });
  return plan;
}

export function runInit(argv, { hub = HUB, out = process.stdout } = {}) {
  const dryRun = argv.includes("--dry-run");
  const plan = planInit(hub);
  for (const item of plan) {
    if (!dryRun && item.action === "create") copyFileSync(join(hub, item.from), join(hub, item.to));
    if (!dryRun && item.action === "set" && !git(hub, ["config", "core.hooksPath", ".githooks"]).ok) {
      item.action = "leave";
      item.detail = "could not set core.hooksPath (not a git checkout?)";
    }
    out.write(`${item.action.padEnd(6)} ${item.step.padEnd(16)} ${item.detail}\n`);
  }
  out.write(
    [
      "",
      dryRun ? "dry run: nothing was changed." : "done.",
      "next:",
      "  1. edit consent.json: every grant starts disabled; enable the agents you want and list their writeTrees",
      "  2. edit acp/agents.json if an agent is not on PATH",
      "  3. hub doctor        (says what does not add up)",
      "  4. npm link          (once, for the short `hub` command)",
      "",
    ].join("\n"),
  );
}
