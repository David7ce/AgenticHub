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
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { defaultSettingsPath, evaluatePosture } from "../tools/egress-posture.mjs";
import {
  buildLiveModel,
  readLocks,
  renderLive,
  scanExternalProcesses,
  snapshotTrees,
  watchTrees,
} from "./live.mjs";
import { collectReport, renderReport } from "./report.mjs";
import {
  defaultDbPath,
  forwardSpendArgs,
  mergeSpend,
  readClaudeSpend,
  readOpenCodeSpend,
  readOpenCodeSpendViaWsl,
  renderSpend,
  toCsv,
} from "./spend.mjs";
import { compareCodexCatalog, gatherDoctor, latestCodexModels, renderDoctor } from "./doctor.mjs";
import {
  addTask,
  claimNext,
  costAmount,
  finishTask,
  getTask,
  listTasks,
  openTaskDb,
  renderTask,
  renderTasks,
  retryTask,
  setTaskWorktree,
} from "./tasks.mjs";
import { homedir } from "node:os";
import { describe as describePath, toWsl } from "../acp/paths.mjs";
import {
  createWorktree,
  removeWorktree,
  repoInfo,
  worktreeHasChanges,
  worktreePath,
} from "../acp/fanout-acp.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const HUB = resolve(HERE, "..");
const ROOT = resolve(HUB, "..");
const LOG_PATH = process.env.AGENT_HUB_LOG
  ? resolve(process.env.AGENT_HUB_LOG)
  : join(ROOT, "logs", "runs.jsonl");
const CONSENT_PATH = join(HUB, "consent.json");
const TASKS_DB = process.env.AGENT_HUB_TASKS_DB
  ? resolve(process.env.AGENT_HUB_TASKS_DB)
  : join(ROOT, "logs", "hub.db");
const BRIDGE_URL = process.env.AGENT_HUB_BRIDGE_URL ?? "http://127.0.0.1:3010";
const MEMORY_URL = process.env.CLAUDE_MEM_URL ?? "http://127.0.0.1:37777";
const STARNET_URL = process.env.STARNET_URL ?? "http://127.0.0.1:8787";
const INFLIGHT_DIR = process.env.AGENT_HUB_INFLIGHT
  ? resolve(process.env.AGENT_HUB_INFLIGHT)
  : join(HUB, "results", "inflight");
const LOCKS_DIR = process.env.AGENT_HUB_LOCKS
  ? resolve(process.env.AGENT_HUB_LOCKS)
  : join(HUB, "results", "locks");
const MAX_RUNS = 5;

// OpenCode Go is flat-rate: its own stats report cost 0 for `opencode-go/*`
// models, so the only local way to see how much of the monthly allowance is
// spent is to price the tokens against the published table. Prices are per 1M
// tokens, off-peak for DeepSeek, and the limit is that model's monthly
// allowance on the Go plan. Update from https://opencode.ai/docs/go/.
const GO_PRICES = {
  "deepseek-v4.1-flash": { input: 0.15, output: 0.6, cache: 0.003, limit: 100 },
  "mimo-v2.6-flash": { input: 0.14, output: 0.28, cache: 0.0028, limit: 60 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cache: 0.01, limit: 15 },
  "gpt-6-luna": { input: 0.1, output: 0.5, cache: 0.01, limit: 15 },
  "gemini-4-argon": { input: 2.0, output: 10.0, cache: 0.1, limit: 30 },
  "iceman-contributor-free": { input: 0, output: 0, cache: 0, limit: null },
};

// Models whose terms allow training on request data. They appear in the usage
// table so a session that used one is visible, not silently accepted.
const TRAINS_ON_DATA = new Set(["muse-spark-1.2-contributor", "muse-spark-1.3-contributor", "iceman-contributor-free"]);

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code, text) => (useColor ? `\x1b[${code}m${text}\x1b[0m` : text);
const green = (text) => paint("32", text);
const yellow = (text) => paint("33", text);
const red = (text) => paint("31", text);
const dim = (text) => paint("2", text);
const bold = (text) => paint("1", text);

