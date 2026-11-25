/**
 * `hubctl tasks` — the thin work queue.
 *
 * One SQLite file, one worktree per task, every run through hub-acp so
 * consent, write scope, budget and the audit line stay in one place.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import {
  createWorktree,
  removeWorktree,
  repoInfo,
  worktreeHasChanges,
  worktreePath,
} from "../../acp/worktree.mjs";
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
} from "../tasks.mjs";
import { HUB_ACP, ROOT, STATE_DIR, TASKS_DB, stamp } from "../common.mjs";

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

  const evidenceDir = join(STATE_DIR, "logs", "tasks");
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

export function runTasks(argv) {
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
