// hub-process.mjs — how the MCP server runs the hub's own scripts: paths, timeouts,
// spawning with captured streams, tree-kill, and the hub-acp argument list.

import { spawn } from 'node:child_process';
import { killTree } from '../acp/process-utils.mjs';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HUB_CONFIG } from '../acp/config.mjs';

export const HERE = dirname(fileURLToPath(import.meta.url));
export const ACP_DIR = resolve(HERE, '..', 'acp');
export const HUB_ACP = join(ACP_DIR, 'hub-acp.mjs');
export const FANOUT_ACP = join(ACP_DIR, 'fanout-acp.mjs');
export const DEFAULT_REGISTRY = HUB_CONFIG.defaultRegistryPath;
export const REGISTRY = HUB_CONFIG.registryPath;

// A callee may take minutes; MCP clients have their own patience. This is the
// hard stop for the child process, deliberately later than hub-acp's own
// --timeout so hub-acp gets to write its audit line and exit cleanly.
export const KILL_GRACE_MS = 60_000;
export const DEFAULT_TURN_TIMEOUT_MS = 180_000;
// After asking a run to stop: how long it gets to cancel its agent, wait for
// proof (HUB_CANCEL_WAIT_MS, 8 s by default) and write its audit line before
// the process tree is killed.
export const STOP_GRACE_MS = 15_000;
// hub-acp's own CLI default (0.5, acp/hub-acp.mjs) is sized for an ad hoc
// terminal question, not repo-sized work: three real one-commit dispatches
// on 2026-11-04 (Godot physics, a Kotlin figure + tests, a lighting bugfix)
// cost $0.51-$1.48 each, so a caller who never passes --budget would trip
// the cap on most real tasks. This is the MCP layer's own default -- it
// always passes --budget explicitly, so the silent 0.5 is never inherited.
export const DEFAULT_BUDGET_USD = 3;
// Independent caps prevent either child stream from growing without bound.
export const MAX_CAPTURE_BYTES = 8 * 1024 * 1024;

// Every script started by this MCP process, including detached job controllers.
const hubProcesses = new Map();
const stopping = new WeakSet();

export function log(line) {
  process.stderr.write(`[hub-mcp] ${line}\n`);
}

// Spawn one of the hub's own scripts and collect its streams. Detached from
// any single tool call, so a background job and a foreground turn share it.
export function spawnHub(script, args, { input = '', env, maxOutputBytes = MAX_CAPTURE_BYTES } = {}) {
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes <= 0) throw new Error('maxOutputBytes must be a positive safe integer');
  const child = spawn(process.execPath, [script, ...args], {
    cwd: process.cwd(),
    env: env ? { ...process.env, ...env } : process.env,
    // The fourth channel carries one message, `cancel` (see requestStop).
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    windowsHide: true,
  });

  const streams = {
    stdout: { buffer: Buffer.alloc(0), bytes: 0 },
    stderr: { buffer: Buffer.alloc(0), bytes: 0 },
  };
  let outputLimitExceeded = null;
  const capture = (name, chunk) => {
    const stream = streams[name];
    const remaining = maxOutputBytes - stream.bytes;
    const kept = Math.min(remaining, chunk.length);
    if (kept > 0) {
      const needed = stream.bytes + kept;
      if (needed > stream.buffer.length) {
        // Grow geometrically up to the cap, rather than retaining an object
        // for every small chunk or allocating the full cap for quiet jobs.
        const capacity = Math.min(maxOutputBytes, Math.max(4096, needed, stream.buffer.length * 2));
        const buffer = Buffer.alloc(capacity);
        stream.buffer.copy(buffer, 0, 0, stream.bytes);
        stream.buffer = buffer;
      }
      chunk.copy(stream.buffer, stream.bytes, 0, kept);
      stream.bytes += kept;
    }
    if (chunk.length > remaining && !outputLimitExceeded) {
      outputLimitExceeded = { stream: name, limitBytes: maxOutputBytes };
      requestStop(child);
    }
    // Continue draining after overflow while cancellation/audit completes.
  };
  child.stdout.on('data', (chunk) => capture('stdout', chunk));
  child.stderr.on('data', (chunk) => capture('stderr', chunk));

  const exit = new Promise((resolvePromise, reject) => {
    child.on('error', (err) => reject(new Error(`cannot start ${script}: ${err.message}`)));
    child.on('close', (code) => {
      // Decode once so UTF-8 characters split across chunks remain intact.
      const stdout = streams.stdout.buffer.subarray(0, streams.stdout.bytes).toString('utf8');
      const stderr = streams.stderr.buffer.subarray(0, streams.stderr.bytes).toString('utf8');
      streams.stdout.buffer = Buffer.alloc(0);
      streams.stderr.buffer = Buffer.alloc(0);
      resolvePromise({ code, stdout, stderr, outputLimitExceeded });
    });
  });

  // A cancelled/failed callee may close stdin before consuming the prompt.
  child.stdin.on('error', () => {});
  hubProcesses.set(child, exit);
  child.once('close', () => hubProcesses.delete(child));
  if (input) child.stdin.end(input, 'utf8');
  else child.stdin.end();

  return { child, exit };
}


