#!/usr/bin/env node
// hub-acp.mjs — drive one ACP agent through the hub's consent gate.
//
//   node hub-acp.mjs --agent opencode --prompt "Reply with exactly ACP_OK"
//   node hub-acp.mjs --agent claude --prompt - < prompt.txt
//   node hub-acp.mjs --list
//   node hub-acp.mjs --agent opencode --probe
//
// This is the ACP transport path, alongside hub.ps1 (CLI adapters). It
// speaks ACP v1 directly, passes MCP servers to the agent at session/new,
// answers permission requests from a policy instead of a human, and writes
// the same shape of audit record to ../logs/runs.jsonl. See acp-client.mjs
// for the protocol layer and README.md for the design.
//
// Exit codes match hub.ps1: 0 answered, 1 denied/rejected/failed, 2 timed out.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, appendFileSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  AcpClient,
  makePermissionHandler,
  windowsPathToWsl,
} from './acp-client.mjs';
import { CONSENT_PATH, spentToday, testConsent as testConsentShared } from './consent.mjs';
import { effortConfig } from './effort.mjs';
import { rotateIfNeeded } from './log-rotation.mjs';
import { acquireTreeLock, releaseTreeLock } from './tree-lock.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const HUB_DIR = resolve(HERE, '..');
const ROOT = resolve(HUB_DIR, '..');
const RESULTS_DIR = process.env.AGENT_HUB_RESULTS
  ? resolve(process.env.AGENT_HUB_RESULTS)
  : join(HUB_DIR, 'results');
const LOCKS_DIR = process.env.AGENT_HUB_LOCKS
  ? resolve(process.env.AGENT_HUB_LOCKS)
  : join(RESULTS_DIR, 'locks');
const LOG_PATH = process.env.AGENT_HUB_LOG
  ? resolve(process.env.AGENT_HUB_LOG)
  : join(ROOT, 'logs', 'runs.jsonl');
// Local registry first; a fresh clone runs with the shipped example.
const DEFAULT_REGISTRY = existsSync(join(HERE, 'agents.json'))
  ? join(HERE, 'agents.json')
  : join(HERE, 'agents.example.json');
const MAX_PROMPT_CHARS = 4000;
const MAX_OUTPUT_CHARS = 20000;
// Runtime activity is the point of the audit trail (see
// docs/tetragon-runtime-security.md), but a runaway agent can emit thousands
// of tool calls. Log a bounded summary plus the true count.
const MAX_LOGGED_TOOLS = 100;

// defaultConfig is a map of ACP session config options (model=..., mode=...).
// Anything else that ends up in the registry entry must not be sent to the
// agent as a config id -- OpenCode answers "unknown config option" to that.
const NON_CONFIG_KEYS = new Set(['modelFallbacks', 'notes', 'label']);

// How long a cancelled turn gets to stop on its own before the process is
// killed. ACP's session/cancel is a notification with no reply, so the only
// proof it worked is the turn ending -- and a model mid-tool-call needs a few
// seconds. Too short here is what leaves an agent editing after a "timeout".
const CANCEL_WAIT_MS = Number(process.env.HUB_CANCEL_WAIT_MS ?? 8000);

// Written while a run is in flight so `hubctl status` and the MCP status tool
// can show what is happening now. logs/runs.jsonl only gets its line at the
// end, which is why a stuck turn used to be invisible everywhere.
const INFLIGHT_DIR = process.env.AGENT_HUB_INFLIGHT
  ? resolve(process.env.AGENT_HUB_INFLIGHT)
  : join(RESULTS_DIR, 'inflight');

