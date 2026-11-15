import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { planInit, runInit } from "../commands/init.mjs";

function clone(t) {
  const hub = mkdtempSync(join(tmpdir(), "hub-init-"));
  t.after(() => rmSync(hub, { recursive: true, force: true }));
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
