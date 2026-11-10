// hub-process.mjs — how the MCP server runs the hub's own scripts: paths, timeouts,
// spawning with captured streams, tree-kill, and the hub-acp argument list.

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const HERE = dirname(fileURLToPath(import.meta.url));
export const ACP_DIR = resolve(HERE, '..', 'acp');
export const HUB_ACP = join(ACP_DIR, 'hub-acp.mjs');
export const FANOUT_ACP = join(ACP_DIR, 'fanout-acp.mjs');
// Local registry first; a fresh clone runs with the shipped example.
export const DEFAULT_REGISTRY = existsSync(join(ACP_DIR, 'agents.json'))
  ? join(ACP_DIR, 'agents.json')
  : join(ACP_DIR, 'agents.example.json');

export const REGISTRY = process.env.AGENT_HUB_REGISTRY
  ? resolve(process.env.AGENT_HUB_REGISTRY)
  : DEFAULT_REGISTRY;

// A callee may take minutes; MCP clients have their own patience. This is the
// hard stop for the child process, deliberately later than hub-acp's own
// --timeout so hub-acp gets to write its audit line and exit cleanly.
export const KILL_GRACE_MS = 60_000;
export const DEFAULT_TURN_TIMEOUT_MS = 180_000;
// hub-acp's own CLI default (0.5, acp/hub-acp.mjs) is sized for an ad hoc
// terminal question, not repo-sized work: three real one-commit dispatches
// on 2026-11-04 (Godot physics, a Kotlin figure + tests, a lighting bugfix)
// cost $0.51-$1.48 each, so a caller who never passes --budget would trip
// the cap on most real tasks. This is the MCP layer's own default -- it
// always passes --budget explicitly, so the silent 0.5 is never inherited.
export const DEFAULT_BUDGET_USD = 3;

export function log(line) {
  process.stderr.write(`[hub-mcp] ${line}\n`);
}

// Spawn one of the hub's own scripts and collect its streams. Detached from
// any single tool call, so a background job and a foreground turn share it.
export function spawnHub(script, args, { input = '', env } = {}) {
  const child = spawn(process.execPath, [script, ...args], {
    cwd: process.cwd(),
    env: env ? { ...process.env, ...env } : process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });

  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });

  const exit = new Promise((resolvePromise, reject) => {
    child.on('error', (err) => reject(new Error(`cannot start ${script}: ${err.message}`)));
    child.on('close', (code) => resolvePromise({ code, stdout, stderr }));
  });

  if (input) child.stdin.end(input, 'utf8');
  else child.stdin.end();

  return { child, exit };
}

// Same tree-kill reasoning as acp-client: a wrapper (cmd.exe, wsl.exe) dying
// first leaves the agent editing behind a "finished" job.
export function killTree(child) {
  if (!child || child.killed || child.pid == null) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    return;
  }
  try {
    child.kill('SIGTERM');
  } catch {}
}

export function parseHubJson(exit, label) {
  const { code, stdout, stderr } = exit;
  const text = stdout.trim();
  if (!text) throw new Error(stderr.trim() || `${label} exited ${code} with no output`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label} did not return JSON: ${text.slice(0, 300)}`);
  }
}

// Run one of the hub's own scripts to completion and capture its --json output.
export function runHubScript(script, args, { input = '', timeoutMs = DEFAULT_TURN_TIMEOUT_MS } = {}) {
  const { child, exit } = spawnHub(script, args, { input });
  let killedForTime = false;
  const timer = setTimeout(() => {
    killedForTime = true;
    killTree(child);
  }, timeoutMs + KILL_GRACE_MS);

  return exit.then(
    (result) => {
      clearTimeout(timer);
      if (killedForTime) {
        throw new Error(`hub script exceeded ${timeoutMs + KILL_GRACE_MS}ms and was killed`);
      }
      return parseHubJson(result, script);
    },
    (err) => {
      clearTimeout(timer);
      throw err;
    },
  );
}

export function registryArgs() {
  return REGISTRY === DEFAULT_REGISTRY ? [] : ['--registry', REGISTRY];
}

// The registry's default model per agent, for the `agents` tool. hub-acp's
// --list already resolves platform overrides; this only reads the model ids.
export function defaultModels() {
  try {
    const raw = JSON.parse(readFileSync(REGISTRY, 'utf8'));
    return Object.fromEntries(
      Object.entries(raw.agents ?? {}).map(([name, entry]) => [
        name,
        entry.defaultConfig?.model ?? null,
      ]),
    );
  } catch {
    return {};
  }
}

export function resolveCwd(requested) {
  const cwd = requested ? resolve(requested) : process.cwd();
  if (!isAbsolute(cwd)) throw new Error(`cwd is not absolute: ${cwd}`);
  if (!existsSync(cwd)) throw new Error(`cwd does not exist: ${cwd}`);
  return cwd;
}

// ── handlers ────────────────────────────────────────────────────────────────

export function hubArgsFor({ agent, cwd, permission, timeoutMs, model, budgetUsd, effort, save = false }) {
  const resolvedCwd = cwd ? resolveCwd(cwd) : process.cwd();
  const args = [
    '--agent',
    agent,
    '--prompt',
    '-',
    '--json',
    // A foreground answer comes back through MCP, so a per-call file under
    // results/ would only be noise (hub-acp saves by default). A job is
    // different: if this server dies before the job ends, that file is the only
    // copy of the answer, so the flag is simply left off.
    ...(save ? [] : ['--no-save']),
    '--permission',
    permission ?? 'deny',
    '--timeout',
    String(timeoutMs ?? DEFAULT_TURN_TIMEOUT_MS),
    // Always explicit: hub-acp's own CLI default (0.5) is for an ad hoc
    // question, not a dispatch through MCP -- see DEFAULT_BUDGET_USD.
    '--budget',
    String(budgetUsd ?? DEFAULT_BUDGET_USD),
    ...registryArgs(),
  ];
  if (model) args.push('--model', model);
  if (effort) args.push('--effort', effort);
  if (cwd) args.push('--cwd', resolvedCwd);
  return { args, cwd: resolvedCwd };
}
