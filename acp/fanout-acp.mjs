#!/usr/bin/env node
// fanout-acp.mjs — run one prompt through several ACP agents in parallel
// and merge the answers into one labeled result.
//
// ACP is strictly 1:1 (one Client session per Agent), so fan-out is not a
// protocol feature: this is the hub doing what the protocol deliberately
// leaves to it. Each agent runs through the already-verified
// hub-acp.mjs path in its own child process, which keeps consent, audit,
// per-agent result files, and failure isolation identical to a single run.
//
// Usage:
//   node fanout-acp.mjs --agents opencode,claude --prompt "..."
//   node fanout-acp.mjs --agents opencode,claude --config opencode:model=... --prompt -
//
// Exit: 0 if at least one agent answered, 2 if every agent timed out,
// 1 otherwise. Same statuses as hub-acp.mjs.


import { spawn } from 'node:child_process';
import { killTree } from './process-utils.mjs';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { rotateIfNeeded } from './log-rotation.mjs';


import { createWorktree, removeWorktree, repoInfo, worktreePath, worktreeHasChanges } from './worktree.mjs';
import { SYNTH_MAX_PROMPT_CHARS, baseResult, buildSynthesisPrompt, renderMarkdown } from './fanout-render.mjs';

// Kept importable from here: tests and older callers use these names.
export { safeAgentName, worktreePath, repoInfo, createWorktree, worktreeHasChanges, removeWorktree } from './worktree.mjs';
export { buildSynthesisPrompt, renderMarkdown } from './fanout-render.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const HUB = join(HERE, 'hub-acp.mjs');
const RESULTS_DIR = resolve(HERE, '..', 'results');
// Local registry first; a fresh clone runs with the shipped example.
const DEFAULT_REGISTRY = existsSync(join(HERE, 'agents.json'))
  ? join(HERE, 'agents.json')
  : join(HERE, 'agents.example.json');
const LOG_PATH = process.env.AGENT_HUB_LOG
  ? resolve(process.env.AGENT_HUB_LOG)
  : resolve(HERE, '..', '..', 'logs', 'runs.jsonl');
const MAX_PROMPT_CHARS = 4000;

const USAGE = `usage: node fanout-acp.mjs --agents NAME[,NAME...] (--prompt TEXT | --prompt -) [options]

  --agents LIST          comma-separated registry entries (required)
  --prompt TEXT|-        prompt text, or - to read it from stdin
  --cwd DIR              session working directory for every agent
  --mcp FILE             MCP servers passed to every agent
  --permission POLICY    deny (default) | allow-reads | allow-all
  --effort LEVEL         low | medium | high | max, passed to every agent (see hub-acp)
  --budget USD           per-agent cost cap (default 0.50)
  --timeout MS           per-agent prompt timeout (default 300000)
  --config ID=VALUE      session config for every agent
  --config NAME:ID=VALUE session config for one agent (repeatable)
  --synthesize AGENT     after the fan-out, have AGENT merge the answers
                        into one section (needs at least two successful
                        answers; adds one model call)
  --worktree             give every agent its own git worktree under
                        <git-dir>/agent-worktrees/, so parallel edits cannot
                        collide. A worktree is kept only if the agent left
                        changes; clean ones are removed. Starts from HEAD, so
                        uncommitted changes are not copied in.
  --registry FILE        alternate agents.json
  --json                 machine-readable aggregate on stdout
  --no-save              do not write per-agent or merged result files
  --verbose              forward each agent's stderr
`;

function parseArgs(argv) {
  const opts = {
    permission: 'deny',
    budget: 0.5,
    timeout: 300_000,
    save: true,
    json: false,
    verbose: false,
    configs: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) fail(`${arg} needs a value`);
      return argv[++i];
    };
    switch (arg) {
      case '--agents': opts.agents = next(); break;
      case '--prompt': opts.prompt = next(); break;
      case '--cwd': opts.cwd = next(); break;
      case '--mcp': opts.mcp = next(); break;
      case '--permission': opts.permission = next(); break;
      case '--effort': opts.effort = next(); break;
      case '--budget': opts.budget = Number(next()); break;
      case '--timeout': opts.timeout = Number(next()); break;
      case '--config': opts.configs.push(next()); break;
      case '--synthesize': opts.synthesize = next(); break;
      case '--worktree': opts.worktree = true; break;
      case '--registry': opts.registry = next(); break;
      case '--json': opts.json = true; break;
      case '--no-save': opts.save = false; break;
      case '--verbose': opts.verbose = true; break;
      case '-h': case '--help': opts.help = true; break;
      default: fail(`unknown option: ${arg}`);
    }
  }
  return opts;
}