const USAGE = `usage: node hub-acp.mjs --agent NAME (--prompt TEXT | --prompt -) [options]

  --agent NAME          registry entry to drive (see --list)
  --prompt TEXT|-       prompt text, or - to read it from stdin
  --cwd DIR             session working directory (default: current dir)
  --load SESSION_ID     resume via session/load (replays history first;
                        requires the agent's loadSession capability)
  --resume SESSION_ID   resume via session/resume (no replay; requires the
                        agent's sessionCapabilities.resume capability)
  --mcp FILE            JSON file with mcpServers to pass at session/new
                        (array, or { "mcpServers": [...] })
  --permission POLICY   deny (default) | allow-reads | allow-all
  --allow-concurrent-write  explicitly bypass a conflicting tree claim
  --timeout MS          prompt turn timeout (default 300000)
  --max-prompt-chars N  reject prompts longer than N chars (default 4000;
                        fan-out synthesis raises this for its own merge call)
  --budget USD          cancel the turn when reported cost exceeds this
                        (default 0.50, matching hub.ps1's Claude cap; 0 = off)
  --config ID=VALUE     set a session config option (repeatable); e.g.
                        --config model=opencode-go/deepseek-v4.1-flash
  --model NAME          shorthand for --config model=NAME
  --effort LEVEL        reasoning effort: low | medium | high | max, mapped to the
                        agent's own option (registry "effort"); low is enough for
                        text and mechanical work and is several times faster
  --auth METHOD         call authenticate with this methodId after initialize
  --registry FILE       alternate agents.json
  --json                machine-readable result on stdout (no streaming)
  --no-stream           do not print answer chunks as they arrive
  --no-save             do not write a result file under ../results/
  --verbose             tool calls, permission decisions, agent stderr
  --probe               initialize + session/new, print capabilities, no prompt
  --list                list registry entries and availability
`;

function parseArgs(argv) {
  const opts = {
    permission: 'deny',
    timeout: 300_000,
    budget: 0.5,
    stream: true,
    save: true,
    json: false,
    verbose: false,
    probe: false,
    list: false,
    configs: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) fail(`${arg} needs a value`);
      return argv[++i];
    };
    switch (arg) {
      case '--agent': opts.agent = next(); break;
      case '--prompt': opts.prompt = next(); break;
      case '--cwd': opts.cwd = next(); break;
      case '--load': opts.loadSession = next(); break;
      case '--resume': opts.resumeSession = next(); break;
      case '--mcp': opts.mcp = next(); break;
      case '--permission': opts.permission = next(); break;
      case '--allow-concurrent-write': opts.allowConcurrentWrite = true; break;
      case '--timeout': opts.timeout = Number(next()); break;
      case '--max-prompt-chars': opts.maxPromptChars = Number(next()); break;
      case '--budget': opts.budget = Number(next()); break;
      case '--config': opts.configs.push(next()); break;
      case '--model': opts.configs.push(`model=${next()}`); break;
      case '--effort': opts.effort = next(); break;
      case '--auth': opts.auth = next(); break;
      case '--registry': opts.registry = next(); break;
      case '--json': opts.json = true; break;
      case '--no-stream': opts.stream = false; break;
      case '--no-save': opts.save = false; break;
      case '--verbose': opts.verbose = true; break;
      case '--probe': opts.probe = true; break;
      case '--list': opts.list = true; break;
      case '-h': case '--help': opts.help = true; break;
      default: fail(`unknown option: ${arg}`);
    }
  }
  return opts;
}

function fail(message) {
  process.stderr.write(`[acp] ${message}\n\n${USAGE}`);
  process.exit(1);
}

function nowIso() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function stamp(date = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return (
    `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-` +
    `${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`
  );
}

function truncate(text, max) {
  if (!text) return '';
  return text.length > max ? text.slice(0, max) + '...[truncated]' : text;
}

function commandExists(command) {
  // An absolute path is a file to check, not a name to search PATH for --
  // and on at least this machine, Windows' `where` rejects a full path
  // outright ("Invalid pattern is specified in path:pattern") rather than
  // resolving it, so this is correctness, not just a shortcut.
  if (isAbsolute(command)) return existsSync(command);
  if (process.platform === 'win32') {
    return spawnSync('where', [command], { stdio: 'ignore' }).status === 0;
  }
  return spawnSync('sh', ['-c', 'command -v "$1"', 'sh', command], { stdio: 'ignore' }).status === 0;
}

function loadRegistry(file) {
  if (!existsSync(file)) fail(`registry not found: ${file}`);
  let raw;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    fail(`registry is not valid JSON (${file}): ${err.message}`);
  }
  if (!raw?.agents || typeof raw.agents !== 'object') fail(`registry has no "agents" object: ${file}`);
  return raw;
}

function resolveAgent(registry, name) {
  const entry = registry.agents[name];
  if (!entry) {
    fail(`unknown agent "${name}" -- known: ${Object.keys(registry.agents).join(', ')}`);
  }
  // Platform overrides win over the cross-platform default. `pathStyle:
  // "wsl"` means the agent lives inside WSL even when the hub runs on
  // Windows, so session paths must be translated before session/new.
  const platform = entry.platforms?.[process.platform] ?? {};
  const command = platform.command ?? entry.command;
  const args = platform.args ?? entry.args ?? [];
  const pathStyle = platform.pathStyle ?? entry.pathStyle ?? 'native';
  const env = { ...(entry.env ?? {}), ...(platform.env ?? {}) };
  if (!command) fail(`agent "${name}" has no command for ${process.platform}`);
  return {
    name,
    label: entry.label ?? name,
    command,
    args,
    pathStyle,
    env,
    notes: entry.notes,
    defaultConfig: entry.defaultConfig,
    effort: entry.effort,
  };
}