function readJson(path) {
  if (!path || !existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

async function probe(url, path = "/health", timeoutMs = 800) {
  try {
    const response = await fetch(`${url}${path}`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) return { up: false };
    return { up: true, body: await response.json() };
  } catch {
    return { up: false };
  }
}

export function summarizeConsent(consent, now = Date.now()) {
  if (!consent) return [];
  return Object.entries(consent)
    .filter(([key]) => !key.startsWith("_"))
    .map(([name, grant]) => {
      const expires = grant?.expires ? Date.parse(grant.expires) : null;
      const daysLeft = expires ? Math.ceil((expires - now) / 86_400_000) : null;
      let status = "ok";
      if (grant?.enabled !== true) status = "disabled";
      else if (grant?.overseerAck !== true) status = "unacked";
      else if (expires && expires <= now) status = "expired";
      return { name, status, daysLeft };
    });
}

export function parseRuns(text, limit = MAX_RUNS) {
  const rows = [];
  for (const line of String(text ?? "").split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      rows.push({
        time: entry.time ?? entry.ts ?? null,
        agent: entry.agent ?? (entry.mode === "fanout" ? "fanout" : "?"),
        status: entry.status ?? "?",
        durationMs: entry.durationMs ?? null,
        model: entry.model ?? null,
        sessionId: entry.sessionId ?? null,
      });
    } catch {
      // A truncated line at the tail is normal for an append-only log.
    }
  }
  return rows.slice(-limit).reverse();
}

export function countWorktrees(porcelain) {
  const entries = [];
  let current = null;
  for (const line of String(porcelain ?? "").split("\n")) {
    if (line.startsWith("worktree ")) {
      if (current) entries.push(current);
      current = { path: line.slice("worktree ".length) };
    } else if (current && line.startsWith("branch ")) {
      current.branch = line.slice("branch ".length);
    } else if (current && line === "detached") {
      current.branch = "(detached)";
    }
  }
  if (current) entries.push(current);
  const agentCheckouts = entries.filter((entry) =>
    entry.path.replace(/\\/g, "/").includes("/agent-worktrees/"),
  );
  return { total: entries.length, agentCheckouts };
}

/**
 * The bench run `status` should report: the newest one that covers the whole
 * task set, because a one-task smoke run proves nothing about the fleet and
 * would otherwise erase the last real result from the screen. A dry run is not
 * an attempt at all.
 */
export function pickLatestBench(candidates, baseline) {
  const usable = (candidates ?? []).filter((row) => row && row.dryRun !== true);
  if (!usable.length) return null;
  const wanted = baseline?.tasks ?? null;
  if (wanted) {
    const full = usable.find((row) => (row.tasks ?? 0) >= wanted);
    if (full) return full;
  }
  return usable[0];
}

export async function gatherStatus() {
  const consent = summarizeConsent(readJson(CONSENT_PATH));
  const bridge = await probe(BRIDGE_URL, "/health");
  const memory = await probe(MEMORY_URL, "/api/health");
  const starnet = await probe(STARNET_URL, "/api/health");
  const git = spawnSync("git", ["-C", ROOT, "worktree", "list", "--porcelain"], {
    encoding: "utf8",
    windowsHide: true,
  });
  const worktrees = countWorktrees(git.status === 0 ? git.stdout : "");

  const bridgeConfig = readJson(join(HUB, "bridge", "config.json")) ??
    readJson(join(HUB, "bridge", "config.example.json"));
  const settings = readJson(defaultSettingsPath()) ?? {};
  const policy = readJson(join(HUB, "tools", "egress-policy.json"));
  const egress = evaluatePosture({ settings, bridge: bridgeConfig, policy });

  const runs = parseRuns(existsSync(LOG_PATH) ? readFileSync(LOG_PATH, "utf8") : "");
  const isWsl = process.platform === "linux" && existsSync("/mnt/c/Windows");

  // The bench baseline is versioned; the latest run is not. Comparing them is
  // the only way `status` can say "the agents still do what they did".
  const baseline = readJson(join(HUB, "bench", "baseline.json"));
  const benchDir = join(HUB, "results", "bench");
  let latest = null;
  if (existsSync(benchDir)) {
    const summaries = readdirSync(benchDir)
      .filter((name) => name.endsWith("-summary.json"))
      .sort()
      .reverse();
    latest = pickLatestBench(
      summaries.map((name) => readJson(join(benchDir, name))).filter(Boolean),
      baseline,
    );
  }

  return {
    now: new Date().toISOString(),
    hint:
      isWsl && !bridge.up && !memory.up
        ? "run hubctl on Windows: WSL cannot reach Windows loopback services"
        : null,
    agents: consent,
    bridge: {
      up: bridge.up,
      port: new URL(BRIDGE_URL).port,
      models: bridge.body?.models ?? null,
      modelIds: bridgeConfig?.agents?.models?.map((model) => model.id) ?? [],
    },
    memory: {
      up: memory.up,
      port: new URL(MEMORY_URL).port,
      provider: memory.body?.ai?.provider ?? null,
      quota7d: memory.body?.rateLimits?.seven_day?.utilization ?? null,
    },
    starnet: {
      up: starnet.up,
      port: new URL(STARNET_URL).port,
    },
    worktrees,
    bench: {
      baseline: baseline?.passed ?? null,
      attempts: baseline?.attempts ?? null,
      tasks: baseline?.tasks ?? null,
      latest: latest
        ? {
            passed: latest.passed ?? null,
            attempts: latest.attempts ?? null,
            tasks: latest.tasks ?? null,
            stamp: latest.stamp ?? null,
            model: latest.model ?? null,
          }
        : null,
      baselineModel: baseline?.model ?? null,
    },
    egress: {
      ok: egress.ok,
      warnings: egress.checks.filter((check) => check.level === "warn").map((check) => check.id),
    },
    inflight: readInflight(),
    runs,
  };
}

function pad(label) {
  return label.padEnd(10);
}

// hub-acp writes one of these per running turn (results/inflight/<pid>.json).
// logs/runs.jsonl only gets a line when the turn ends, so this is the only way
// `status` can answer "what is running right now".
export function readInflight(dir = INFLIGHT_DIR) {
  if (!existsSync(dir)) return [];
  const rows = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    const record = readJson(join(dir, name));
    if (!record || typeof record !== "object") continue;
    const startedMs = Date.parse(record.started);
    const ageMs = Number.isFinite(startedMs) ? Date.now() - startedMs : null;
    // Only the same platform can answer "is this pid still alive"; from WSL a
    // Windows pid means nothing. Unknown is reported as null, not as dead.
    let alive = null;
    if (record.platform === process.platform && Number.isInteger(record.pid)) {
      try {
        process.kill(record.pid, 0);
        alive = true;
      } catch (err) {
        alive = err.code === "EPERM";
      }
    }
    const updatedMs = Date.parse(record.updated);
    const silentMs = Number.isFinite(updatedMs) ? Date.now() - updatedMs : null;
    const stallMs = Number(process.env.AGENT_HUB_STALL_MS) || 15 * 60 * 1000;
    // A tool still marked running is allowed to be quiet: builds and renders
    // do not emit session updates while they work.
    const runningTool = /\(running\)$/.test(String(record.lastTool ?? ""));
    const stalled = silentMs != null && silentMs > stallMs && !runningTool;
    rows.push({ ...record, ageMs, silentMs, stalled, alive });
  }
  // Newest first, like runs: the one that just started is the interesting one.
  return rows.sort((a, b) => (a.ageMs ?? 0) - (b.ageMs ?? 0));
}

function ageText(ms) {
  if (ms == null) return "?";
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  return `${(ms / 3_600_000).toFixed(1)}h`;
}

