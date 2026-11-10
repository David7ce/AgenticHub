/**
 * `hubctl status` — one-shot health snapshot.
 *
 * Reads consent, the loopback probes, git worktrees, the bench baseline and the
 * newest audit lines; renders one compact screen or the same object as JSON.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { basename, join } from "node:path";
import { defaultSettingsPath, evaluatePosture } from "../../tools/egress-posture.mjs";
import { readTaskCounts, renderQueueLine } from "../tasks.mjs";
import {
  CONSENT_PATH,
  HUB,
  INFLIGHT_DIR,
  LOG_PATH,
  MAX_RUNS,
  ROOT,
  TASKS_DB,
  bold,
  dim,
  green,
  probe,
  readJson,
  red,
  summarizeConsent,
  useColor,
  yellow,
} from "../common.mjs";

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
  const git = spawnSync("git", ["-C", ROOT, "worktree", "list", "--porcelain"], {
    encoding: "utf8",
    windowsHide: true,
  });
  const worktrees = countWorktrees(git.status === 0 ? git.stdout : "");

  const settings = readJson(defaultSettingsPath()) ?? {};
  const policy = readJson(join(HUB, "tools", "egress-policy.json"));
  const egress = evaluatePosture({ settings, policy });

  const runs = parseRuns(existsSync(LOG_PATH) ? readFileSync(LOG_PATH, "utf8") : "");
  const isWsl = process.platform === "linux" && existsSync("/mnt/c/Windows");
  const queue = readTaskCounts(TASKS_DB);

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
    agents: consent,
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
    queue,
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

  const queueText = renderQueueLine(status.queue);

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
    `${pad("worktrees")}${worktrees}`,
    ...(queueText ? [`${pad("queue")}${paintFn.dim(queueText)}`] : []),
    `${pad("bench")}${bench}`,
    `${pad("egress")}${egress}`,
    `${pad("running")}${running}`,
    `${pad("last")}${runs}`,
  ];
  return lines.join("\n");
}

export async function runStatus(argv) {
  const status = await gatherStatus();
  if (argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
  } else {
    process.stdout.write(`${renderStatus(status, { color: useColor && !argv.includes("--no-color") })}\n`);
  }
}
