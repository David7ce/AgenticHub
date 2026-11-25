#!/usr/bin/env node
// router.mjs — pick a worker agent for a task, then hand off to hub-acp.mjs.
//
//   node router.mjs --prompt "..."
//   node router.mjs --prompt - < task.txt
//   node router.mjs --prompt "..." --explain      # print the pick, don't run it
//   node router.mjs --prompt "..." --force claude # skip the heuristic
//
// Every other hub-acp.mjs flag (--cwd, --mcp, --permission, --budget,
// --timeout, --config, --json, --no-save, --verbose) passes through
// unchanged -- this file's only job is choosing --agent, not re-doing
// what hub-acp.mjs already does for one agent run.
//
// Two workers are routing targets: opencode (cheap, fast) and claude
// (expensive, strongest reasoning). Hermes is registered (2026-11-11) but has no
// enabled model in models.json, so it is never a routing target; Codex is blocked
// by its ACP adapter. The hub itself orchestrates
// -- no registered agent decomposes tasks.
//
// Why a rule list and not a model call to classify the task: a classifier
// call would add cost and latency to every single routed prompt, including
// the cheap ones -- the opposite of what routing is for here. Verified
// cost/speed this fleet actually produced (docs/reference/acp.md "Verified" table,
// 2026-10-26/27): opencode ~$0.0006-0.0008 and ~5s; claude ~$0.23 and
// ~12-13s -- roughly 300-400x the cost for a model call that's slower too.
// Default cheap, escalate on explicit signal, never guess with another
// paid call.
//
// Health/cost awareness (2026-10-29) reads the last 24 h of this fleet's
// own audit log, logs/runs.jsonl, on top of the prompt rule list:
//   - the preferred agent having recent failures/timeouts (15 min) moves
//     the pick to the other one, if that one is healthy;
//   - a prompt that would escalate to claude does not, once claude's 24 h
//     spend has passed --cost-ceiling (default $2). --force claude still
//     overrides this.
// Live concurrency ("is the agent busy right now") is not observable from
// the log -- a run only gets a record when it finishes -- so this is
// health/cost-aware, not true load-aware.


import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { buildHandoffPrompt } from './handoff.mjs';
import {
  CHEAP_AGENT,
  DEFAULT_COST_CEILING,
  DEFAULT_LOG,
  DEFAULT_REGISTRY,
  HUB,
  STRONG_AGENT,
} from './router-config.mjs';
import { readRunStats, describeStats } from './router-stats.mjs';
import { decideAgent, decideRoute, readCatalog } from './router-decide.mjs';
import {
  agentChain,
  describeAttempts,
  isQuotaError,
  modelChain,
  otherAgent,
  readAgentEntry,
  shouldTryNextModel,
} from './router-failover.mjs';

// The pieces live in router-*.mjs; everything stays importable from here.
export { DEFAULT_REGISTRY, readRunStats, describeStats, decideAgent, decideRoute, readCatalog };
export { agentChain, describeAttempts, isQuotaError, modelChain, otherAgent, readAgentEntry, shouldTryNextModel };

function usageAndExit(code) {
  process.stderr.write(
    `usage: node router.mjs --prompt TEXT|- [--force opencode|claude] [--explain] [--json] [--review]\n` +
      `       [--cost-ceiling USD (default ${DEFAULT_COST_CEILING}, 0 disables)] [--daily-ceiling USD (default 3)]\n` +
      `       [--no-health]\n` +
      `       [--no-failover] [--no-context] [--log FILE] [hub-acp.mjs options...]\n`,
  );
  process.exit(code);
}

// Same approach hub-acp.mjs uses for `--prompt -`: a synchronous read of
// fd 0. Read here (not left as '-' for hub-acp.mjs to read itself)
// because the classifier needs the real text before it can decide --
// the resolved string is what gets passed through, stdin is consumed
// exactly once.
function readPrompt(promptArg) {
  if (promptArg !== '-') return promptArg;
  return readFileSync(0, 'utf8');
}

