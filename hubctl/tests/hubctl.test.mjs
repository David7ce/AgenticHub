import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildHubArgs, countWorktrees, inferSessionAgent, parseRuns, readInflight, renderStatus, summarizeConsent } from "../hubctl.mjs";

test("summarizeConsent marks each lifecycle state", () => {
  const now = Date.parse("2026-10-30T00:00:00Z");
  const rows = summarizeConsent(
    {
      _note: "ignored",
      good: { enabled: true, overseerAck: true, expires: "2026-11-23T00:00:00Z" },
      off: { enabled: false, overseerAck: true },
      unacked: { enabled: true, overseerAck: false },
      old: { enabled: true, overseerAck: true, expires: "2026-10-01T00:00:00Z" },
    },
    now,
  );
  const byName = Object.fromEntries(rows.map((row) => [row.name, row]));
  assert.equal(byName.good.status, "ok");
  assert.equal(byName.good.daysLeft, 24);
  assert.equal(byName.off.status, "disabled");
  assert.equal(byName.unacked.status, "unacked");
  assert.equal(byName.old.status, "expired");
  assert.equal(rows.some((row) => row.name === "_note"), false);
});

test("parseRuns returns the newest entries first and survives a bad line", () => {
  const text = [
    '{"time":"2026-10-30T00:00:00Z","agent":"a","status":"ok","durationMs":1000}',
    "not json",
    '{"time":"2026-10-30T00:01:00Z","agent":"b","status":"failed","durationMs":2000}',
  ].join("\n");
  const rows = parseRuns(text, 5);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].agent, "b");
  assert.equal(rows[1].agent, "a");
});

test("countWorktrees separates agent checkouts from the main tree", () => {
  const porcelain = [
    "worktree /repo",
    "HEAD abc",
    "branch refs/heads/main",
    "",
    "worktree /repo/.git/agent-worktrees/x-claude",
    "HEAD def",
    "detached",
    "",
  ].join("\n");
  const result = countWorktrees(porcelain);
  assert.equal(result.total, 2);
  assert.equal(result.agentCheckouts.length, 1);
  assert.match(result.agentCheckouts[0].path, /agent-worktrees/);
});

const status = {
  now: "2026-10-30T01:24:00.000Z",
  hint: null,
  agents: [{ name: "claude", status: "ok", daysLeft: 24 }],
  bridge: { up: true, port: "3010", models: 2, modelIds: ["claude", "opencode"] },
  memory: { up: true, port: "37777", provider: "claude", quota7d: 0.99 },
  starnet: { up: true, port: "8787" },
  worktrees: { total: 2, agentCheckouts: [{ path: "/repo/.git/agent-worktrees/x" }] },
  bench: { baseline: 15, attempts: 15, latest: { passed: 15, attempts: 15, stamp: "2026-10-30" } },
  egress: { ok: true, warnings: [] },
  runs: [{ agent: "claude", status: "ok", durationMs: 4800 }],
};

test("renderStatus shows every plane", () => {
  const text = renderStatus(status, { color: false });
  assert.match(text, /claude ok/);
  assert.match(text, /3010 up · claude, opencode/);
  assert.match(text, /37777 up · claude · 7d 99%/);
  assert.match(text, /8787 up/);
  assert.match(text, /2 total · 1 agent/);
  assert.match(text, /15\/15 baseline · last ok/);
  assert.match(text, /claude ok 4\.8s/);
});

test("renderStatus prints the WSL hint when loopback probes fail", () => {
  const text = renderStatus(
    {
      ...status,
      hint: "run hubctl on Windows: WSL cannot reach Windows loopback services",
      bridge: { up: false, port: "3010", models: null, modelIds: [] },
      memory: { up: false, port: "37777", provider: null, quota7d: null },
    },
    { color: false },
  );
  assert.match(text, /WSL cannot reach Windows loopback services/);
  assert.doesNotMatch(text, /3010/, "a dormant bridge is not a red line every day");
  assert.match(text, /37777 stopped/);
});

test("buildHubArgs maps flags to hub-acp", () => {
  const args = buildHubArgs({
    agent: "opencode",
    resume: "ses_1",
    cwd: "D:/x",
    permission: "allow-reads",
    json: true,
    model: "opencode/gpt-6-luna",
  });
  assert.equal(args[args.indexOf("--agent") + 1], "opencode");
  assert.equal(args[args.indexOf("--permission") + 1], "allow-reads");
  assert.equal(args[args.indexOf("--resume") + 1], "ses_1");
  assert.equal(args[args.indexOf("--cwd") + 1], "D:/x");
  assert.equal(args[args.indexOf("--model") + 1], "opencode/gpt-6-luna");
  assert.ok(args.includes("--json"));
});

test("inferSessionAgent matches full ids and prefixes", () => {
  const runs = [
    { agent: "claude", sessionId: "ses_abc123" },
    { agent: "opencode", sessionId: null },
  ];
  assert.deepEqual(inferSessionAgent(runs, "ses_abc123"), {
    agent: "claude",
    sessionId: "ses_abc123",
  });
  assert.deepEqual(inferSessionAgent(runs, "ses_abc"), {
    agent: "claude",
    sessionId: "ses_abc123",
  });
  assert.equal(inferSessionAgent(runs, "nope"), null);
});

