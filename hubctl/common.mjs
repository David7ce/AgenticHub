/**
 * Shared state and helpers for the hubctl subcommands.
 *
 * Everything here is read-only or plumbing: paths derived from the checkout,
 * colour handling, consent parsing, and the flags a run passes to hub-acp.
 * The subcommands themselves live in `commands/`.
 */
import { existsSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const HUB = resolve(HERE, "..");
export const ROOT = resolve(HUB, "..");
export const HUBCTL_ENTRY = join(HERE, "hubctl.mjs");
export const LOG_PATH = process.env.AGENT_HUB_LOG
  ? resolve(process.env.AGENT_HUB_LOG)
  : join(ROOT, "logs", "runs.jsonl");
export const CONSENT_PATH = join(HUB, "consent.json");
export const TASKS_DB = process.env.AGENT_HUB_TASKS_DB
  ? resolve(process.env.AGENT_HUB_TASKS_DB)
  : join(ROOT, "logs", "hub.db");
export const INFLIGHT_DIR = process.env.AGENT_HUB_INFLIGHT
  ? resolve(process.env.AGENT_HUB_INFLIGHT)
  : join(HUB, "results", "inflight");
export const LOCKS_DIR = process.env.AGENT_HUB_LOCKS
  ? resolve(process.env.AGENT_HUB_LOCKS)
  : join(HUB, "results", "locks");
export const MAX_RUNS = 5;

export const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
export const paint = (code, text) => (useColor ? `\x1b[${code}m${text}\x1b[0m` : text);
export const green = (text) => paint("32", text);
export const yellow = (text) => paint("33", text);
export const red = (text) => paint("31", text);
export const dim = (text) => paint("2", text);
export const bold = (text) => paint("1", text);

export function readJson(path) {
  if (!path || !existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

export async function probe(url, path = "/health", timeoutMs = 800) {
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

export const HUB_ACP = join(HUB, "acp", "hub-acp.mjs");

export function stamp(date = new Date()) {
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

export function parseFlags(argv) {
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

export function readPrompt(opts) {
  if (opts.prompt === "-") return readFileSync(0, "utf8");
  if (opts.prompt != null) return opts.prompt;
  if (!process.stdin.isTTY) return readFileSync(0, "utf8");
  throw new Error("no prompt: use --prompt TEXT, --prompt -, or pipe stdin");
}

export function requireConsent(agent) {
  const consent = readJson(CONSENT_PATH);
  if (!consent) return;
  const entry = summarizeConsent(consent).find((row) => row.name === agent);
  if (!entry) throw new Error(`no consent entry for ${agent}`);
  if (entry.status !== "ok") throw new Error(`consent ${entry.status} for ${agent}`);
}

export function spawnHub(args, prompt) {
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