export function renderStatus(status, { color = true } = {}) {
  const paintFn = color ? { green, yellow, red, dim, bold } : {
    green: (t) => t,
    yellow: (t) => t,
    red: (t) => t,
    dim: (t) => t,
    bold: (t) => t,
  };

  const agents = status.agents.length
    ? status.agents
        .map((agent) => {
          if (agent.status !== "ok") return paintFn.red(`${agent.name} ${agent.status}`);
          const days = agent.daysLeft == null ? "" : ` (${agent.daysLeft}d)`;
          return paintFn.green(`${agent.name} ok`) + paintFn.dim(days);
        })
        .join("  ")
    : paintFn.dim("none");

  const bridgeIds = status.bridge.modelIds?.length
    ? status.bridge.modelIds.join(", ")
    : `${status.bridge.models ?? "?"} model(s)`;
  // Dormant by default: the bridge only matters when VS Code Chat is the
  // surface, so a stopped one is not a problem worth a red line every day.
  const bridgeLine = status.bridge.up
    ? paintFn.green(`${status.bridge.port} up`) + paintFn.dim(` · ${bridgeIds}`)
    : null;

  const quota = status.memory.quota7d;
  const quotaText = quota == null ? "" : ` · 7d ${Math.round(quota * 100)}%`;
  const memory = status.memory.up
    ? paintFn.green(`${status.memory.port} up`) +
      paintFn.dim(` · ${status.memory.provider ?? "?"}`) +
      (quota != null && quota >= 0.9 ? paintFn.yellow(quotaText) : paintFn.dim(quotaText))
    : paintFn.yellow(`${status.memory.port} stopped`);

  const starnetLine = status.starnet.up
    ? paintFn.green(`${status.starnet.port} up`)
    : paintFn.dim(`${status.starnet.port} down`);

  // A run on a different model is not a regression against the baseline, so it
  // says which model it was instead of just a number.
  const shortModel = (id) => String(id).split("/").pop();
  const bench =
    status.bench.baseline == null
      ? paintFn.dim("no baseline")
      : paintFn.dim(`${status.bench.baseline}/${status.bench.attempts} baseline`) +
        (status.bench.latest
          ? status.bench.latest.model &&
            status.bench.baselineModel &&
            status.bench.latest.model !== status.bench.baselineModel
            ? paintFn.dim(
                ` · last ${status.bench.latest.passed}/${status.bench.latest.attempts}` +
                  ` on ${shortModel(status.bench.latest.model)}`,
              )
            : (status.bench.latest.tasks ?? status.bench.latest.attempts) === (status.bench.tasks ?? status.bench.attempts)
              ? status.bench.latest.passed === status.bench.latest.attempts
                ? paintFn.green(" · last ok")
                : paintFn.yellow(` · last ${status.bench.latest.passed}/${status.bench.latest.attempts}`)
              : paintFn.dim(` · last ${status.bench.latest.passed}/${status.bench.latest.attempts} (subset)`)
          : paintFn.dim(" · not run"));

  const worktrees =
    paintFn.dim(`${status.worktrees.total} total · `) +
    (status.worktrees.agentCheckouts.length
      ? paintFn.yellow(`${status.worktrees.agentCheckouts.length} agent`)
      : paintFn.green("0 agent"));

  const egress = status.egress.ok
    ? paintFn.green("ok")
    : paintFn.yellow(`${status.egress.warnings.length} warning(s)`);

  const runs = status.runs.length
    ? status.runs
        .slice(0, 3)
        .map((run) => {
          const seconds = run.durationMs == null ? "?" : (run.durationMs / 1000).toFixed(1);
          const label = `${run.agent} ${run.status} ${seconds}s`;
          return run.status === "ok" ? paintFn.green(label) : paintFn.yellow(label);
        })
        .join(paintFn.dim(" · "))
    : paintFn.dim("none");

  // "Running" is the line that was missing on 2026-11-03: three pending calls,
  // nothing in the log, and no way to see them from anywhere.
  const running = status.inflight?.length
    ? status.inflight
        .map((row) => {
          const where = row.cwd ? basename(row.cwd) : "?";
          // The model matters now that a call can move from a free pool to a
          // paid one mid-flight; show the short name, not the whole id.
          const model = row.model ? ` · ${String(row.model).split("/").pop()}` : "";
          const job = row.jobId ? ` · ${row.jobId}` : "";
          const silent = row.silentMs == null ? "" : ` · ${ageText(row.silentMs)} silent`;
          const head = `${row.agent} in ${where} (${ageText(row.ageMs)})${silent}${model}${job}`;
          const label =
            row.stalled || row.alive === false
              ? paintFn.yellow(`${head}${row.stalled ? " stalled?" : " stale?"}`)
              : paintFn.green(head);
          const last = row.lastTool
            ? ` · ${String(row.lastTool).replace(/\s+/g, " ").slice(0, 80)}`
            : "";
          return label + paintFn.dim(last);
        })
        .join(paintFn.dim(" · "))
    : paintFn.dim("none");

  const lines = [
    `${paintFn.bold("AGENTHUB")} ${paintFn.dim(status.now.replace("T", " ").slice(0, 16))}` +
      paintFn.dim("                    local · loopback"),
    "",
    `${pad("agents")}${agents}`,
    ...(bridgeLine ? [`${pad("bridge")}${bridgeLine}`] : []),
    `${pad("memory")}${memory}`,
    `${pad("starnet")}${starnetLine}`,
    `${pad("worktrees")}${worktrees}`,
    `${pad("bench")}${bench}`,
    `${pad("egress")}${egress}`,
    `${pad("running")}${running}`,
    `${pad("last")}${runs}`,
  ];
  if (status.hint) lines.push("", paintFn.dim(status.hint));
  return lines.join("\n");
}

async function liveFrame({ trees, external, status }) {
  const locks = readLocks(LOCKS_DIR);
  const cwds = [
    ...status.inflight.map((row) => row.cwd),
    ...locks.map((lock) => lock.cwd),
  ].filter(Boolean);
  // Start watchers for trees that appeared since the last frame.
  for (const cwd of cwds) {
    if (!trees.has(cwd)) {
      const opened = watchTrees([cwd]);
      for (const [path, state] of opened) trees.set(path, state);
    }
  }
  return buildLiveModel({
    status,
    locks,
    external: external ?? [],
    trees: snapshotTrees(trees),
  });
}

