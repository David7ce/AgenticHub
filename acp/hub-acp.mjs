#!/usr/bin/env node
// hub-acp.mjs — drive one ACP agent through the hub's consent gate.
//
//   node hub-acp.mjs --agent opencode --prompt "Reply with exactly ACP_OK"
//   node hub-acp.mjs --agent claude --prompt - < prompt.txt
//   node hub-acp.mjs --list
//   node hub-acp.mjs --agent opencode --probe
//
// This is the ACP transport path. It
// speaks ACP v1 directly, passes MCP servers to the agent at session/new,
// answers permission requests from a policy instead of a human, and writes
// the same shape of audit record to ../logs/runs.jsonl. See acp-client.mjs
// for the protocol layer and README.md for the design.
//
// Exit codes: 0 answered, 1 denied/rejected/failed, 2 timed out.


import { mkdirSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

import {
  AcpClient,
  makePermissionHandler,
  windowsPathToWsl,
} from './acp-client.mjs';
import { CONSENT_PATH, testConsent as testConsentShared } from './consent.mjs';
import { spentTodayAll } from './spend-estimate.mjs';
import { effortConfig } from './effort.mjs';
import { acquireTreeLock, releaseTreeLock } from './tree-lock.mjs';

import {
  CANCEL_WAIT_MS, DEFAULT_REGISTRY, LOCKS_DIR, LOG_PATH, MAX_LOGGED_TOOLS, MAX_OUTPUT_CHARS,
  MAX_PROMPT_CHARS, NON_CONFIG_KEYS, RESULTS_DIR,
} from './hub-env.mjs';
import { USAGE, fail, parseArgs, readPrompt } from './hub-args.mjs';
import {
  checkMcpCapabilities, listAgents, loadMcpServers, loadRegistry, resolveAgent,
} from './registry.mjs';
import {
  clearInflight, nowIso, stamp, summarizeUpdate, truncate, writeInflight, writeLog, writeSalvage,
} from './run-record.mjs';

function testConsent(agentName, request = null) {
  return testConsentShared(agentName, CONSENT_PATH, request);
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
    spentToday: spentTodayAll(agent.name, LOG_PATH),
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
      // the cap. Mirrors Claude's own --max-budget-usd guard.
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
    // The queue task this run belongs to, when `hubctl tasks run` launched it.
    taskId: opts.taskId ?? null,
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
          taskId: opts.taskId ?? null,
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