function listAgents(registry, opts) {
  const rows = Object.entries(registry.agents).map(([name, entry]) => {
    const resolved = resolveAgent(registry, name);
    const available = commandExists(resolved.command);
    const launcherOnly = /(^|[\\/])npx(\.cmd|\.exe)?$/i.test(resolved.command);
    return {
      name,
      label: resolved.label,
      command: [resolved.command, ...resolved.args].join(' '),
      available,
      launcherOnly,
    };
  });

  if (opts.json) {
    process.stdout.write(JSON.stringify(rows, null, 2) + '\n');
    return;
  }
  for (const row of rows) {
    const status = !row.available
      ? 'not found on PATH'
      : row.launcherOnly
        ? 'launcher found (npx fetches on first run)'
        : 'available';
    process.stdout.write(
      `${row.name.padEnd(10)} ${row.label.padEnd(26)} ${status}\n  ${row.command}\n`,
    );
  }
}

function testConsent(agentName, request = null) {
  return testConsentShared(agentName, CONSENT_PATH, request);
}

function normalizeEnv(env) {
  if (Array.isArray(env)) return env;
  if (env && typeof env === 'object') {
    return Object.entries(env).map(([name, value]) => ({ name, value: String(value) }));
  }
  return [];
}

function normalizeMcpServers(rawList) {
  if (!Array.isArray(rawList)) fail('MCP config must be an array, or { "mcpServers": [...] }');
  return rawList.map((server, index) => {
    const where = `mcpServers[${index}]`;
    if (!server?.name) fail(`${where} has no name`);
    if (server.type === 'http' || server.type === 'sse') {
      if (!server.url) fail(`${where} (${server.type}) has no url`);
      return {
        type: server.type,
        name: server.name,
        url: server.url,
        headers: Array.isArray(server.headers) ? server.headers : [],
      };
    }
    if (!server.command) fail(`${where} has no command (or type: http/sse)`);
    return {
      name: server.name,
      command: server.command,
      args: Array.isArray(server.args) ? server.args : [],
      env: normalizeEnv(server.env),
    };
  });
}

function loadMcpServers(file) {
  if (!file) return [];
  if (!existsSync(file)) fail(`MCP config not found: ${file}`);
  let raw;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    fail(`MCP config is not valid JSON (${file}): ${err.message}`);
  }
  return normalizeMcpServers(Array.isArray(raw) ? raw : raw?.mcpServers);
}

function checkMcpCapabilities(servers, capabilities) {
  const http = capabilities?.mcpCapabilities?.http === true;
  const sse = capabilities?.mcpCapabilities?.sse === true;
  for (const server of servers) {
    if (server.type === 'http' && !http) {
      throw new Error(`agent does not advertise MCP http transport (needed by "${server.name}")`);
    }
    if (server.type === 'sse' && !sse) {
      throw new Error(`agent does not advertise MCP sse transport (needed by "${server.name}")`);
    }
  }
  if (servers.length) {
    const unknown = servers.filter((s) => s.type !== 'http' && s.type !== 'sse');
    for (const s of unknown) {
      if (!isAbsolute(s.command) && process.platform !== 'win32') {
        process.stderr.write(
          `[acp] note: MCP command "${s.command}" is not an absolute path; ACP asks for one. ` +
            `The agent may resolve it from its own PATH.\n`,
        );
      }
    }
  }
}

function writeLog(record) {
  mkdirSync(dirname(LOG_PATH), { recursive: true });
  rotateIfNeeded(LOG_PATH);
  appendFileSync(LOG_PATH, JSON.stringify(record) + '\n', 'utf8');
}

// ── in-flight record ────────────────────────────────────────────────────────
//
// One tiny file per running hub-acp, deleted on exit. It is the only place
// that says "this agent is working in this tree right now" while the turn is
// still going; see INFLIGHT_DIR above.

function inflightPath() {
  return join(INFLIGHT_DIR, `${process.pid}.json`);
}

