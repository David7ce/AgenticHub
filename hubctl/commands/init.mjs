/**
 * `hubctl init` — the three setup steps of a fresh clone, in one command.
 *
 * Copies the two tracked examples to their local, git-ignored names and turns
 * the pre-commit hook on. It never overwrites a file that exists and never
 * grants anything: every grant in consent.example.json is disabled, so a fresh
 * clone still runs nothing until its owner edits consent.json.
 *
 * `--workspace` also puts the launcher files the chat clients read (`.mcp.json`
 * for Claude Code, `opencode.json` for OpenCode, `AGENTS.md`, `.claude/`,
 * `.vscode/`) in the folder that holds this clone, from `templates/workspace/`. The
 * same rule: a file that exists is left alone. `opencode.json` is written with
 * this clone's real path, not the one the template was authored on.
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
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
        ? { step: to, action: "create", detail: `copied from ${from}`, from: join(hub, from), to: join(hub, to) }
        : { step: to, action: "leave", detail: `${from} is missing` },
  );
  if (hooksPath === ".githooks") plan.push({ step: "pre-commit hook", action: "keep", detail: "core.hooksPath=.githooks" });
  else if (hooksPath) plan.push({ step: "pre-commit hook", action: "leave", detail: `core.hooksPath is ${hooksPath}; not changed` });
  else plan.push({ step: "pre-commit hook", action: "set", detail: "git config core.hooksPath .githooks" });
  return plan;
}

function filesUnder(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...filesUnder(path));
    else out.push(path);
  }
  return out.sort();
}

/** OpenCode's project config, pointing at this clone. On Windows through cmd.exe, which also works from WSL. */
export function opencodeConfig(hub, platform = process.platform) {
  const server = join(hub, "mcp", "server.mjs");
  const command = platform === "win32" ? ["cmd.exe", "/c", "node", server] : ["node", server];
  return { $schema: "https://opencode.ai/config.json", mcp: { servers: { "agent-hub": { type: "local", command } } } };
}

/** Claude Code's project config: the clone relative to the workspace, whatever the clone's folder is called. */
export function claudeMcpConfig(hub) {
  const server = [relative(resolve(hub, ".."), hub), "mcp", "server.mjs"].join("/");
  return { mcpServers: { "agent-hub": { type: "stdio", command: "node", args: [server] } } };
}

/** The launcher files for the folder that holds this clone: [{ step, action, detail, from, to, content? }] */
export function planWorkspace(hub = HUB, { exists = existsSync, platform = process.platform } = {}) {
  const source = join(hub, "templates", "workspace");
  const workspace = resolve(hub, "..");
  if (!exists(source)) return [{ step: "workspace", action: "leave", detail: "templates/workspace/ is missing" }];
  return filesUnder(source).map((from) => {
    const name = relative(source, from);
    const to = join(workspace, name);
    if (exists(to)) return { step: name, action: "keep", detail: "already there, not touched" };
    // The two files that name this clone are written for where it really is.
    const generated = name === "opencode.json" ? opencodeConfig(hub, platform) : name === ".mcp.json" ? claudeMcpConfig(hub) : null;
    if (name.endsWith(".md")) {
      const cloneName = relative(workspace, hub).replace(/\\/g, "/");
      const content = readFileSync(from, "utf8").replaceAll("__HUB_DIR__", cloneName);
      return { step: name, action: "create", detail: `written for ${hub}`, to, content };
    }
    return generated
      ? { step: name, action: "create", detail: `written for ${hub}`, to, content: `${JSON.stringify(generated, null, 2)}\n` }
      : { step: name, action: "create", detail: `copied to ${workspace}`, from, to };
  });
}

export function runInit(argv, { hub = HUB, out = process.stdout } = {}) {
  const dryRun = argv.includes("--dry-run");
  const plan = planInit(hub);
  if (argv.includes("--workspace")) plan.push(...planWorkspace(hub));
  for (const item of plan) {
    if (!dryRun && item.action === "create") {
      mkdirSync(dirname(item.to), { recursive: true });
      if (item.content !== undefined) writeFileSync(item.to, item.content, "utf8");
      else copyFileSync(item.from, item.to);
    }
    if (!dryRun && item.action === "set" && !git(hub, ["config", "core.hooksPath", ".githooks"]).ok) {
      item.action = "leave";
      item.detail = "could not set core.hooksPath (not a git checkout?)";
    }
    out.write(`${item.action.padEnd(6)} ${item.step.padEnd(22)} ${item.detail}\n`);
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
      "  5. hub init --workspace   (once: the files Claude Code and OpenCode read, in the folder that holds this clone)",
      "",
    ].join("\n"),
  );
}