async function runLive(argv) {
  const json = argv.includes("--json");
  const once = argv.includes("--once") || json;
  const noExternal = argv.includes("--no-external");
  const index = argv.indexOf("--interval");
  const interval = index === -1 ? 1500 : Math.max(250, Number(argv[index + 1]) || 1500);

  const trees = new Map();
  let external = [];
  let externalAt = 0;
  const refreshExternal = async () => {
    if (noExternal) return;
    if (Date.now() - externalAt < 5_000) return;
    externalAt = Date.now();
    external = await scanExternalProcesses();
  };

  if (once) {
    await refreshExternal();
    const status = await gatherStatus();
    const model = await liveFrame({ trees, external, status });
    if (json) process.stdout.write(`${JSON.stringify(model, null, 2)}\n`);
    else process.stdout.write(`${renderLive(model, { color: Boolean(useColor) && !argv.includes("--no-color") })}\n`);
    for (const tree of trees.values()) tree.watcher?.close?.();
    return;
  }

  if (!process.stdout.isTTY) {
    process.stderr.write("live needs a TTY; use `live --once` for one-shot output\n");
    process.exitCode = 1;
    return;
  }

  const { createInterface } = await import("node:readline");
  const rl = createInterface({ input: process.stdin });
  const stdin = process.stdin;
  stdin.setRawMode?.(true);
  stdin.resume();
  stdin.setEncoding("utf8");

  let paused = false;
  let stopped = false;
  const announcedStalls = new Set();

  const draw = async () => {
    await refreshExternal();
    const status = await gatherStatus();
    const model = await liveFrame({ trees, external, status });
    process.stdout.write("\x1b[?25l\x1b[H\x1b[2J");
    process.stdout.write(`${renderLive(model, { color: Boolean(useColor) })}\n`);
    // One bell per run that becomes stalled: visible without a desktop toast,
    // and silent for runs already announced.
    for (const row of model.inflight) {
      if (row.stalled && row.pid && !announcedStalls.has(row.pid)) {
        announcedStalls.add(row.pid);
        process.stdout.write("\x07");
      }
    }
    process.stdout.write(`\n${dim("[q]uit  [r]efresh  [p]" + (paused ? " resume" : "ause"))}  ${dim(
      paused ? "paused" : `every ${interval}ms`,
    )}\n`);
  };

  const stop = () => {
    stopped = true;
    stdin.setRawMode?.(false);
    for (const tree of trees.values()) tree.watcher?.close?.();
    rl.close();
    process.stdout.write("\x1b[?25h\n");
    process.exit(0);
  };

  stdin.on("data", (key) => {
    if (key === "q" || key === "\u0003") stop();
    else if (key === "r") void draw();
    else if (key === "p") { paused = !paused; void draw(); }
  });

  await draw();
  const timer = setInterval(() => { if (!stopped && !paused) void draw(); }, interval);
  timer.unref?.();
}

async function runReport(argv) {
  const json = argv.includes("--json");
  const index = argv.indexOf("--days");
  const days = index === -1 ? 7 : Math.max(1, Number(argv[index + 1]) || 7);
  const text = existsSync(LOG_PATH) ? readFileSync(LOG_PATH, "utf8") : "";
  const report = collectReport(text, { days });
  if (json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(`${renderReport(report, {
      color: Boolean(useColor) && !argv.includes("--no-color"),
    })}\n`);
  }
}

function defaultCodexCache() {
  if (process.env.CODEX_MODELS_CACHE) return process.env.CODEX_MODELS_CACHE;
  const local = join(homedir(), ".codex", "models_cache.json");
  if (existsSync(local)) return local;
  if (process.platform !== "win32") {
    const win = join("/mnt/c/Users", process.env.USER || process.env.USERNAME || "user", ".codex", "models_cache.json");
    if (existsSync(win)) return win;
  }
  return local;
}
const CODEX_CACHE = defaultCodexCache();

