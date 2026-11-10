/**
 * `hubctl verify [dir] [--cmd "COMMAND"] [--timeout MS] [--json]`
 *
 * Runs the repository's own tests and returns the real exit code. This exists
 * because Codex (sandbox "unelevated") can write code but gets `spawn EPERM`
 * when it tries to launch a test process: its work has to be judged outside.
 *
 * Detection is deliberately small and explicit; `--cmd` always wins. The tail
 * of the output is printed so a failure is visible without opening a log, and
 * the command never prints environment values.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { HUB, TASKS_DB, stamp } from "../common.mjs";
import { attachEvidence, getTask, openTaskDb } from "../tasks.mjs";

export const TAIL_LINES = 20;
export const DEFAULT_TIMEOUT_MS = 600_000;

/** Pick a test command from the names present at the repo root. Pure. */
export function detectVerifyCommand({ names = [], readJson = () => null } = {}) {
  const has = (name) => names.includes(name);
  if (has("package.json")) {
    const pkg = readJson("package.json");
    if (pkg?.scripts?.test) return { command: "npm test", why: "package.json scripts.test" };
  }
  if (has("pyproject.toml") || has("pytest.ini") || has("tox.ini")) {
    return { command: "python -m pytest -q", why: "pytest configuration" };
  }
  if (names.some((name) => name.endsWith(".sln")) || names.some((name) => name.endsWith(".csproj"))) {
    return { command: "dotnet test", why: ".NET solution/project" };
  }
  if (has("Cargo.toml")) return { command: "cargo test", why: "Cargo.toml" };
  if (has("go.mod")) return { command: "go test ./...", why: "go.mod" };
  return null;
}

export function tailLines(text, count = TAIL_LINES) {
  return String(text ?? "").replace(/\r\n/g, "\n").trimEnd().split("\n").slice(-count).join("\n");
}

/** Strict CLI parsing: a typo must fail before a directory gets tested. */
export function parseVerifyArgs(argv, { cwd = process.cwd() } = {}) {
  let asJson = false;
  let command = null;
  let timeout = DEFAULT_TIMEOUT_MS;
  let dir = null;
  let task = null;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") {
      asJson = true;
    } else if (arg === "--cmd") {
      command = argv[++i];
      if (!command) throw new Error("--cmd needs a command");
    } else if (arg === "--timeout") {
      const value = Number(argv[++i]);
      if (!Number.isFinite(value) || value <= 0) throw new Error("--timeout needs a positive number of milliseconds");
      timeout = value;
    } else if (arg === "--task") {
      task = argv[++i];
      if (!task) throw new Error("--task needs a task id");
    } else if (arg.startsWith("--")) {
      throw new Error(`unknown option: ${arg}`);
    } else if (dir) {
      throw new Error(`unexpected argument: ${arg}`);
    } else {
      dir = arg;
    }
  }
  return { asJson, command, timeout, dir: resolve(dir ?? cwd), task };
}

function detect(dir) {
  const names = readdirSync(dir);
  return detectVerifyCommand({
    names,
    readJson: (name) => {
      try { return JSON.parse(readFileSync(join(dir, name), "utf8")); } catch { return null; }
    },
  });
}

function writeEvidence(taskId, report) {
  const file = join(HUB, "results", "verify", `${taskId}-${stamp()}.log`);
  mkdirSync(dirname(file), { recursive: true });
  const text = [
    `verify ${report.dir}`,
    `cmd ${report.command} (${report.why})`,
    `result ${report.timedOut ? "timeout" : report.ok ? "PASS" : `FAIL ${report.status}`} in ${(report.durationMs / 1000).toFixed(1)}s`,
    "",
    report.tail,
    "",
  ].join("\n");
  writeFileSync(file, text, "utf8");
  return file;
}

export async function runVerify(argv) {
  const { asJson, command: explicit, timeout, dir, task: taskId } = parseVerifyArgs(argv);
  if (!existsSync(dir)) throw new Error(`no such directory: ${dir}`);

  const detected = explicit ? { command: explicit, why: "--cmd" } : detect(dir);
  if (!detected) {
    throw new Error(
      "no test command found (looked for package.json scripts.test, pytest, .NET, Cargo.toml, go.mod); pass --cmd \"...\"",
    );
  }

  const started = Date.now();
  const result = spawnSync(detected.command, {
    cwd: dir,
    shell: true,
    encoding: "utf8",
    timeout,
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
    env: process.env,
  });
  const durationMs = Date.now() - started;
  const ok = result.status === 0;
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  const report = {
    dir,
    command: detected.command,
    why: detected.why,
    ok,
    status: result.status,
    signal: result.signal ?? null,
    timedOut: result.error?.code === "ETIMEDOUT",
    durationMs,
    tail: tailLines(output),
  };

  // Evidence is attached to the task, but the state stays as it is: a green
  // test run is proof the diff works, not a review that accepted it.
  if (taskId) {
    report.task = { id: taskId, evidence: null, attached: false, note: null };
    if (!existsSync(TASKS_DB)) {
      report.task.note = "no task database yet";
    } else {
      const db = openTaskDb(TASKS_DB);
      try {
        if (!getTask(db, taskId)) report.task.note = "unknown task";
        else {
          report.task.evidence = writeEvidence(taskId, report);
          report.task.attached = attachEvidence(db, taskId, report.task.evidence);
        }
      } finally {
        db.close();
      }
    }
  }

  if (asJson) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(`verify · ${dir}\n`);
    process.stdout.write(`cmd    ${detected.command}  (${detected.why})\n`);
    const verdict = report.timedOut ? `TIMEOUT after ${timeout} ms` : ok ? "PASS" : `FAIL (exit ${result.status})`;
    process.stdout.write(`result ${verdict} in ${(durationMs / 1000).toFixed(1)}s\n`);
    if (report.tail) process.stdout.write(`\n${report.tail}\n`);
    if (report.task) {
      const where = report.task.evidence ?? `not attached (${report.task.note})`;
      process.stdout.write(`task   ${taskId} · evidence ${where}\n`);
    }
  }
  process.exitCode = ok && !report.timedOut ? 0 : 1;
}