test("readInflight sorts by age and marks a dead holder", () => {
  const dir = mkdtempSync(join(tmpdir(), "hub-inflight-"));
  const write = (name, record) => writeFileSync(join(dir, name), JSON.stringify(record));
  const now = Date.now();
  write("1.json", {
    pid: process.pid,
    platform: process.platform,
    agent: "opencode",
    cwd: "/repo/a",
    started: new Date(now - 120_000).toISOString(),
    lastTool: "patch: a.gd (completed)",
  });
  write("2.json", {
    pid: 999_999,
    platform: process.platform,
    agent: "claude",
    cwd: "/repo/b",
    started: new Date(now - 10_000).toISOString(),
  });
  const rows = readInflight(dir);
  assert.equal(rows.length, 2);
  // Newest first: the second record started a minute and a half later.
  assert.equal(rows[0].agent, "claude");
  assert.equal(rows[0].alive, false, "a pid that does not exist is not running");
  assert.equal(rows[1].alive, true, "our own pid is alive");
  assert.ok(rows[1].ageMs >= 120_000);
  assert.equal(rows[1].lastTool, "patch: a.gd (completed)");
});

test("a bench run on another model is labelled with that model", () => {
  const base = {
    now: "2026-11-04T00:00:00Z",
    hint: null,
    agents: [{ name: "opencode", status: "ok", daysLeft: 28 }],
    bridge: { up: false, port: "3010", models: null, modelIds: [] },
    memory: { up: false, port: "37777", provider: null, quota7d: null },
    starnet: { up: false, port: "8787" },
    worktrees: { total: 1, agentCheckouts: [] },
    egress: { ok: true, warnings: [] },
    inflight: [],
    runs: [],
    bench: {
      baseline: 15,
      attempts: 15,
      baselineModel: "opencode-go/deepseek-v4.1-flash",
      latest: {
        passed: 9,
        attempts: 15,
        stamp: "2026-11-04",
        model: "opencode-go/beam-free",
      },
    },
  };
  const text = renderStatus(base, { color: false });
  // 9/15 on a different model is a fact about that model, not a regression.
  assert.match(text, /last 9\/15 on beam-free/);
  assert.doesNotMatch(text, /last 9\/15(?! on)/);
});

test("a clean run over the same tasks is 'last ok' even with a different attempt count", () => {
  // The v2 baseline ran one task twice: 15 attempts over 14 tasks. A clean
  // 14/14 today covers the same tasks and is not a subset of it.
  const status = {
    now: "2026-11-04T00:00:00Z",
    hint: null,
    agents: [{ name: "opencode", status: "ok", daysLeft: 28 }],
    bridge: { up: false, port: "3010", models: null, modelIds: [] },
    memory: { up: false, port: "37777", provider: null, quota7d: null },
    starnet: { up: false, port: "8787" },
    worktrees: { total: 1, agentCheckouts: [] },
    egress: { ok: true, warnings: [] },
    inflight: [],
    runs: [],
    bench: {
      baseline: 15,
      attempts: 15,
      tasks: 14,
      baselineModel: "opencode-go/deepseek-v4.1-flash",
      latest: { passed: 14, attempts: 14, tasks: 14, stamp: "2026-11-04", model: "opencode-go/deepseek-v4.1-flash" },
    },
  };
  assert.match(renderStatus(status, { color: false }), /last ok/);
});

test("a job's inflight record names the job", () => {
  const dir = mkdtempSync(join(tmpdir(), "hub-inflight-job-"));
  writeFileSync(
    join(dir, "4242.json"),
    JSON.stringify({
      pid: process.pid,
      platform: process.platform,
      agent: "opencode",
      cwd: "/repo/x",
      jobId: "job_ab12cd34",
      model: "opencode-go/deepseek-v4.1-flash",
      started: new Date(Date.now() - 65_000).toISOString(),
    }),
  );
  const rows = readInflight(dir);
  assert.equal(rows[0].jobId, "job_ab12cd34");
});

test("pickLatestBench keeps the last full run over a newer smoke run", async () => {
  const { pickLatestBench } = await import("../hubctl.mjs");
  const baseline = { tasks: 14, attempts: 15, passed: 15 };
  const candidates = [
    { stamp: "2026-11-04T10-23", tasks: 1, attempts: 1, passed: 1, model: "beam-free" },
    { stamp: "2026-11-04T00-58", tasks: 14, attempts: 14, passed: 14, model: "deepseek" },
    { stamp: "2026-11-04T00-18", tasks: 14, attempts: 14, passed: 14, model: "beam-free" },
  ];
  assert.equal(pickLatestBench(candidates, baseline).stamp, "2026-11-04T00-58");
  // Only partials: report the newest one rather than nothing.
  assert.equal(pickLatestBench(candidates.slice(0, 1), baseline).stamp, "2026-11-04T10-23");
  // Dry runs are never a result.
  assert.equal(pickLatestBench([{ dryRun: true, attempts: 0 }], baseline), null);
  assert.equal(pickLatestBench([], baseline), null);
});