// Informational only: the newest model per Codex family that the local Codex
// knows about, and whether models.json lists it. It never edits the file.
async function runModels(argv) {
  if (!argv.includes("--codex")) {
    process.stderr.write("usage: hubctl models --codex [--json]\n");
    process.exitCode = 1;
    return;
  }
  const cache = readJson(CODEX_CACHE);
  if (!cache) {
    process.stdout.write(`no Codex models cache at ${CODEX_CACHE}\n`);
    return;
  }
  const rows = compareCodexCatalog(readJson(join(HUB, "models.json")), latestCodexModels(cache));
  if (argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify({ fetchedAt: cache.fetched_at ?? null, families: rows }, null, 2)}\n`);
    return;
  }
  const lines = [`codex models · cache ${cache.fetched_at ?? "?"}`, ""];
  for (const r of rows) {
    lines.push(`${r.family.padEnd(6)} ${r.latest.padEnd(16)} ${r.inCatalog ? "in models.json" : yellow("missing from models.json")}`);
  }
  process.stdout.write(`${lines.join("\n")}\n`);
}

async function runDoctor(argv) {
  const report = gatherDoctor({
    root: ROOT,
    hub: HUB,
    readJson,
    inflight: readInflight(),
    locks: readLocks(LOCKS_DIR),
    fast: argv.includes("--fast"),
    codexCache: readJson(CODEX_CACHE),
  });
  if (argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}
`);
  } else {
    const color = useColor && !argv.includes("--no-color");
    process.stdout.write(`${renderDoctor(report, { paint: color ? (code, text) => `[${code}m${text}[0m` : undefined })}
`);
  }
  if (!report.ok) process.exitCode = 1;
}

async function runSpend(argv) {
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
          hubctlWslPath: toWsl(fileURLToPath(import.meta.url)),
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
  const result = mergeSpend(opencode, claude);
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

async function runStatus(argv) {
  const status = await gatherStatus();
  if (argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
  } else {
    process.stdout.write(`${renderStatus(status, { color: useColor && !argv.includes("--no-color") })}\n`);
  }
}

const HUB_ACP = join(HUB, "acp", "hub-acp.mjs");
function stamp(date = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-` +
    `${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`
  );
}

export function buildHubArgs({
  agent,
  prompt = "-",
  cwd = null,
  permission = "deny",
  budget = 0.5,
  timeout = 300_000,
  resume = null,
  json = false,
  model = null,
}) {
  const args = [
    HUB_ACP,
    "--agent", agent,
    "--prompt", prompt,
    "--permission", permission,
    "--budget", String(budget),
    "--timeout", String(timeout),
  ];
  if (cwd) args.push("--cwd", cwd);
  if (resume) args.push("--resume", resume);
  if (model) args.push("--model", model);
  if (json) args.push("--json");
  return args;
}

/** Find the agent that owns a session id (full or unique prefix). */
export function inferSessionAgent(runs, session) {
  const hit = runs.find(
    (run) => run.sessionId && (run.sessionId === session || run.sessionId.startsWith(session)),
  );
  return hit ? { agent: hit.agent, sessionId: hit.sessionId } : null;
}

function parseFlags(argv) {
  const opts = { permission: "deny", budget: 0.5, timeout: 300_000, json: false, worktree: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`${arg} needs a value`);
      return argv[++i];
    };
    switch (arg) {
      case "--worktree": opts.worktree = true; break;
      case "--prompt": opts.prompt = next(); break;
      case "--cwd": opts.cwd = next(); break;
      case "--agent": opts.agent = next(); break;
      case "--model": opts.model = next(); break;
      case "--permission": opts.permission = next(); break;
      case "--budget": opts.budget = Number(next()); break;
      case "--timeout": opts.timeout = Number(next()); break;
      case "--json": opts.json = true; break;
      case "-h": case "--help": opts.help = true; break;
      default: throw new Error(`unknown option: ${arg}`);
    }
  }
  return opts;
}

function readPrompt(opts) {
  if (opts.prompt === "-") return readFileSync(0, "utf8");
  if (opts.prompt != null) return opts.prompt;
  if (!process.stdin.isTTY) return readFileSync(0, "utf8");
  throw new Error("no prompt: use --prompt TEXT, --prompt -, or pipe stdin");
}

function requireConsent(agent) {
  const consent = readJson(CONSENT_PATH);
  if (!consent) return;
  const entry = summarizeConsent(consent).find((row) => row.name === agent);
  if (!entry) throw new Error(`no consent entry for ${agent}`);
  if (entry.status !== "ok") throw new Error(`consent ${entry.status} for ${agent}`);
}

function spawnHub(args, prompt) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, args, {
      stdio: ["pipe", "inherit", "inherit"],
      windowsHide: true,
    });
    child.on("error", (error) => {
      process.stderr.write(`hubctl: ${error.message}\n`);
      resolvePromise(1);
    });
    child.on("close", (code) => resolvePromise(code ?? 1));
    child.stdin.on("error", () => {});
    child.stdin.end(prompt);
  });
}

async function runAgent(argv) {
  const agent = argv[1];
  if (!agent || agent.startsWith("-")) {
    throw new Error("usage: hubctl run <agent> [--worktree] [--prompt TEXT|-]");
  }
  const opts = parseFlags(argv.slice(2));
  if (opts.help) {
    process.stdout.write("usage: hubctl run <agent> [--worktree] [--prompt TEXT|-] [--cwd DIR] [--permission deny|allow-reads|allow-all]\n");
    return;
  }
  requireConsent(agent);
  const prompt = readPrompt(opts);
  if (!prompt.trim()) throw new Error("prompt is empty");

  let tree = null;
  if (opts.worktree) {
    const base = resolve(opts.cwd ?? process.cwd());
    const info = repoInfo(base);
    if (!info) throw new Error(`--worktree needs a git repository; ${base} is not inside one`);
    tree = { root: info.root, path: worktreePath(info.commonDir, stamp(), agent) };
    createWorktree(info.root, tree.path);
  }

  try {
    const args = buildHubArgs({
      agent,
      prompt: "-",
      cwd: tree?.path ?? opts.cwd ?? null,
      permission: opts.permission,
      budget: opts.budget,
      timeout: opts.timeout,
      json: opts.json,
      model: opts.model ?? null,
    });
    process.exitCode = await spawnHub(args, prompt);
  } finally {
    if (tree) {
      if (worktreeHasChanges(tree.path)) {
        process.stderr.write(`[hubctl] worktree kept (has changes): ${tree.path}\n`);
      } else {
        removeWorktree(tree.root, tree.path);
      }
    }
  }
}

// --- tasks ------------------------------------------------------------------
// The thin queue: what is queued, who owns it, what counts as done. It never
// launches anything itself; every run goes through hub-acp.mjs, so consent,
// write scope, budget and the audit line stay in one place.

const TASK_USAGE = `usage: hubctl tasks <command>

  add --repo DIR --agent NAME (--prompt TEXT | --prompt-file F | --prompt -)
      [--title T] [--acceptance A] [--budget USD] [--model ID] [--parent ID]
  list [--state STATE] [--limit N] [--json]
  show <id> [--json]
  run [--once] [--parallel N] [--permission allow-all|allow-reads|deny]
      [--timeout MS] [--budget USD] [--dry-run]
  done <id> --evidence TEXT|PATH
  block <id> --reason TEXT
  cancel <id>
  retry <id>
`;

function openTasks() {
  mkdirSync(dirname(TASKS_DB), { recursive: true });
  return openTaskDb(TASKS_DB);
}

function taskFlag(argv, name, fallback = null) {
  const index = argv.indexOf(name);
  if (index < 0) return fallback;
  const value = argv[index + 1];
  if (value == null) throw new Error(`${name} needs a value`);
  return value;
}

function taskPrompt(argv) {
  const inline = taskFlag(argv, "--prompt");
  const file = taskFlag(argv, "--prompt-file");
  if (inline != null) return inline;
  if (file != null) return readFileSync(resolve(file), "utf8");
  if (!process.stdin.isTTY) return readFileSync(0, "utf8");
  throw new Error("no prompt: use --prompt, --prompt-file, or pipe stdin");
}

function captureChild(execPath, args, input) {
  return new Promise((resolvePromise) => {
    const child = spawn(execPath, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => resolvePromise({ code: 1, stdout, stderr: `${stderr}${error.message}` }));
    child.on("close", (code) => resolvePromise({ code: code ?? 1, stdout, stderr }));
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

function parseHubResult(stdout) {
  const start = stdout.indexOf("{");
  if (start < 0) return null;
  try { return JSON.parse(stdout.slice(start)); } catch { return null; }
}

async function runOneTask(db, task, opts) {
  const info = repoInfo(task.repo);
  if (!info) throw new Error(`not a git repository: ${task.repo}`);
  const tree = worktreePath(info.commonDir, stamp(), task.agent);
  createWorktree(info.root, tree);
  setTaskWorktree(db, task.id, tree);

  const args = [
    HUB_ACP,
    "--agent", task.agent,
    "--prompt", "-",
    "--cwd", tree,
    "--permission", opts.permission,
    "--budget", String(task.budget ?? opts.budget),
    "--timeout", String(opts.timeout),
    "--json",
    "--task-id", task.id,
  ];
  if (task.model) args.push("--model", task.model);

  const started = Date.now();
  const { code, stdout, stderr } = await captureChild(process.execPath, args, task.prompt);
  const result = parseHubResult(stdout);
  const ok = code === 0 && result?.ok === true;
  const cost = costAmount(result?.cost);

  const evidenceDir = join(ROOT, "logs", "tasks");
  mkdirSync(evidenceDir, { recursive: true });
  const evidence = join(evidenceDir, `${task.id}.json`);
  writeFileSync(
    evidence,
    JSON.stringify({ task: task.id, code, ok, result, stderr: stderr.slice(-4000) }, null, 2),
  );

  const changed = worktreeHasChanges(tree);
  if (!changed) removeWorktree(info.root, tree);

  const finished = finishTask(db, task.id, {
    state: ok ? "review" : "blocked",
    evidence,
    result: result?.text ?? null,
    exitCode: code,
    cost,
    error: ok ? null : (result?.error ?? stderr.trim().slice(-500) ?? `exit ${code}`),
    worktree: changed ? tree : null,
  });
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  const costLabel = finished.cost == null ? "-" : `$${Number(finished.cost).toFixed(3)}`;
  process.stdout.write(
    `${finished.id}  ${finished.state.padEnd(8)} ${finished.agent.padEnd(9)} ${seconds}s ${costLabel}` +
    `${changed ? `  worktree ${tree}` : ""}\n`,
  );
  return finished;
}

async function runTaskQueue(argv) {
  const opts = {
    once: argv.includes("--once"),
    parallel: Number(taskFlag(argv, "--parallel", 1)),
    permission: taskFlag(argv, "--permission", "allow-all"),
    timeout: Number(taskFlag(argv, "--timeout", 600_000)),
    budget: Number(taskFlag(argv, "--budget", 0.5)),
    dryRun: argv.includes("--dry-run"),
  };
  if (!Number.isInteger(opts.parallel) || opts.parallel < 1) throw new Error("--parallel must be >= 1");

  const db = openTasks();
  if (opts.dryRun) {
    const next = listTasks(db, { state: "queued", limit: 1 })[0];
    if (!next) return process.stdout.write("no queued tasks\n");
    process.stdout.write(`${renderTask(next)}\n  repo ${next.repo}\n  agent ${next.agent}\n  worktree under .git/agent-worktrees\n`);
    return;
  }

  const worker = async () => {
    for (;;) {
      const task = claimNext(db);
      if (!task) return;
      try {
        await runOneTask(db, task, opts);
      } catch (error) {
        finishTask(db, task.id, { state: "blocked", error: error.message });
        process.stderr.write(`${task.id}  blocked  ${error.message}\n`);
      }
      if (opts.once) return;
    }
  };
  await Promise.all(Array.from({ length: opts.parallel }, worker));
}

function runTasks(argv) {
  const sub = argv[1] ?? "list";
  if (sub === "-h" || sub === "--help" || sub === "help") {
    process.stdout.write(TASK_USAGE);
    return;
  }
  const rest = argv.slice(2);
  const db = openTasks();

  if (sub === "add") {
    const task = addTask(db, {
      repo: resolve(taskFlag(rest, "--repo", process.cwd())),
      agent: taskFlag(rest, "--agent"),
      prompt: taskPrompt(rest),
      title: taskFlag(rest, "--title"),
      acceptance: taskFlag(rest, "--acceptance"),
      budget: taskFlag(rest, "--budget") == null ? null : Number(taskFlag(rest, "--budget")),
      model: taskFlag(rest, "--model"),
      parent: taskFlag(rest, "--parent"),
    });
    process.stdout.write(`${renderTask(task)}\n`);
    return;
  }

  if (sub === "list") {
    const state = taskFlag(rest, "--state");
    const limit = Number(taskFlag(rest, "--limit", 100));
    const rows = listTasks(db, { state, limit });
    if (rest.includes("--json")) return process.stdout.write(JSON.stringify(rows, null, 2) + "\n");
    return process.stdout.write(renderTasks(rows));
  }

  if (sub === "show") {
    const id = rest.find((arg) => !arg.startsWith("--"));
    if (!id) throw new Error("usage: hubctl tasks show <id>");
    const task = getTask(db, id);
    if (!task) throw new Error(`no such task: ${id}`);
    return process.stdout.write(JSON.stringify(task, null, 2) + "\n");
  }

  if (sub === "run") return runTaskQueue(rest);

  if (sub === "done") {
    const id = rest.find((arg) => !arg.startsWith("--"));
    const evidence = taskFlag(rest, "--evidence");
    if (!id) throw new Error("usage: hubctl tasks done <id> --evidence TEXT|PATH");
    const task = finishTask(db, id, { state: "done", evidence });
    process.stdout.write(`${renderTask(task)}\n`);
    return;
  }

  if (sub === "block") {
    const id = rest.find((arg) => !arg.startsWith("--"));
    const reason = taskFlag(rest, "--reason");
    if (!id) throw new Error("usage: hubctl tasks block <id> --reason TEXT");
    const task = finishTask(db, id, { state: "blocked", error: reason });
    process.stdout.write(`${renderTask(task)}\n`);
    return;
  }

  if (sub === "cancel") {
    const id = rest.find((arg) => !arg.startsWith("--"));
    if (!id) throw new Error("usage: hubctl tasks cancel <id>");
    process.stdout.write(`${renderTask(finishTask(db, id, { state: "cancelled" }))}\n`);
    return;
  }

  if (sub === "retry") {
    const id = rest.find((arg) => !arg.startsWith("--"));
    if (!id) throw new Error("usage: hubctl tasks retry <id>");
    process.stdout.write(`${renderTask(retryTask(db, id))}\n`);
    return;
  }

  throw new Error(TASK_USAGE);
}

async function mem(argv) {
  const query = argv.slice(1).filter((arg) => !arg.startsWith("-")).join(" ").trim();
  if (!query) throw new Error("usage: hubctl mem <query>");

  // The installed launcher answers `status` but returns nothing for `search`
  // on this machine, while `npx claude-mem search` works. Use the known-good
  // path. On Windows, go through cmd.exe because Node cannot spawn a .cmd.
  const quoted = `"${query.replace(/"/g, '""')}"`;
  let result;
  if (process.platform === "win32") {
    const comspec = process.env.ComSpec || "cmd.exe";
    result = spawnSync(
      comspec,
      ["/d", "/s", "/c", `npx.cmd -y claude-mem@15.6.0 search ${quoted}`],
      { stdio: "inherit", windowsVerbatimArguments: true, windowsHide: true },
    );
  } else {
    result = spawnSync("npx", ["-y", "claude-mem@15.6.0", "search", query], {
      stdio: "inherit",
    });
  }
  process.exitCode = result.status ?? 1;
}

async function attach(argv) {
  const session = argv[1];
  if (!session || session.startsWith("-")) {
    throw new Error("usage: hubctl attach <session> [--agent NAME] [--prompt TEXT|-]");
  }
  const opts = parseFlags(argv.slice(2));
  if (opts.help) {
    process.stdout.write("usage: hubctl attach <session> [--agent NAME] [--prompt TEXT|-]\n");
    return;
  }
  const runs = parseRuns(existsSync(LOG_PATH) ? readFileSync(LOG_PATH, "utf8") : "", 500);
  const match = inferSessionAgent(runs, session);
  const agent = opts.agent ?? match?.agent;
  if (!agent) throw new Error("could not infer the agent for that session; pass --agent NAME");
  const sessionId = match?.sessionId ?? session;
  requireConsent(agent);
  const prompt = readPrompt(opts);
  if (!prompt.trim()) throw new Error("prompt is empty");
  const args = buildHubArgs({
    agent,
    prompt: "-",
    cwd: opts.cwd ?? null,
    permission: opts.permission,
    budget: opts.budget,
    timeout: opts.timeout,
    json: opts.json,
    resume: sessionId,
    model: opts.model ?? null,
  });
  process.exitCode = await spawnHub(args, prompt);
}

// The bench lives in bench/run.mjs; this only makes it reachable from the
// control room. stdio is inherited so per-task progress streams as it happens.
async function runBench(argv) {
  await new Promise((resolve) => {
    const child = spawn(process.execPath, [join(HUB, "bench", "run.mjs"), ...argv], {
      cwd: ROOT,
      stdio: "inherit",
    });
    child.on("close", (code) => {
      process.exitCode = code ?? 1;
      resolve();
    });
  });
}

// What each pool has actually used. No provider exposes "allowance left"
// locally, so this is assembled from what each tool does expose: OpenCode's
// own stats (tokens per model), the published Go prices, and claude-mem's
// 7-day rate-limit window for the Claude plan.
function opencodeStats(days) {
  const bin = process.env.OPENCODE_BIN || "opencode";
  const args = ["stats", "--days", String(days), "--cost", "--models", "--json"];
  const result =
    process.platform === "win32"
      ? spawnSync("wsl.exe", ["-e", bin, ...args], { encoding: "utf8", windowsHide: true })
      : spawnSync(bin, args, { encoding: "utf8" });
  if (result.status !== 0 || !result.stdout) return null;
  try {
    return JSON.parse(result.stdout);
  } catch {
    return null;
  }
}

export function estimateGo(entry) {
  const price = GO_PRICES[entry.model?.id];
  if (!price) return null;
  const tokens = entry.tokens ?? {};
  const million = 1_000_000;
  const cost =
    ((tokens.input ?? 0) / million) * price.input +
    ((tokens.output ?? 0) / million) * price.output +
    ((tokens.cache?.read ?? 0) / million) * price.cache;
  return { cost, limit: price.limit, pct: cost / price.limit };
}

export function humanTokens(n) {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}G`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}k`;
  return String(n);
}