function main() {
  const argv = process.argv.slice(2);
  let promptArg = null;
  let force = null;
  let explain = false;
  let jsonOut = false;
  let review = false;
  let dailyCeiling = 3;
  let health = true;
  let failover = true;
  let withContext = true;
  let costCeiling = DEFAULT_COST_CEILING;
  let logPath = DEFAULT_LOG;
  let registryPath = DEFAULT_REGISTRY;
  const passthrough = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--prompt') {
      promptArg = argv[++i];
    } else if (arg === '--force') {
      force = argv[++i];
    } else if (arg === '--explain') {
      explain = true;
    } else if (arg === '--json') {
      jsonOut = true;
    } else if (arg === '--review') {
      review = true;
    } else if (arg === '--daily-ceiling') {
      dailyCeiling = Number(argv[++i]);
      if (!Number.isFinite(dailyCeiling) || dailyCeiling < 0) {
        process.stderr.write('--daily-ceiling must be zero or a positive number\n');
        process.exit(1);
      }
    } else if (arg === '--no-failover') {
      failover = false;
    } else if (arg === '--no-context') {
      withContext = false;
    } else if (arg === '--no-health') {
      health = false;
    } else if (arg === '--cost-ceiling') {
      costCeiling = Number(argv[++i]);
      if (!Number.isFinite(costCeiling) || costCeiling < 0) {
        process.stderr.write('--cost-ceiling must be zero or a positive number\n');
        process.exit(1);
      }
    } else if (arg === '--registry') {
      registryPath = argv[++i];
      if (!registryPath) usageAndExit(1);
      passthrough.push('--registry', registryPath);
    } else if (arg === '--log') {
      logPath = argv[++i];
    } else if (arg === '--help' || arg === '-h') {
      usageAndExit(0);
    } else {
      passthrough.push(arg);
    }
  }

  if (promptArg === null) usageAndExit(1);
  if (force && force !== CHEAP_AGENT && force !== STRONG_AGENT) {
    process.stderr.write(`--force must be ${CHEAP_AGENT} or ${STRONG_AGENT}\n`);
    process.exit(1);
  }

  const prompt = readPrompt(promptArg);
  const stats = health ? readRunStats(logPath) : null;
  const decision = decideRoute(prompt, {
    stats, costCeiling, dailyCeiling, health, force, review, registryPath,
  });

  if (explain) {
    if (jsonOut) {
      process.stdout.write(`${JSON.stringify({ ...decision, stats }, null, 2)}\n`);
    } else {
      process.stdout.write(
        `${decision.agent}  model=${decision.model ?? '?'}  topology=${decision.topology}  (${decision.reason})\n`,
      );
      if (decision.fallbacks.length) process.stdout.write(`fallbacks: ${decision.fallbacks.join(', ')}\n`);
      if (stats) process.stdout.write(`stats: ${describeStats(stats)}\n`);
    }
    return;
  }

  process.stderr.write(`[router] -> ${decision.agent}: ${decision.reason}\n`);

  // When another agent takes over after a quota failure, it gets more than the
  // bare prompt: the tree's git state, recent runs and the original task.
  const cwdIndex = passthrough.indexOf('--cwd');
  const workTree = cwdIndex === -1 ? null : passthrough[cwdIndex + 1];
  const promptFor = (agent) => {
    if (!withContext || !workTree || agent === decision.agent) return prompt;
    let logText = '';
    try { logText = readFileSync(logPath, 'utf8'); } catch { /* no log yet */ }
    return buildHandoffPrompt({ cwd: workTree, target: agent, from: decision.agent, task: prompt, logText });
  };

  const run = (agent, model) => {
    const extra = model ? ['--model', model] : [];
    const result = spawnSync(
      process.execPath,
      [HUB, '--agent', agent, '--prompt', promptFor(agent), ...passthrough, ...extra],
      {
        // stdout is captured rather than inherited: with --json the quota
        // error lives inside the JSON, and the router has to read it to know
        // the next model is worth trying. The kept attempt is re-emitted, so
        // the caller still sees exactly one answer.
        stdio: ['inherit', 'pipe', 'pipe'],
        windowsHide: true,
        maxBuffer: 64 * 1024 * 1024,
      },
    );
    const stdout = result.stdout ? result.stdout.toString() : '';
    const stderr = result.stderr ? result.stderr.toString() : '';
    if (stderr) process.stderr.write(stderr);
    return { status: result.status ?? 1, stdout, stderr };
  };

  // Both streams: the quota message is on stderr for a human run and inside
  // the JSON on stdout for --json.
  const failureText = (result) => `${result.stderr}\n${result.stdout}`;
  const emit = (result) => {
    if (result.stdout) process.stdout.write(result.stdout);
  };

  // Free pool first, then the paid Go models in price order -- unless the
  // caller named a model, which is a decision and is never substituted.
  const explicitModel =
    passthrough.includes('--model') ||
    passthrough.some((arg) => arg.startsWith('model=')) ||
    passthrough.some((arg, i) => arg === '--config' && String(passthrough[i + 1]).startsWith('model='));
  const chain = explicitModel
    ? [null]
    : modelChain(readAgentEntry(registryPath, decision.agent));

  const tryAgent = (agent, models) => {
    const attempts = models.length ? models : [null];
    let last = { status: 1, stdout: '', stderr: '' };
    for (const [index, model] of attempts.entries()) {
      last = run(agent, model);
      if (last.status === 0) return last;
      if (!failover || !isQuotaError(failureText(last))) return last;
      const next = attempts[index + 1];
      if (!next) return last;
      process.stderr.write(`[router] ${model} is out of quota; retrying on ${next}\n`);
    }
    return last;
  };

  let outcome = tryAgent(decision.agent, chain);
  if (outcome.status !== 0 && failover && isQuotaError(failureText(outcome))) {
    let from = decision.agent;
    for (const fallback of agentChain(readAgentEntry(registryPath, decision.agent), decision.agent)) {
      process.stderr.write(`[router] ${from} is out of quota; retrying on ${fallback}
`);
      // That agent has its own model chain; a model id from the first one
      // would be meaningless here.
      const fallbackChain = explicitModel ? [null] : modelChain(readAgentEntry(registryPath, fallback));
      outcome = tryAgent(fallback, fallbackChain);
      if (outcome.status === 0 || !isQuotaError(failureText(outcome))) break;
      from = fallback;
    }
  }
  emit(outcome);
  process.exit(outcome.status);
}

// Importable for tests without executing the CLI.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();