function writeInflight({ agent, cwd, started, sessionId, state, prompt, model }) {
  try {
    mkdirSync(INFLIGHT_DIR, { recursive: true });
    const tools = [...state.tools.values()];
    const last = tools.length ? tools[tools.length - 1] : null;
    const body = {
      pid: process.pid,
      platform: process.platform,
      agent: agent.name,
      cwd,
      started,
      updated: new Date().toISOString(),
      sessionId: sessionId ?? null,
      model: model ?? null,
      // Set by the MCP server when this run is a background job: the terminal
      // view can then name the same job the chat collects.
      jobId: process.env.AGENT_HUB_JOB_ID ?? null,
      toolCount: tools.length,
      // Titles come from the agent and can be multi-line shell snippets; keep
      // the status line one line.
      lastTool: last
        ? `${String(last.title).replace(/\s+/g, ' ').trim().slice(0, 80)} (${last.status})`
        : null,
      prompt: prompt ? truncate(prompt.replace(/\s+/g, ' '), 200) : null,
    };
    writeFileSync(inflightPath(), JSON.stringify(body) + '\n', 'utf8');
  } catch {
    // Visibility is a convenience: never let it fail a run.
  }
}

function clearInflight() {
  try {
    unlinkSync(inflightPath());
  } catch {}
}

// ── salvage record ──────────────────────────────────────────────────────────
//
// A failed or timed-out run that had write access leaves work behind. The
// caller's next question is always "what did it touch?" — answer it here
// instead of making a human reconstruct it from the transcript.

function runGit(cwd, args) {
  try {
    const result = spawnSync('git', ['-C', cwd, ...args], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 15_000,
    });
    return result.status === 0 ? result.stdout.trim() : null;
  } catch {
    return null;
  }
}

function writeSalvage({ agent, status, nativeCwd, sessionId, failure }) {
  const head = runGit(nativeCwd, ['rev-parse', '--short', 'HEAD']);
  if (!head) return null; // not a git tree: nothing useful to record
  const porcelain = runGit(nativeCwd, ['status', '--porcelain']) ?? '';
  const dirty = porcelain
    ? porcelain.split('\n').filter(Boolean).slice(0, 100).map((line) => line.trim())
    : [];
  const body = {
    time: nowIso(),
    agent: agent.name,
    status,
    cwd: nativeCwd,
    sessionId: sessionId ?? null,
    error: failure?.message ?? null,
    head,
    branch: runGit(nativeCwd, ['rev-parse', '--abbrev-ref', 'HEAD']),
    dirtyCount: dirty.length,
    dirty,
    diffstat: runGit(nativeCwd, ['diff', '--stat']) ?? '',
  };
  try {
    mkdirSync(RESULTS_DIR, { recursive: true });
    const file = join(RESULTS_DIR, `${stamp()}-${process.pid}-${agent.name}-salvage.json`);
    writeFileSync(file, JSON.stringify(body, null, 2) + '\n', 'utf8');
    return file;
  } catch {
    return null;
  }
}

function readPrompt(opts) {
  if (opts.prompt === '-') return readFileSync(0, 'utf8');
  if (opts.prompt !== undefined) return opts.prompt;
  if (!process.stdin.isTTY) return readFileSync(0, 'utf8');
  fail('no prompt given (use --prompt TEXT, --prompt -, or pipe into stdin)');
}