async function runUsage(argv) {
  const daysArg = argv.find((arg) => arg.startsWith("--days"));
  const days = daysArg ? Number(daysArg.split("=")[1] ?? argv[argv.indexOf(daysArg) + 1]) : 30;
  const asJson = argv.includes("--json");

  const stats = opencodeStats(days);
  const memory = await probe(MEMORY_URL, "/api/health");
  const claudePct = memory.body?.rateLimits?.seven_day?.utilization ?? null;

  const models = [];
  for (const entry of stats?.models ?? []) {
    if (entry.model?.providerID !== "opencode-go") continue;
    const estimate = estimateGo(entry);
    models.push({
      model: entry.model.id,
      steps: entry.steps ?? 0,
      input: entry.tokens?.input ?? 0,
      output: entry.tokens?.output ?? 0,
      cacheRead: entry.tokens?.cache?.read ?? 0,
      ...(estimate ?? {}),
    });
  }
  models.sort((a, b) => (b.cost ?? 0) - (a.cost ?? 0));

  const payload = {
    days,
    opencode: stats ? { sessions: stats.sessions, models } : null,
    claude: { sevenDayUtilization: claudePct, source: memory.up ? "claude-mem" : null },
  };

  if (asJson) {
    process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
    return;
  }

  const lines = [`usage · last ${days} days`, ""];
  if (!stats) {
    lines.push("opencode   unavailable (is the binary reachable?)");
  } else if (!models.length) {
    lines.push("opencode   no opencode-go usage in this window");
  } else {
    lines.push(
      `${"model".padEnd(24)}${"steps".padEnd(8)}${"in/out/cache".padEnd(22)}${"est.".padEnd(9)}of allowance`,
    );
    for (const row of models) {
      const est = row.cost == null ? "—" : `$${row.cost.toFixed(2)}`;
      const pct =
        row.limit === null
          ? "free"
          : row.pct == null
            ? "no price entry"
            : `${(row.pct * 100).toFixed(1)}% of $${row.limit}`;
      const flag = TRAINS_ON_DATA.has(row.model) ? " · trains on data" : "";
      lines.push(
        `${row.model.padEnd(24)}${String(row.steps).padEnd(8)}` +
          `${`${humanTokens(row.input)}/${humanTokens(row.output)}/${humanTokens(row.cacheRead)}`.padEnd(22)}` +
          `${est.padEnd(9)}${pct}${flag}`,
      );
    }
  }
  lines.push(
    "",
    claudePct == null
      ? "claude     claude-mem down, no rate-limit window available"
      : `claude     ${Math.round(claudePct * 100)}% of the 7-day window (claude-mem)`,
    "",
    paint("2", "Go reports cost 0 for opencode-go models; the estimate prices the tokens at the published table."),
  );
  process.stdout.write(lines.join("\n") + "\n");
}