// Ask a running hub script to stop, and only kill it if it does not. Asked,
// hub-acp tells its agent to cancel, waits for proof and writes the audit line
// with status "cancelled"; killed, the run leaves no line at all and the agent
// may live on. The kill is the backstop, not the method.
export function requestStop(child, { graceMs = STOP_GRACE_MS } = {}) {
  if (!child || child.exitCode !== null || child.signalCode !== null || stopping.has(child)) return;
  stopping.add(child);
  let asked = false;
  try {
    if (child.connected) {
      child.send({ type: 'cancel' }, (error) => { if (error) killTree(child); });
      asked = true;
    }
  } catch {}
  if (!asked) {
    killTree(child);
    return;
  }
  const timer = setTimeout(() => killTree(child), graceMs);
  timer.unref?.();
  child.once('close', () => clearTimeout(timer));
}

// On MCP EOF, request cancellation for all owned scripts and let them write
// their audit records before the server exits. The wait is bounded even when
// a process ignores both IPC and the normal process-tree kill backstop.
export async function stopHubProcesses({ graceMs = STOP_GRACE_MS } = {}) {
  const owned = [...hubProcesses];
  if (!owned.length) return { pending: 0 };
  for (const [child] of owned) requestStop(child, { graceMs });
  let timer;
  try {
    await Promise.race([
      Promise.allSettled(owned.map(([, exit]) => exit)),
      new Promise((resolve) => { timer = setTimeout(resolve, graceMs + 1000); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
  return { pending: owned.filter(([child]) => hubProcesses.has(child)).length };
}

export function parseHubJson(exit, label) {
  const { code, stdout, stderr, outputLimitExceeded } = exit;
  if (outputLimitExceeded) {
    throw new Error(`${label}: ${outputLimitExceeded.stream} exceeded the ${outputLimitExceeded.limitBytes}-byte capture limit; cancellation requested and output truncated`);
  }
  const text = stdout.trim();
  if (!text) throw new Error(stderr.trim() || `${label} exited ${code} with no output`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label} did not return JSON: ${text.slice(0, 300)}`);
  }
}

// Run one of the hub's own scripts to completion and capture its --json output.
// `signal` (an AbortSignal) stops the run when the caller gives up on it.
export function runHubScript(script, args, { input = '', timeoutMs = DEFAULT_TURN_TIMEOUT_MS, signal, maxOutputBytes = MAX_CAPTURE_BYTES } = {}) {
  if (signal?.aborted) return Promise.resolve({ ok: false, status: 'cancelled', error: 'stopped by the caller before it started' });
  const { child, exit } = spawnHub(script, args, { input, maxOutputBytes });
  const onAbort = () => requestStop(child);
  signal?.addEventListener('abort', onAbort, { once: true });
  child.once('close', () => signal?.removeEventListener('abort', onAbort));
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

export function hubArgsFor({ agent, cwd, permission, timeoutMs, model, mode, budgetUsd, effort, sessionId, label, save = false }) {
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
  if (mode) args.push('--config', `mode=${mode}`);
  if (effort) args.push('--effort', effort);
  if (sessionId) args.push('--continue', sessionId);
  if (label) args.push('--label', label);
  if (cwd) args.push('--cwd', resolvedCwd);
  return { args, cwd: resolvedCwd };
}
