/**
 * `hubctl live` — who is working now.
 *
 * Reads inflight records, tree locks, fs watchers and the host process table
 * (never `git status` in a loop) and redraws one frame, or prints one with
 * `--once` / `--json`.
 */
import {
  buildLiveModel,
  readLocks,
  renderLive,
  scanExternalProcesses,
  snapshotTrees,
  watchTrees,
} from "../live.mjs";
import { LOCKS_DIR, dim, useColor } from "../common.mjs";
import { gatherStatus } from "./status.mjs";

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

export async function runLive(argv) {
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