// A worktree kept after a fan-out is kept because it has changes: removing it
// is discarding work, so it takes --force. Clean ones are just leftovers.
export function planPrune(rows, { force = false } = {}) {
  const remove = [];
  const keep = [];
  for (const row of rows) {
    if (row.dirty && !force) keep.push(row);
    else remove.push(row);
  }
  return { remove, keep };
}

export function ageLabel(days) {
  if (days == null || !Number.isFinite(days)) return "?";
  if (days < 1) return `${Math.max(1, Math.round(days * 24))}h`;
  return `${Math.round(days)}d`;
}

async function runWorktree(argv) {
  const asJson = argv.includes("--json");
  const prune = argv.includes("--prune");
  const force = argv.includes("--force");

  const info = repoInfo(ROOT);
  if (!info) {
    process.stderr.write("hubctl worktree: this is not a git repository\n");
    process.exitCode = 1;
    return;
  }

  const listing = spawnSync("git", ["-C", ROOT, "worktree", "list", "--porcelain"], {
    encoding: "utf8",
    windowsHide: true,
  });
  const { agentCheckouts } = countWorktrees(listing.status === 0 ? listing.stdout : "");
  const rows = agentCheckouts.map((entry) => {
    let ageDays = null;
    try {
      ageDays = (Date.now() - statSync(entry.path).mtimeMs) / 86_400_000;
    } catch {
      ageDays = null;
    }
    return { path: entry.path, dirty: worktreeHasChanges(entry.path), ageDays };
  });

  if (prune) {
    const { remove, keep } = planPrune(rows, { force });
    const removed = [];
    const failed = [];
    for (const row of remove) {
      if (removeWorktree(info.root, row.path)) removed.push(row.path);
      else failed.push(row.path);
    }
    if (asJson) {
      process.stdout.write(JSON.stringify({ removed, kept: keep.map((r) => r.path), failed }, null, 2) + "\n");
      return;
    }
    process.stdout.write(`removed ${removed.length} worktree(s), kept ${keep.length}\n`);
    for (const path of keep) process.stdout.write(`  kept   ${path} (has changes)\n`);
    for (const path of failed) process.stdout.write(`  failed ${path}\n`);
    return;
  }

  if (asJson) {
    process.stdout.write(JSON.stringify({ worktrees: rows }, null, 2) + "\n");
    return;
  }
  if (!rows.length) {
    process.stdout.write("no agent worktrees\n");
    return;
  }
  process.stdout.write(`agent worktrees · ${rows.length}\n\n`);
  for (const row of rows) {
    process.stdout.write(
      `${(row.dirty ? "dirty" : "clean").padEnd(6)}${ageLabel(row.ageDays).padEnd(5)}${row.path}\n`,
    );
  }
  process.stdout.write("\n--prune removes the clean ones; --force also removes dirty ones.\n");
}

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
  if (command === "tasks") return runTasks(argv);
  if (command === "mem") return mem(argv);
  if (command === "attach") return attach(argv);
  if (command === "path") return runPath(argv.slice(1));
  if (command === "bench") return runBench(argv.slice(1));
  if (command === "usage") return runUsage(argv.slice(1));
  if (command === "worktree") return runWorktree(argv.slice(1));
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
        "  tasks add|list|show|run|done|block|cancel|retry   the thin work queue (hubctl tasks --help)",
        "  mem <query>                      search claude-mem",
        "  attach <session> [--agent NAME]  resume a session",
        "  path <path> [--json]             both spellings of one path (Windows/WSL)",
        "  bench [args...]                  run the benchmark (passes --dry-run, --reps, --model through)",
        "  usage [--days N] [--json]        estimated allowance spent, per Go model, plus the Claude window",
        "  worktree [--prune] [--force]     list agent worktrees; --prune removes the clean ones",
        "",
      ].join("\n"),
    );
    return;
  }
  process.stderr.write(`unknown command: ${command}\n`);
  process.exitCode = 1;
}

// Debugging aid for the one thing that is easy to get wrong: the same file
// has two names on this machine. Prints both instead of guessing.
function runPath(argv) {
  const input = argv.find((arg) => !arg.startsWith("--"));
  if (!input) {
    process.stderr.write("usage: hubctl path <path> [--json]\n");
    process.exitCode = 1;
    return;
  }
  let info;
  try {
    info = describePath(input);
  } catch (error) {
    process.stderr.write(`hubctl path: ${error.message}\n`);
    process.exitCode = 1;
    return;
  }
  if (argv.includes("--json")) {
    process.stdout.write(JSON.stringify(info, null, 2) + "\n");
    return;
  }
  process.stdout.write(
    [
      `${bold("input")}    ${info.input}`,
      `${bold("style")}    ${info.style}`,
      `${bold("wsl")}      ${info.wsl}`,
      `${bold("windows")}  ${info.windows}`,
      "",
    ].join("\n"),
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`hubctl: ${error.message}\n`);
    process.exitCode = 1;
  });
}
