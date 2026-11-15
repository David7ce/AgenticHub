import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { checkDocumentation } from "../../tools/docs-check.mjs";

import { claudeMcpConfig, opencodeConfig, planInit, planWorkspace, runInit } from "../commands/init.mjs";

function clone(t, name = "agent-hub") {
  // The clone sits inside a workspace folder, as it does for real: <workspace>/agent-hub.
  const workspace = mkdtempSync(join(tmpdir(), "hub-init-"));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  const hub = join(workspace, name);
  mkdirSync(hub);
  mkdirSync(join(hub, "acp"));
  writeFileSync(join(hub, "consent.example.json"), '{"claude":{"enabled":false}}');
  writeFileSync(join(hub, "acp", "agents.example.json"), '{"agents":{}}');
  spawnSync("git", ["init", "-q", hub]);
  return hub;
}

const silent = { write: () => {} };

test("init creates the local files from the examples and turns the hook on", (t) => {
  const hub = clone(t);
  assert.deepEqual(planInit(hub).map((item) => item.action), ["create", "create", "set"]);
  runInit([], { hub, out: silent });
  assert.equal(readFileSync(join(hub, "consent.json"), "utf8"), '{"claude":{"enabled":false}}');
  assert.equal(readFileSync(join(hub, "acp", "agents.json"), "utf8"), '{"agents":{}}');
  assert.equal(spawnSync("git", ["-C", hub, "config", "core.hooksPath"], { encoding: "utf8" }).stdout.trim(), ".githooks");
});

test("init never overwrites what is already there, and --dry-run changes nothing", (t) => {
  const hub = clone(t);
  runInit(["--dry-run"], { hub, out: silent });
  assert.deepEqual(planInit(hub).map((item) => item.action), ["create", "create", "set"]);

  writeFileSync(join(hub, "consent.json"), '{"mine":true}');
  spawnSync("git", ["-C", hub, "config", "core.hooksPath", "elsewhere"]);
  runInit([], { hub, out: silent });
  assert.equal(readFileSync(join(hub, "consent.json"), "utf8"), '{"mine":true}');
  assert.equal(spawnSync("git", ["-C", hub, "config", "core.hooksPath"], { encoding: "utf8" }).stdout.trim(), "elsewhere");
  assert.deepEqual(planInit(hub).map((item) => item.action), ["keep", "keep", "leave"]);
});

test("init --workspace installs the launcher files next to the clone, pointing at it", (t) => {
  const hub = clone(t);
  const workspace = join(hub, "..");
  mkdirSync(join(hub, "templates", "workspace", ".claude"), { recursive: true });
  writeFileSync(join(hub, "templates", "workspace", ".mcp.json"), '{"mcpServers":{}}');
  writeFileSync(join(hub, "templates", "workspace", ".claude", "settings.json"), "{}");
  writeFileSync(join(hub, "templates", "workspace", "opencode.json"), '{"mcp":{"servers":{"agent-hub":{"command":["node","D:\\\\Somewhere\\\\Else"]}}}}');
  writeFileSync(join(workspace, ".mcp.json"), '{"mine":true}');

  runInit([], { hub, out: silent });
  assert.equal(existsSync(join(workspace, "opencode.json")), false, "without --workspace nothing leaves the clone");

  runInit(["--workspace"], { hub, out: silent });
  assert.equal(readFileSync(join(workspace, ".mcp.json"), "utf8"), '{"mine":true}', "an existing file is kept");
  assert.equal(readFileSync(join(workspace, ".claude", "settings.json"), "utf8"), "{}");
  const opencode = JSON.parse(readFileSync(join(workspace, "opencode.json"), "utf8"));
  assert.equal(opencode.mcp.servers["agent-hub"].command.at(-1), join(hub, "mcp", "server.mjs"), "this clone, not the template's path");
  assert.ok(planWorkspace(hub).every((item) => item.action === "keep"));
});

test("the OpenCode entry goes through cmd.exe on Windows and plain node elsewhere", () => {
  assert.deepEqual(opencodeConfig("/w/agent-hub", "linux").mcp.servers["agent-hub"].command.slice(0, 1), ["node"]);
  assert.deepEqual(opencodeConfig("D:\\w\\agent-hub", "win32").mcp.servers["agent-hub"].command.slice(0, 3), ["cmd.exe", "/c", "node"]);
});

test("the Claude Code entry names the clone by its real folder", () => {
  assert.deepEqual(claudeMcpConfig(join("/w", "my-hub")).mcpServers["agent-hub"].args, ["my-hub/mcp/server.mjs"]);
});



test("real workspace templates render documentation and launchers for a renamed clone", (t) => {
  const hub = clone(t, "My renamed hub");
  const workspace = resolve(hub, "..");
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  cpSync(join(repo, "templates"), join(hub, "templates"), { recursive: true });
  cpSync(join(repo, "docs"), join(hub, "docs"), { recursive: true });
  cpSync(join(repo, "AGENTS.md"), join(hub, "AGENTS.md"));

  runInit(["--workspace", "--dry-run"], { hub, out: silent });
  assert.equal(existsSync(join(workspace, "README.md")), false);
  runInit(["--workspace"], { hub, out: silent });
  for (const name of ["AGENTS.md", "README.md", "CLAUDE.md"]) {
    const text = readFileSync(join(workspace, name), "utf8");
    assert.equal(text.includes("__HUB_DIR__"), false, name);
  }
  assert.match(readFileSync(join(workspace, "README.md"), "utf8"), /My renamed hub\/docs\/README.md/);
  assert.deepEqual(checkDocumentation(workspace, ["AGENTS.md", "README.md", "CLAUDE.md"].map((name) => join(workspace, name))).errors, []);
  const mcp = JSON.parse(readFileSync(join(workspace, ".mcp.json"), "utf8"));
  assert.equal(mcp.mcpServers["agent-hub"].args[0], "My renamed hub/mcp/server.mjs");
  const opencode = JSON.parse(readFileSync(join(workspace, "opencode.json"), "utf8"));
  assert.equal(opencode.mcp.servers["agent-hub"].command.at(-1), join(hub, "mcp", "server.mjs"));
  const denied = JSON.parse(readFileSync(join(workspace, ".claude", "settings.json"), "utf8"));
  assert.ok(denied.permissions.deny.includes("Read(./.env)"));
  assert.ok(planWorkspace(hub).every((item) => item.action === "keep"));
});