function summarizeUpdate(update, state, opts) {
  const kind = update?.sessionUpdate;
  if (kind === 'agent_message_chunk' && update.content?.type === 'text') {
    const text = update.content.text ?? '';
    state.text += text;
    if (!opts.json && opts.stream) process.stdout.write(text);
    return;
  }
  if (kind === 'agent_thought_chunk' && opts.verbose) {
    const text = update.content?.text ?? '';
    if (text) process.stderr.write(`[thought] ${text.trimEnd()}\n`);
    return;
  }
  if (kind === 'tool_call' || kind === 'tool_call_update') {
    const previous = state.tools.get(update.toolCallId);
    const tool = {
      title: update.title ?? previous?.title ?? 'tool',
      kind: update.kind ?? previous?.kind,
      status: update.status ?? previous?.status ?? 'pending',
    };
    state.tools.set(update.toolCallId, tool);
    if (opts.verbose) {
      process.stderr.write(`[tool] ${update.toolCallId}: ${tool.title} (${tool.status})\n`);
    }
    return;
  }
  if (kind === 'usage_update') {
    state.usage = update;
    return;
  }
  if (opts.verbose && kind) {
    process.stderr.write(`[update] ${kind}\n`);
  }
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
  for (const change of opts.configs) {
    if (change.indexOf('=') < 1) fail(`--config expects ID=VALUE, got "${change}"`);
  }
  if (opts.loadSession && opts.resumeSession) {
    fail('--load and --resume are mutually exclusive');
  }

  const registry = loadRegistry(opts.registry ?? DEFAULT_REGISTRY);
  if (opts.list) {
    listAgents(registry, opts);
    return 0;
  }
  if (!opts.agent) fail('--agent is required (or use --list)');

  const agent = resolveAgent(registry, opts.agent);
  if (opts.effort) {
    let change;
    try { change = effortConfig(agent.effort, opts.effort); } catch (err) { fail(err.message); }
    // Explicit --config still wins: it comes after this in opts.configs.
    if (change) opts.configs.unshift(change);
    else process.stderr.write(`[acp] ${agent.name} declares no effort option; --effort ${opts.effort} ignored\n`);
  }
  const started = nowIso();
  const startedMs = Date.now();
  const runStamp = stamp();

  // Machine consumers (fanout-acp) expect a result even when nothing was
  // spawned; a stderr-only rejection would look like a crash to them.
  const earlyExit = (status, reason) => {
    if (opts.json) {
      process.stdout.write(
        JSON.stringify({ ok: false, status, agent: agent.name, error: reason }, null, 2) + '\n',
      );
    }
    return 1;
  };

  // Consent first: nothing (not even --probe) spawns an agent without it.
  // The grant's limits (max permission, write trees, budget cap) are checked
  // against this exact request, so the scope is enforced, not just described.
  const consent = testConsent(agent.name, {
    permission: opts.permission,
    cwd: resolve(opts.cwd ?? process.cwd()),
    budget: opts.budget,
    spentToday: spentToday(agent.name, LOG_PATH),
  });
  if (!consent.ok) {
    writeLog({
      time: started,
      agent: agent.name,
      transport: 'acp',
      status: 'denied',
      reason: consent.reason,
    });
    process.stderr.write(`[acp] ${agent.name} denied: ${consent.reason}\n`);
    return earlyExit('denied', consent.reason);
  }
  if (consent.budget !== undefined) {
    if (consent.note) process.stderr.write(`[acp] ${consent.note}
`);
    opts.budget = consent.budget;
  }

  let prompt = '';
  if (!opts.probe) {
    prompt = readPrompt(opts);
    const maxPromptChars = opts.maxPromptChars ?? MAX_PROMPT_CHARS;
    if (maxPromptChars <= 0 || !Number.isFinite(maxPromptChars)) {
      fail(`--max-prompt-chars must be a positive number, got "${opts.maxPromptChars}"`);
    }
    if (!prompt.trim()) {
      writeLog({ time: started, agent: agent.name, transport: 'acp', status: 'rejected', reason: 'empty prompt' });
      process.stderr.write(`[acp] ${agent.name} rejected: empty prompt\n`);
      return earlyExit('rejected', 'empty prompt');
    }
    if (prompt.length > maxPromptChars) {
      const reason = `prompt too long (${prompt.length} > ${maxPromptChars})`;
      writeLog({
        time: started,
        agent: agent.name,
        transport: 'acp',
        status: 'rejected',
        reason,
        prompt: truncate(prompt, MAX_PROMPT_CHARS),
      });
      process.stderr.write(`[acp] ${agent.name} rejected: ${reason}\n`);
      return earlyExit('rejected', reason);
    }
  }

  const nativeCwd = resolve(opts.cwd ?? process.cwd());
  if (!isAbsolute(nativeCwd)) fail(`cwd is not absolute: ${nativeCwd}`);
  const sessionCwd =
    agent.pathStyle === 'wsl' && process.platform === 'win32' ? windowsPathToWsl(nativeCwd) : nativeCwd;

  // Only a run that can actually edit files risks colliding with another one
  // on the same tree; allow-reads and deny runs never touch this. Conflicts
  // reject unless explicitly overridden by the caller.
  let lockAcquired = false;
  let lockWarning = null;
  if (opts.permission === 'allow-all' && !opts.probe) {
    const claim = acquireTreeLock(LOCKS_DIR, nativeCwd, { agent: agent.name });
    if (claim.ok) {
      lockAcquired = true;
    } else {
      lockWarning = claim.holder
        ? `${claim.holder.agent} (pid ${claim.holder.pid}) is already writing to ${nativeCwd}`
        : `another run is already writing to ${nativeCwd}`;
      if (!opts.allowConcurrentWrite) {
        const reason = `${lockWarning}; use a separate worktree or --allow-concurrent-write`;
        writeLog({ time: started, agent: agent.name, transport: 'acp', status: 'rejected', reason, concurrentWrite: lockWarning });
        process.stderr.write(`[acp] rejected: ${reason}\n`);
        return earlyExit('rejected', reason);
      }
      process.stderr.write(`[acp] warning: ${lockWarning} -- explicit override\n`);
    }
  }

  const mcpServers = loadMcpServers(opts.mcp);

  const state = {
    text: '',
    tools: new Map(),
    usage: null,
    permissions: [],
    events: [],
    budgetExceeded: false,
    replaying: false,
    replayed: 0,
  };

  const permissionHandler = makePermissionHandler(opts.permission, (decision) => {
    state.permissions.push(decision);
    if (opts.verbose) {
      process.stderr.write(
        `[permission] ${decision.decision} (${decision.policy}): ${decision.title}` +
          ` [${decision.kind}]${decision.optionId ? ` -> ${decision.optionId}` : ''}\n`,
      );
    }
  });

  const client = new AcpClient({
    command: agent.command,
    args: agent.args,
    env: agent.env,
    cwd: nativeCwd,
    agentLabel: agent.label,
    requestTimeoutMs: 30_000,
    onPermission: permissionHandler,
    onStderr: (line) => {
      if (opts.verbose) process.stderr.write(`[${agent.name} stderr] ${line}\n`);
    },
    onNotification: (msg) => {
      if (msg.method !== 'session/update') return;
      const update = msg.params?.update;
      // session/load replays the previous conversation as updates before it
      // responds; that history is not this turn's answer.
      if (state.replaying) {
        state.replayed += 1;
        return;
      }
      if (opts.json && state.events.length < 1000) state.events.push(update);
      summarizeUpdate(update, state, opts);

      // Refresh the in-flight record on tool activity, at most once a second:
      // frequent enough to see progress, cheap enough not to matter.
      const now = Date.now();
      if (!opts.probe && now - lastInflightAt >= 1000) {
        lastInflightAt = now;
        writeInflight({ agent, cwd: sessionCwd, started, sessionId, state, prompt, model: appliedModel });
      }

      // Cost is reported per turn by agents that support usage_update.
      // There is no protocol-level budget primitive, so enforce it here:
      // cancel the turn as soon as the reported cumulative cost crosses
      // the cap. Matches hub.ps1's --max-budget-usd guard for Claude.
      const cost = update?.cost?.amount;
      if (
        update?.sessionUpdate === 'usage_update' &&
        opts.budget > 0 &&
        typeof cost === 'number' &&
        cost > opts.budget &&
        !state.budgetExceeded
      ) {
        state.budgetExceeded = true;
        process.stderr.write(
          `[acp] budget exceeded ($${cost.toFixed(4)} > $${opts.budget.toFixed(2)}) -- cancelling\n`,
        );
        try {
          client.cancel();
        } catch {}
      }
    },
  });

  let sessionId = null;
  let stopReason = null;
  let status = 'ok';
  let failure = null;
  let exitCode = 0;
  let cancel = null;
  let lastInflightAt = 0;
  let appliedModel = null;
  let salvage = null;
  const sessionMode = opts.loadSession ? 'load' : opts.resumeSession ? 'resume' : 'new';

  try {
    client.start();
    writeInflight({ agent, cwd: sessionCwd, started, sessionId, state, prompt, model: appliedModel });
    const init = await client.initialize();
    if (opts.verbose) {
      process.stderr.write(
        `[acp] ${agent.label}: protocol v${init.protocolVersion}` +
          `, agent=${init.agentInfo?.name ?? '?'} v${init.agentInfo?.version ?? '?'}\n`,
      );
    }

    if (opts.auth) await client.authenticate(opts.auth);
    else if (client.authMethods.length && opts.verbose) {
      process.stderr.write(
        `[acp] agent advertises auth methods: ${client.authMethods.map((m) => m.id ?? m.type).join(', ')}\n`,
      );
    }

    checkMcpCapabilities(mcpServers, client.agentCapabilities);

    state.replaying = Boolean(opts.loadSession);
    const session = opts.loadSession
      ? await client.loadSession({ sessionId: opts.loadSession, cwd: sessionCwd, mcpServers })
      : opts.resumeSession
        ? await client.resumeSession({ sessionId: opts.resumeSession, cwd: sessionCwd, mcpServers })
        : await client.newSession({ cwd: sessionCwd, mcpServers });
    state.replaying = false;
    sessionId = session.sessionId ?? opts.loadSession ?? opts.resumeSession;
    if (opts.verbose && state.replayed) {
      process.stderr.write(`[acp] replayed ${state.replayed} session update(s)\n`);
    }

    // Registry defaults apply first, so an explicit --config on the CLI
    // (applied after, same session) still wins -- the registry only sets
    // what to do when nobody asked for anything in particular.
    const defaultConfigs = Object.entries(agent.defaultConfig ?? {})
      .filter(([id]) => !NON_CONFIG_KEYS.has(id))
      .map(([id, value]) => `${id}=${value}`);
    for (const change of [...defaultConfigs, ...opts.configs]) {
      const eq = change.indexOf('=');
      const configId = change.slice(0, eq);
      const value = change.slice(eq + 1);
      await client.setConfigOption(sessionId, configId, value);
      if (opts.verbose) process.stderr.write(`[acp] config ${configId} = ${value}\n`);
    }
    // What the agent says it is running beats what we asked for; the ask is the
    // fallback for agents that do not report config options.
    appliedModel =
      client.configOptions.find((option) => option.id === 'model')?.currentValue ??
      [...defaultConfigs, ...opts.configs]
        .reverse()
        .find((change) => change.startsWith('model='))
        ?.slice('model='.length) ??
      agent.defaultConfig?.model ??
      null;
    // Refresh now that the model is known: a running turn should say which
    // model is working, not only after it makes its first tool call.
    if (!opts.probe) {
      writeInflight({ agent, cwd: sessionCwd, started, sessionId, state, prompt, model: appliedModel });
    }
    if (opts.verbose && client.configOptions.length) {
      for (const option of client.configOptions) {
        process.stderr.write(
          `[acp] option ${option.id} = ${option.currentValue}` +
            (option.category ? ` (${option.category})` : '') + '\n',
        );
      }
    }

    if (opts.probe) {
      writeLog({
        time: started,
        agent: agent.name,
        transport: 'acp',
        status: 'probe',
        sessionId,
        sessionMode,
        durationMs: Date.now() - startedMs,
        protocolVersion: init.protocolVersion,
        agentInfo: init.agentInfo,
      });
      const info = {
        ok: true,
        agent: agent.name,
        protocolVersion: init.protocolVersion,
        agentInfo: init.agentInfo,
        agentCapabilities: client.agentCapabilities,
        authMethods: client.authMethods,
        sessionId,
        sessionMode,
        cwd: sessionCwd,
        mcpServers: mcpServers.map((s) => s.name),
        configOptions: client.configOptions,
        modes: session.modes ?? null,
      };
      process.stdout.write(JSON.stringify(info, null, 2) + '\n');
      return 0;
    }

    const result = await client.prompt(sessionId, prompt, { timeoutMs: opts.timeout });
    stopReason = result?.stopReason ?? null;
    if (state.budgetExceeded) {
      status = 'budget';
      exitCode = 1;
    } else if (!state.text.trim()) status = 'empty';
  } catch (err) {
    failure = err;
    if (/timed out/i.test(err.message)) {
      status = 'timeout';
      exitCode = 2;
      // Ask the agent to stop and wait for proof that it did. Without this,
      // "timeout" only meant "the hub stopped listening" while the callee kept
      // editing the tree -- see docs/dispatch-playbook.md.
      try {
        cancel = await client.cancelAndWait({ ms: CANCEL_WAIT_MS });
      } catch {
        cancel = { ack: false, waitedMs: 0 };
      }
      if (!cancel.ack) {
        failure = new Error(
          `${err.message}; session/cancel was not acknowledged after ` +
            `${cancel.waitedMs}ms -- ${sessionCwd} may still be changing`,
        );
      }

    } else {
      status = 'failed';
      exitCode = 1;
    }
  } finally {
    await client.close({ graceMs: cancel && !cancel.ack ? 5000 : 1500 });
    clearInflight();
    if (lockAcquired) releaseTreeLock(LOCKS_DIR, nativeCwd);
  }

  const durationMs = Date.now() - startedMs;
  const cost = state.usage?.cost ?? null;

  // A run that did not answer may still have touched the tree. Record what it
  // left behind, so whoever reads the failure can look instead of guessing.
  if (!opts.probe && status !== 'ok' && opts.permission === 'allow-all') {
    salvage = writeSalvage({ agent, status, nativeCwd, sessionId, failure });
  }

  const record = {
    time: started,
    agent: agent.name,
    transport: 'acp',
    // Where the turn ran: lets `hubctl spend` attribute cost to a project.
    cwd: nativeCwd,
    status,
    prompt: opts.probe ? undefined : truncate(prompt, MAX_PROMPT_CHARS),
    // The model is part of what a run is: with the free-first chain, the same
    // call can be answered by a different model on the next attempt.
    model: appliedModel,
    effort: opts.effort ?? null,
    sessionId,
    sessionMode,
    stopReason,
    durationMs,
    cost,
    output: truncate(state.text, MAX_OUTPUT_CHARS),
    permissions: state.permissions,
    // What the agent actually did, not just what it was allowed to do. The
    // permission list above records policy decisions; this records the tool
    // calls that followed. Bounded so one noisy run cannot bloat the log.
    toolCount: state.tools.size,
    tools: [...state.tools.entries()].slice(0, MAX_LOGGED_TOOLS).map(([id, tool]) => ({
      id,
      title: tool.title,
      kind: tool.kind,
      status: tool.status,
    })),
    budgetExceeded: state.budgetExceeded,
    error: failure?.message,
    protocolWarnings: client.protocolWarnings,
    concurrentWrite: lockWarning,
    // Only meaningful for a timeout: did the callee confirm it stopped?
    cancelAck: cancel?.ack ?? null,
    cancelWaitMs: cancel?.waitedMs ?? null,
    // Where to look before re-dispatching, when a write run did not answer.
    salvage,
  };
  writeLog(record);

  let savedTo = null;
  if (!opts.probe && opts.save && state.text.trim()) {
    mkdirSync(RESULTS_DIR, { recursive: true });
    const file = join(RESULTS_DIR, `${runStamp}-${agent.name}-acp.md`);
    savedTo = file;
    const header =
      `<!-- worker: ${agent.name} | transport: acp/1 | time: ${runStamp} | ` +
      `cwd: ${sessionCwd} | session: ${sessionId ?? '-'} | stop: ${stopReason ?? '-'} -->\n\n`;
    writeFileSync(file, header + state.text.trimEnd() + '\n', 'utf8');
    if (opts.verbose) process.stderr.write(`[acp] saved ${file}\n`);
  }

  if (opts.json) {
    process.stdout.write(
      JSON.stringify(
        {
          ok: status === 'ok',
          status,
          agent: agent.name,
          sessionId,
          sessionMode,
          stopReason,
          durationMs,
          cost,
          usage: state.usage,
          text: state.text,
          tools: [...state.tools.entries()].map(([id, t]) => ({ id, ...t })),
          permissions: state.permissions,
          budgetExceeded: state.budgetExceeded,
          agentInfo: client.agentInfo,
          agentCapabilities: client.agentCapabilities,
          configOptions: client.configOptions,
          error: failure?.message,
          cancelAck: cancel?.ack ?? null,
          cancelWaitMs: cancel?.waitedMs ?? null,
          model: appliedModel,
          concurrentWrite: lockWarning,
          salvage,
          savedTo,
          events: state.events,
        },
        null,
        2,
      ) + '\n',
    );
  } else {
    if (state.text && opts.stream) process.stdout.write('\n');
    process.stderr.write(
      `[acp] ${agent.name} · ${(durationMs / 1000).toFixed(1)}s · ${status}` +
        (stopReason ? ` · ${stopReason}` : '') +
        (cost ? ` · $${Number(cost.amount).toFixed(4)}` : '') +
        (failure ? `\n[acp] error: ${failure.message}` : '') +
        '\n',
    );
  }

  for (const warning of client.protocolWarnings) {
    process.stderr.write(`[acp] non-protocol stdout: ${warning}\n`);
  }

  return exitCode;
}

// Exit through the event loop, not process.exit(): on a pipe, exit() can cut
// a large --json document mid-string (the bench hit this at ~146 KB). Setting
// exitCode lets Node flush stdout first.
main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    process.stderr.write(`[acp] fatal: ${err?.stack ?? err}\n`);
    process.exitCode = 1;
  });