function fail(message) {
  process.stderr.write(`[fanout] ${message}\n\n${USAGE}`);
  process.exit(1);
}

function nowIso() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function stamp(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-` +
    `${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`
  );
}

function loadRegistry(file) {
  if (!existsSync(file)) fail(`registry not found: ${file}`);
  let raw;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    fail(`registry is not valid JSON (${file}): ${err.message}`);
  }
  if (!raw?.agents) fail(`registry has no "agents" object: ${file}`);
  return raw;
}

function readPrompt(opts) {
  if (opts.prompt === '-') return readFileSync(0, 'utf8');
  if (opts.prompt !== undefined) return opts.prompt;
  if (!process.stdin.isTTY) return readFileSync(0, 'utf8');
  fail('no prompt given (use --prompt TEXT, --prompt -, or pipe into stdin)');
}

// "model=..." applies to all; "opencode:model=..." to one. Values keep any
// later '=' so model ids and URLs pass through untouched.
function splitConfig(change) {
  const eq = change.indexOf('=');
  if (eq < 1) fail(`--config expects ID=VALUE or NAME:ID=VALUE, got "${change}"`);
  const left = change.slice(0, eq);
  const value = change.slice(eq + 1);
  const colon = left.indexOf(':');
  if (colon === -1) return { agent: null, config: `${left}=${value}` };
  const agent = left.slice(0, colon);
  const id = left.slice(colon + 1);
  if (!agent || !id) fail(`--config expects NAME:ID=VALUE, got "${change}"`);
  return { agent, config: `${id}=${value}` };
}



function runOne({ agent, prompt, opts, configs, maxPromptChars, noSave = false, label = agent, cwd = null }) {
  return new Promise((resolvePromise) => {
    const args = [
      HUB,
      '--agent', agent,
      '--prompt', '-',
      '--json',
      '--permission', opts.permission,
      '--budget', String(opts.budget),
      '--timeout', String(opts.timeout),
    ];
    const sessionCwd = cwd ?? opts.cwd;
    if (sessionCwd) args.push('--cwd', sessionCwd);
    if (opts.mcp) args.push('--mcp', opts.mcp);
    if (opts.registry) args.push('--registry', opts.registry);
    if (opts.effort) args.push('--effort', opts.effort);
    for (const config of configs) args.push('--config', config);
    if (noSave || !opts.save) args.push('--no-save');
    if (opts.verbose) args.push('--verbose');
    if (maxPromptChars) args.push('--max-prompt-chars', String(maxPromptChars));

    const startedAt = nowIso();
    const startedMs = Date.now();
    let stdout = '';
    let stderr = '';
    let hardKilled = false;

    const child = spawn(process.execPath, args, {
      cwd: process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    if (opts.verbose) process.stderr.write(`[fanout] ${label}: started\n`);

    // The child has its own request timeouts; this is only a backstop for
    // a hung child process, and it kills the agent grandchild too.
    const guard = setTimeout(() => {
      hardKilled = true;
      killTree(child);
    }, opts.timeout + 180_000);
    guard.unref();

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
      if (stdout.length > 8_000_000) stdout = stdout.slice(-8_000_000);
    });
    child.stderr.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      stderr += text;
      if (stderr.length > 20_000) stderr = stderr.slice(-20_000);
      if (opts.verbose) {
        for (const line of text.split('\n')) {
          if (line.trim()) process.stderr.write(`[${agent}] ${line}\n`);
        }
      }
    });

    child.on('error', (err) => {
      clearTimeout(guard);
      resolvePromise(
        baseResult({
          agent,
          status: 'failed',
          durationMs: Date.now() - startedMs,
          startedAt,
          error: `could not start hub-acp.mjs: ${err.message}`,
          exitCode: 1,
        }),
      );
    });

    child.on('close', (code, signal) => {
      clearTimeout(guard);
      let parsed = null;
      try {
        parsed = JSON.parse(stdout);
      } catch {
        // Falls through to a failed result with the captured output.
      }

      if (!parsed) {
        const status = hardKilled ? 'timeout' : 'failed';
        resolvePromise(
          baseResult({
            agent,
            status,
            durationMs: Date.now() - startedMs,
            startedAt,
            error:
              `hub-acp.mjs produced no JSON (exit ${code ?? '?'}` +
              `${signal ? `, ${signal}` : ''})` +
              (stderr.trim() ? `: ${stderr.trim().split('\n').slice(-3).join(' | ')}` : ''),
            exitCode: status === 'timeout' ? 2 : 1,
            stderr,
          }),
        );
        return;
      }

      const status = hardKilled ? 'timeout' : parsed.status;
      resolvePromise(
        baseResult({
          agent,
          status,
          durationMs: parsed.durationMs ?? Date.now() - startedMs,
          startedAt,
          sessionId: parsed.sessionId ?? null,
          stopReason: parsed.stopReason ?? null,
          cost: parsed.cost ?? null,
          text: parsed.text ?? '',
          error: parsed.error ?? (hardKilled ? 'killed after parent backstop timeout' : null),
          exitCode: status === 'ok' ? 0 : status === 'timeout' ? 2 : 1,
          stderr,
        }),
      );
    });

    child.stdin.on('error', () => {});
    child.stdin.end(prompt);
  });
}


function writeLog(record) {
  mkdirSync(dirname(LOG_PATH), { recursive: true });
  rotateIfNeeded(LOG_PATH);
  appendFileSync(LOG_PATH, JSON.stringify(record) + '\n', 'utf8');
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (!['deny', 'allow-reads', 'allow-all'].includes(opts.permission)) {
    fail(`unknown permission policy: ${opts.permission}`);
  }
  if (!opts.agents) fail('--agents is required');

  const agents = [...new Set(opts.agents.split(',').map((a) => a.trim()).filter(Boolean))];
  if (!agents.length) fail('--agents is empty');

  const registry = loadRegistry(opts.registry ?? DEFAULT_REGISTRY);
  for (const name of agents) {
    if (!registry.agents[name]) {
      fail(`unknown agent "${name}" -- known: ${Object.keys(registry.agents).join(', ')}`);
    }
  }
  if (opts.synthesize && !registry.agents[opts.synthesize]) {
    fail(`unknown synthesis agent "${opts.synthesize}" -- known: ${Object.keys(registry.agents).join(', ')}`);
  }

  const prompt = readPrompt(opts);
  if (!prompt.trim()) fail('prompt is empty');
  if (prompt.length > MAX_PROMPT_CHARS) {
    fail(`prompt too long (${prompt.length} > ${MAX_PROMPT_CHARS}, same cap as hub-acp)`);
  }

  const parsedConfigs = opts.configs.map(splitConfig);
  const configAgents = new Set([...agents, ...(opts.synthesize ? [opts.synthesize] : [])]);
  for (const { agent } of parsedConfigs) {
    if (agent && !configAgents.has(agent)) {
      fail(
        `--config names "${agent}", which is not in --agents (${agents.join(', ')})` +
          (opts.synthesize ? ` or --synthesize (${opts.synthesize})` : ''),
      );
    }
  }

  const startedAt = nowIso();
  const startedMs = Date.now();
  const runStamp = stamp();

  if (!Number.isFinite(opts.timeout) || opts.timeout <= 0) {
    fail(`--timeout must be a positive number of milliseconds, got "${opts.timeout}"`);
  }
  if (!Number.isFinite(opts.budget) || opts.budget < 0) {
    fail(`--budget must be zero or a positive number, got "${opts.budget}"`);
  }

  // Optional isolation: one worktree per agent. Created before any agent
  // starts, so a setup failure aborts the whole fan-out instead of half of it.
  let worktrees = null;
  let worktreeRepo = null;
  if (opts.worktree) {
    const base = resolve(opts.cwd ?? process.cwd());
    const info = repoInfo(base);
    if (!info) fail(`--worktree needs a git repository; ${base} is not inside one`);
    worktreeRepo = info.root;
    worktrees = new Map();
    try {
      for (const agent of agents) {
        const path = worktreePath(info.commonDir, runStamp, agent);
        createWorktree(info.root, path);
        worktrees.set(agent, { path, kept: false });
      }
    } catch (error) {
      for (const wt of worktrees.values()) removeWorktree(info.root, wt.path);
      fail(`could not create a worktree: ${error.message}`);
    }
  }

  // Start every child before awaiting any, so the agents actually overlap.
  const pending = agents.map((agent) => {
    const configs = parsedConfigs
      .filter((c) => c.agent === null || c.agent === agent)
      .map((c) => c.config);
    return runOne({ agent, prompt, opts, configs, cwd: worktrees?.get(agent)?.path ?? null });
  });

  let results;
  try {
    results = await Promise.all(pending);
  } finally {
    // Keep a worktree only when the agent left something to inspect; discard
    // clean ones so repeated runs do not accumulate checkouts.
    if (worktrees) {
      for (const wt of worktrees.values()) {
        if (worktreeHasChanges(wt.path)) wt.kept = true;
        else removeWorktree(worktreeRepo, wt.path);
      }
    }
  }

  if (worktrees && results) {
    for (const result of results) {
      const wt = worktrees.get(result.agent);
      if (wt) {
        result.worktree = wt.path;
        result.worktreeKept = wt.kept;
      }
    }
  }

  let synthesis = null;
  if (opts.synthesize) {
    const usable = results.filter((r) => r.ok && r.text.trim());
    if (usable.length < 2) {
      process.stderr.write(
        `[fanout] synthesis skipped: need at least two successful answers (got ${usable.length})\n`,
      );
    } else {
      const synthPrompt = buildSynthesisPrompt({ prompt, results: usable });
      process.stderr.write(`[fanout] synthesizing with ${opts.synthesize}\n`);
      synthesis = await runOne({
        agent: opts.synthesize,
        prompt: synthPrompt,
        opts,
        configs: parsedConfigs
          .filter((c) => c.agent === opts.synthesize)
          .map((c) => c.config),
        maxPromptChars: SYNTH_MAX_PROMPT_CHARS,
        noSave: true,
        label: `${opts.synthesize} (synthesis)`,
      });
    }
  }

  const okCount = results.filter((r) => r.ok).length;
  const allTimedOut = results.every((r) => r.status === 'timeout');
  const exitCode = okCount > 0 ? 0 : allTimedOut ? 2 : 1;
  const durationMs = Date.now() - startedMs;
  const markdown = renderMarkdown({ prompt, results, synthesis, stamp: runStamp });

  let mergedFile = null;
  if (opts.save) {
    mkdirSync(RESULTS_DIR, { recursive: true });
    mergedFile = join(RESULTS_DIR, `${runStamp}-fanout-acp.md`);
    writeFileSync(mergedFile, markdown, 'utf8');
  }

  writeLog({
    time: startedAt,
    transport: 'acp',
    mode: 'fanout',
    agents: agents.map((name) => {
      const r = results.find((x) => x.agent === name);
      return { agent: name, status: r.status, durationMs: r.durationMs, cost: r.cost };
    }),
    status: okCount > 0 ? 'ok' : allTimedOut ? 'timeout' : 'failed',
    durationMs,
    okCount,
    synthesis: synthesis
      ? { agent: synthesis.agent, status: synthesis.status, durationMs: synthesis.durationMs, cost: synthesis.cost }
      : null,
    worktrees: worktrees
      ? [...worktrees.entries()].map(([agent, wt]) => ({ agent, path: wt.path, kept: wt.kept }))
      : null,
    prompt: prompt.slice(0, MAX_PROMPT_CHARS),
    mergedFile,
  });

  if (opts.json) {
    process.stdout.write(
      JSON.stringify(
        {
          ok: okCount > 0,
          mode: 'fanout',
          stamp: runStamp,
          startedAt,
          durationMs,
          prompt,
          okCount,
          mergedFile,
          agents: results.map(({ stderr, ...rest }) => rest),
          synthesis: synthesis ? (({ stderr, ...rest }) => rest)(synthesis) : null,
        },
        null,
        2,
      ) + '\n',
    );
  } else {
    process.stdout.write(markdown);
    if (mergedFile) process.stderr.write(`[fanout] saved ${mergedFile}\n`);
    process.stderr.write(
      `[fanout] ${okCount}/${results.length} ok · ${(durationMs / 1000).toFixed(1)}s\n`,
    );
    if (worktrees) {
      for (const [agent, wt] of worktrees) {
        if (wt.kept) process.stderr.write(`[fanout] kept worktree for ${agent}: ${wt.path}\n`);
      }
    }
    for (const r of results) {
      if (!r.ok) {
        process.stderr.write(
          `[fanout] ${r.agent}: ${r.status}` + (r.error ? ` — ${r.error}` : '') + '\n',
        );
      }
    }
  }

  return exitCode;
}

// Importable for tests without executing the CLI.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      process.stderr.write(`[fanout] fatal: ${err?.stack ?? err}\n`);
      process.exit(1);
    });
}
