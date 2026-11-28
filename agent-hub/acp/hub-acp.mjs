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
import { appendTranscript, eventRecord, MAX_TEXT_CHARS, toRecord } from './transcript.mjs';
import { redact } from './redact.mjs';

import {
  AcpClient,
  makePermissionHandler,
  windowsPathToWsl,
} from './acp-client.mjs';
import { CONSENT_PATH, permissionSafetyReason, testConsent as testConsentShared } from './consent.mjs';
import { spentTodayAll, spentTokensToday } from './spend-estimate.mjs';
import { effortConfig } from './effort.mjs';
import { sessionModel, sessionRequestedMode } from './session-model.mjs';
import { acquireTreeLock, releaseTreeLock } from './tree-lock.mjs';
import { isEnforcedReadOnly, prepareReadOnlySession, readOnlyViolations } from './readonly.mjs';
import { captureUsage, snapshotUsage } from './usage-capture.mjs';

import {
  CANCEL_WAIT_MS, DEFAULT_REGISTRY, LOCKS_DIR, LOG_PATH, MAX_LOGGED_TOOLS, MAX_OUTPUT_CHARS,
  MAX_PROMPT_CHARS, NON_CONFIG_KEYS, RESULTS_DIR, TRANSCRIPTS_DIR,
} from './hub-env.mjs';
import { USAGE, fail, parseArgs, readPrompt } from './hub-args.mjs';
import { chooseAutoAgent } from './route-pick.mjs';
import {
  checkMcpCapabilities, listAgents, loadMcpServers, loadRegistry, resolveAgent,
} from './registry.mjs';
import {
  clearInflight, nowIso, stamp, summarizeUpdate, truncate, writeInflight, writeLog, writeSalvage,
} from './run-record.mjs';

function testConsent(agentName, request = null) {
  return testConsentShared(agentName, CONSENT_PATH, request);
}

// The --json events stream is a protocol/debug trace, not a second copy of the
// answer: text chunks are kept out of it (the whole answer is in `text`, and a
// per-update pass cannot see a key split across two chunks). What remains is
// still redacted here -- a shallow copy keeps ids, kinds, statuses and numbers.
function redactUpdate(update) {
  if (!update || typeof update !== 'object') return update;
  if (
    (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') &&
    typeof update.title === 'string'
  ) {
    return { ...update, title: redact(update.title) };
  }
  return update;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (!['deny', 'allow-reads', 'ask', 'allow-all'].includes(opts.permission)) {
    fail(`unknown permission policy: ${opts.permission}`);
  }
  if (!Number.isFinite(opts.permissionTimeout) || opts.permissionTimeout <= 0) {
    fail(`--permission-timeout must be a positive number of ms, got "${opts.permissionTimeout}"`);
  }
  for (const change of opts.configs) {
    if (change.indexOf('=') < 1) fail(`--config expects ID=VALUE, got "${change}"`);
  }
  if ([opts.loadSession, opts.resumeSession, opts.continueSession].filter(Boolean).length > 1) {
    fail('--load, --resume and --continue are mutually exclusive');
  }

  const registry = loadRegistry(opts.registry ?? DEFAULT_REGISTRY);
  if (opts.list) {
    listAgents(registry, opts);
    return 0;
  }
  if (opts.agent === 'auto') {
    if (opts.probe) fail('--agent auto needs a prompt; --probe requires a concrete agent');
    // Read stdin/text once here: the choice needs the real prompt, and the
    // later read would otherwise consume an already-drained stdin.
    opts.promptText = readPrompt(opts);
    const decision = chooseAutoAgent(opts.promptText, { registryPath: opts.registry ?? DEFAULT_REGISTRY });
    opts.agent = decision.agent;
    process.stderr.write(`[acp] auto -> ${decision.agent}: ${decision.reason}\n`);
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
  // The agent's own token store, read before the prompt: the turn is the
  // difference between this and the same read once the turn ends. Null until
  // the session id exists, or for an agent without a local store.
  let usageBase = null;

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
    spentTokensToday: spentTokensToday(agent.name),
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
  // The context ceiling: the tighter of the caller's flag and the grant's
  // limit. 0 means off, exactly like --budget 0, but only the caller may say
  // that; a grant that sets one is enforced.
  if (opts.maxContext !== undefined && (!Number.isFinite(opts.maxContext) || opts.maxContext < 0)) {
    fail(`--max-context must be a positive number (0 = off), got "${opts.maxContext}"`);
  }
  const ceiling = Math.min(
    opts.maxContext > 0 ? opts.maxContext : Infinity,
    consent.contextLimit ?? Infinity,
  );
  const contextLimit = Number.isFinite(ceiling) ? Math.floor(ceiling) : 0;

  // An ACP agent may execute tools allowed by its own settings without sending
  // session/request_permission. The handler cannot enforce a restricted policy
  // in that case. Fail closed for every adapter, including aliases and probes.
  const restrictedReason = permissionSafetyReason(opts.permission, agent);
  if (restrictedReason) {
    const reason = restrictedReason;
    writeLog({ time: started, agent: agent.name, transport: 'acp', status: 'rejected', reason, permission: opts.permission });
    process.stderr.write(`[acp] ${agent.name} rejected: ${reason}\n`);
    return earlyExit('rejected', reason);
  }

  let prompt = '';
  if (!opts.probe) {
    prompt = opts.promptText ?? readPrompt(opts);
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
        prompt: truncate(redact(prompt), MAX_PROMPT_CHARS),
      });
      process.stderr.write(`[acp] ${agent.name} rejected: ${reason}\n`);
      return earlyExit('rejected', reason);
    }
  }

  const nativeCwd = resolve(opts.cwd ?? process.cwd());
  if (!isAbsolute(nativeCwd)) fail(`cwd is not absolute: ${nativeCwd}`);
  // Restricted runs (only reachable for an enforced adapter) start in a scratch
  // directory whose profile removes every mutating tool and re-allows reads of
  // the authorized tree. Records and session lookups still use nativeCwd.
  const readOnlySession = opts.permission !== 'allow-all' && opts.permission !== 'ask' && isEnforcedReadOnly(agent)
    ? prepareReadOnlySession(nativeCwd)
    : null;
  const sessionCwd = readOnlySession
    ? readOnlySession.cwd
    : agent.pathStyle === 'wsl' && process.platform === 'win32' ? windowsPathToWsl(nativeCwd) : nativeCwd;

  // Only a run that can actually edit files risks colliding with another one
  // on the same tree; allow-reads and deny runs never touch this. `ask` can
  // edit in-tree without a prompt, so it claims the tree like allow-all.
  // Conflicts reject unless explicitly overridden by the caller.
  let lockAcquired = false;
  let lockWarning = null;
  if ((opts.permission === 'allow-all' || opts.permission === 'ask') && !opts.probe) {
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
    // High-water mark of the context window during the turn, and its size, from
    // `usage_update`; contextFromUsage() falls back to the last update.
    contextPeak: 0,
    contextSize: 0,
    // The ceiling this turn may reach (0 = none), and whether it cut the turn.
    contextLimit,
    contextExceeded: false,
    permissions: [],
    events: [],
    budgetExceeded: false,
    replaying: false,
    replayed: 0,
    requestedMode: null,
    modeSource: null,
    reportedMode: null,
    modeChanged: false,
    prompting: false,
    // Set while an `ask` permission is held: {requestId, title, toolKind,
    // locations, heldSince}. The in-flight record turns it into `pendingPermission`.
    pendingPermission: null,
    pendingCount: 0,
  };

  // Transcript records that arrive before the session id is known are held and
  // flushed once it is, so nothing the agent says is lost.
  const pendingTranscript = [];
  const emit = (rec) => {
    if (!rec || opts.probe) return;
    if (sessionId) appendTranscript(TRANSCRIPTS_DIR, sessionId, rec);
    else pendingTranscript.push(rec);
  };
  const flushTranscript = () => {
    if (!sessionId) return;
    while (pendingTranscript.length) emit(pendingTranscript.shift());
  };

  // A turn deadline this process owns. The client cannot enforce it for `ask`:
  // while a permission is held the person is thinking, not the agent, so that
  // time must not count against the turn (--timeout kept meaning "how long the
  // agent may work", not "how long the person may take").
  let turnTimer = null;
  let turnDeadline = 0;
  let turnRemaining = null;
  let turnExpired = false;
  // Declared here because a permission hold has to know, before it is created,
  // that the turn is already stopping.
  let stopRequested = false;
  const clearTurnTimer = () => {
    if (turnTimer) clearTimeout(turnTimer);
    turnTimer = null;
  };
  const armTurnTimer = (ms) => {
    clearTurnTimer();
    turnDeadline = Date.now() + ms;
    turnTimer = setTimeout(() => {
      turnTimer = null;
      if (turnExpired) return;
      turnExpired = true;
      process.stderr.write(`[acp] ${agent.name}: turn timed out after ${ms}ms -- cancelling\n`);
      requestStop();
    }, ms);
    turnTimer.unref?.();
  };
  const pauseTurnTimer = () => {
    if (!turnTimer) return;
    turnRemaining = Math.max(0, turnDeadline - Date.now());
    clearTurnTimer();
  };
  const resumeTurnTimer = () => {
    if (turnRemaining === null) return;
    const ms = turnRemaining;
    turnRemaining = null;
    armTurnTimer(Math.max(1, ms));
  };

  // `ask` holds requests here until the caller answers, the timeout runs out,
  // or the turn is stopped. An agent may have more than one in flight (ACP
  // dispatches its requests without waiting for each answer), so the map is
  // the truth: every entry has its own timer and resolver, the oldest is what
  // job_status shows, and the turn clock stays paused until the map is empty.
  let permissionSeq = 0;
  const heldRequests = new Map(); // requestId -> { finish(decision, reason), info }
  const refreshPending = () => {
    const first = heldRequests.values().next();
    state.pendingPermission = first.done ? null : first.value.info;
    state.pendingCount = heldRequests.size;
  };
  const releaseHolds = (reason) => {
    for (const entry of [...heldRequests.values()]) entry.finish('reject', reason);
  };
  const cleanLocations = (locations) => (Array.isArray(locations) ? locations : [])
    .slice(0, 20)
    .map((location) => ({
      ...location,
      path: typeof location?.path === 'string' ? redact(location.path) : location?.path,
    }));
  const holdPermission = (request) => {
    // Once the turn is stopping -- a stop, a budget cut or a mode change --
    // an agent request must not be surfaced: nobody can act on it, and
    // approving it would apply inside the cancel window.
    if (stopRequested || state.budgetExceeded || state.modeChanged) {
      return Promise.resolve({
        decision: 'reject',
        reason: stopRequested ? 'stopped' : 'cancelled',
      });
    }
    return new Promise((resolve) => {
      const requestId = `perm_${process.pid}_${++permissionSeq}`;
      let timer = null;
      const info = {
        requestId,
        // Agent-authored titles are often a shell command line: redact at the
        // source, so the IPC message, the inflight file, the job record and the
        // transcript all carry the same safe text.
        title: redact(String(request?.title ?? 'tool call')).slice(0, 300),
        toolKind: request?.kind ?? 'other',
        locations: cleanLocations(request?.locations),
        heldSince: Date.now(),
      };
      const finish = (decision, reason) => {
        if (!heldRequests.has(requestId)) return;
        const wasOnly = heldRequests.size === 1;
        heldRequests.delete(requestId);
        if (timer) clearTimeout(timer);
        refreshPending();
        // The clock restarts only when nothing is held any more, and never when
        // the turn is already ending: a stop, a budget cut or a mode change is
        // not a timeout, and must not be reported as one.
        if (wasOnly && !stopRequested && !state.budgetExceeded && !state.modeChanged) {
          resumeTurnTimer();
        }
        if (!opts.probe) {
          writeInflight({ agent, cwd: sessionCwd, started, sessionId, state, prompt, model: appliedModel });
        }
        if (process.connected) {
          try {
            process.send({
              type: 'permission-closed',
              requestId,
              decision: reason === 'timeout' ? 'timeout' : decision,
            });
          } catch {}
        }
        resolve({ decision, reason });
      };
      if (!heldRequests.size) pauseTurnTimer();
      heldRequests.set(requestId, { finish, info });
      refreshPending();
      if (!opts.probe) {
        writeInflight({ agent, cwd: sessionCwd, started, sessionId, state, prompt, model: appliedModel });
      }
      if (!process.connected) {
        process.stderr.write('[acp] permission "ask" has no caller to answer it; rejecting\n');
        finish('reject', 'no-caller');
        return;
      }
      timer = setTimeout(() => {
        process.stderr.write(
          `[acp] permission held for ${opts.permissionTimeout}ms with no answer; rejecting\n`,
        );
        finish('reject', 'timeout');
      }, opts.permissionTimeout);
      timer.unref?.();
      try {
        process.send({
          type: 'permission-request',
          requestId,
          title: info.title,
          toolKind: info.toolKind,
          locations: info.locations,
        });
      } catch {
        finish('reject', 'no-caller');
      }
    });
  };

  const permissionHandler = makePermissionHandler(opts.permission, (decision) => {
    // The audit line and the transcript both carry this: keep the agent's
    // command line from putting a credential there.
    const safe = { ...decision, title: redact(String(decision.title ?? '')).slice(0, 300) };
    state.permissions.push(safe);
    emit(eventRecord('permission', {
      title: safe.title, toolKind: safe.kind, decision: safe.decision,
    }, nowIso()));
    if (opts.verbose) {
      process.stderr.write(
        `[permission] ${decision.decision} (${decision.policy}): ${decision.title}` +
          ` [${decision.kind}]${decision.optionId ? ` -> ${decision.optionId}` : ''}\n`,
      );
    }
  }, { hold: opts.permission === 'ask' ? holdPermission : null, treeRoot: nativeCwd });

  const client = new AcpClient({
    command: agent.command,
    args: agent.args,
    env: agent.env,
    cwd: readOnlySession ? readOnlySession.cwd : nativeCwd,
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
      let modeUpdate = false;
      if (sessionId && msg.params?.sessionId === sessionId) {
        let reported;
        if (update?.sessionUpdate === 'config_option_update') {
          if (Array.isArray(update.configOptions)) client.configOptions = update.configOptions;
          reported = update.configOptions?.find((option) => option.id === 'mode')?.currentValue ?? null;
        } else if (update?.sessionUpdate === 'current_mode_update') {
          reported = update.currentModeId ?? null;
        }
        if (reported !== undefined) {
          modeUpdate = true;
          state.reportedMode = reported;
          if (state.requestedMode && state.prompting && reported !== state.requestedMode && !state.modeChanged) {
            state.modeChanged = true;
            requestModeStop();
          }
        }
      }
      // Text is written once, as the whole turn, when the stop record is
      // emitted: a key split across two streamed chunks matched nothing when
      // each chunk was redacted on its own.
      if (update?.sessionUpdate !== 'agent_message_chunk') emit(toRecord(update, nowIso()));
      // Events are a protocol/debug stream, not the answer: `text` already holds
      // it whole. Chunk text is skipped rather than redacted here because a
      // per-update redaction cannot see a key that straddles two chunks. Tools,
      // config, mode, usage and status updates still flow, titles redacted.
      const sessionUpdate = update?.sessionUpdate;
      if (
        opts.json &&
        state.events.length < 1000 &&
        sessionUpdate !== 'agent_message_chunk' &&
        sessionUpdate !== 'agent_thought_chunk'
      ) {
        state.events.push(redactUpdate(update));
      }
      summarizeUpdate(update, state, opts);

      // Refresh the in-flight record on tool activity, at most once a second:
      // frequent enough to see progress, cheap enough not to matter.
      const now = Date.now();
      if (!opts.probe && (modeUpdate || now - lastInflightAt >= 1000)) {
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
        // Same cancel-and-wait as a caller stop: the budget path must still
        // take the agent down if it ignores session/cancel, or the turn would
        // wait forever on a prompt the hub no longer wants.
        requestStop('the budget cap');
        try {
          client.cancel();
        } catch {}
      }

      // The same stop, for the context window: past this ceiling every further
      // tool step re-reads the whole prefix, so the turn is cut rather than left
      // to grow. `used` is what the agent reports for the window it is carrying.
      const used = Number(update?.used);
      if (
        update?.sessionUpdate === 'usage_update' &&
        state.contextLimit > 0 &&
        Number.isFinite(used) &&
        used > state.contextLimit &&
        !state.contextExceeded
      ) {
        state.contextExceeded = true;
        process.stderr.write(
          `[acp] context exceeded (${used} > ${state.contextLimit} tokens) -- cancelling\n`,
        );
        requestStop('the context ceiling');
        try {
          client.cancel();
        } catch {}
      }
    },
  });

  // The caller can ask this run to stop (the MCP server does, over the IPC
  // channel, when the chat presses stop or cancels a job). Stopping here rather
  // than being killed is what keeps the contract: the agent is told to stop,
  // the hub waits for proof, and the run still gets its audit line.
  let stopping = null;
  let modeStopping = null;
  const requestModeStop = () => {
    clearTurnTimer();
    releaseHolds('cancelled');
    modeStopping = client.cancelAndWait({ ms: CANCEL_WAIT_MS }).catch(
      () => ({ ack: false, waitedMs: 0 }),
    ).then(async (outcome) => {
      cancel = outcome;
      if (!outcome.ack) await client.close({ graceMs: 0 });
    });
  };
  const requestStop = (why = 'the caller') => {
    if (stopRequested) return;
    stopRequested = true;
    clearTurnTimer();
    releaseHolds('cancelled');
    process.stderr.write(`[acp] ${agent.name}: stop requested by ${why} -- cancelling\n`);
    stopping = client.cancelAndWait({ ms: CANCEL_WAIT_MS }).then(
      (outcome) => outcome,
      () => ({ ack: false, waitedMs: 0 }),
    ).then(async (outcome) => {
      cancel = outcome;
      // No proof the turn ended: take the agent down so this run can finish.
      if (!outcome.ack) await client.close({ graceMs: 0 });
    });
  };
  process.on('message', (message) => {
    if (message?.type === 'cancel') requestStop();
    else if (message?.type === 'permission-answer') {
      const entry = heldRequests.get(message.requestId);
      if (entry) {
        entry.finish(message.decision === 'allow_once' ? 'allow_once' : 'reject', 'owner');
      }
      // Tell the caller whether the answer landed: a request that already
      // timed out must not be reported as applied.
      if (process.connected) {
        try {
          process.send({
            type: 'permission-ack',
            requestId: message.requestId,
            applied: Boolean(entry),
          });
        } catch {}
      }
    }
  });
  // The channel must not keep this process alive once the run is over.
  process.channel?.unref?.();

  let sessionId = null;
  let stopReason = null;
  let status = 'ok';
  let failure = null;
  let exitCode = 0;
  let cancel = null;
  let lastInflightAt = 0;
  let appliedModel = null;
  let salvage = null;
  let sessionMode = opts.loadSession ? 'load' : opts.resumeSession ? 'resume' : opts.continueSession ? 'continue' : 'new';

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

    // --continue: the caller wants the conversation back and should not need to
    // know which of the two ACP ways this agent offers. Resume is preferred: it
    // does not replay the history.
    if (opts.continueSession) {
      if (client.agentCapabilities.sessionCapabilities?.resume) opts.resumeSession = opts.continueSession;
      else if (client.agentCapabilities.loadSession === true) opts.loadSession = opts.continueSession;
      else throw new Error(`${agent.name} cannot continue a session: it advertises neither resume nor load`);
      sessionMode = opts.resumeSession ? 'resume' : 'load';
    }

    state.replaying = Boolean(opts.loadSession);
    const session = opts.loadSession
      ? await client.loadSession({ sessionId: opts.loadSession, cwd: sessionCwd, mcpServers })
      : opts.resumeSession
        ? await client.resumeSession({ sessionId: opts.resumeSession, cwd: sessionCwd, mcpServers })
        : await client.newSession({ cwd: sessionCwd, mcpServers });
    state.replaying = false;
    sessionId = session.sessionId ?? opts.loadSession ?? opts.resumeSession;
    flushTranscript();
    state.reportedMode = session.configOptions?.find((option) => option.id === 'mode')?.currentValue
      ?? session.modes?.currentModeId ?? null;
    if (opts.verbose && state.replayed) {
      process.stderr.write(`[acp] replayed ${state.replayed} session update(s)\n`);
    }

    // Registry defaults apply first, so an explicit --config on the CLI
    // (applied after, same session) still wins -- the registry only sets
    // what to do when nobody asked for anything in particular.
    const continuing = opts.loadSession ?? opts.resumeSession ?? opts.continueSession;
    const previousModel = sessionModel(LOG_PATH, { agent: agent.name, sessionId: continuing, cwd: nativeCwd });
    const previousMode = sessionRequestedMode(LOG_PATH, { agent: agent.name, sessionId: continuing, cwd: nativeCwd });
    const explicitMode = opts.configs.some((change) => change.startsWith('mode='));
    // An attended turn runs the adapter's attended mode from the registry
    // (`permissionModes.attended.force`): under `ask`, that is the mode the
    // owner approved (Claude acceptEdits, Codex workspace-write, OpenCode
    // build), not whatever the adapter defaults to.
    const attendedMode = opts.permission === 'ask' ? (agent.permissionModes?.attended?.force ?? null) : null;
    const defaultConfigs = Object.entries(agent.defaultConfig ?? {})
      .filter(([id]) => !NON_CONFIG_KEYS.has(id))
      .filter(([id]) => id !== 'model' || !continuing)
      .filter(([id]) => id !== 'mode' || (!explicitMode && !previousMode && !attendedMode))
      .map(([id, value]) => `${id}=${value}`);
    if (continuing && previousModel && !opts.configs.some((change) => change.startsWith('model='))) {
      defaultConfigs.push(`model=${previousModel}`);
    }
    // Precedence: an explicit --config mode= wins, then the attended mode,
    // then the mode this agent last requested in this session.
    if (attendedMode && !explicitMode) defaultConfigs.push(`mode=${attendedMode}`);
    else if (continuing && previousMode && !explicitMode) {
      defaultConfigs.push(`mode=${previousMode}`);
      process.stderr.write(`[acp] restoring last requested mode: ${previousMode}\n`);
    }
    const configs = [...defaultConfigs, ...opts.configs];
    state.requestedMode = configs.filter((change) => change.startsWith('mode=')).at(-1)?.slice(5) ?? null;
    state.modeSource = state.requestedMode
      ? explicitMode ? 'explicit' : attendedMode ? 'attended' : previousMode ? 'restored' : 'registry'
      : null;
    for (const change of configs) {
      const eq = change.indexOf('=');
      const configId = change.slice(0, eq);
      const value = change.slice(eq + 1);
      const response = await client.setConfigOption(sessionId, configId, value);
      if (configId === 'mode' || Array.isArray(response?.configOptions)) {
        state.reportedMode = response?.configOptions?.find((option) => option.id === 'mode')?.currentValue ?? null;
      }
      if (opts.verbose) process.stderr.write(`[acp] config ${configId} = ${value}\n`);
    }
    if (state.requestedMode && state.reportedMode !== state.requestedMode) {
      throw new Error(`requested mode ${state.requestedMode} not confirmed by agent (reported: ${state.reportedMode ?? 'unknown'})`);
    }
    if (state.requestedMode) {
      process.stderr.write(`[acp] requested mode: ${state.requestedMode}; agent reported: ${state.reportedMode} (not a sandbox)\n`);
    } else if (continuing) {
      process.stderr.write(`[acp] no mode requested; agent reported: ${state.reportedMode ?? 'unknown'} (not a sandbox)\n`);
    }
    // What the agent says it is running beats what we asked for; the ask is the
    // fallback for agents that do not report config options.
    appliedModel =
      client.configOptions.find((option) => option.id === 'model')?.currentValue ??
      [...defaultConfigs, ...opts.configs]
        .reverse()
        .find((change) => change.startsWith('model='))
        ?.slice('model='.length) ??
      (!continuing ? agent.defaultConfig?.model : null) ??
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
        label: opts.label ?? null,
        sessionMode,
        requestedMode: state.requestedMode,
        modeSource: state.modeSource,
        reportedMode: state.reportedMode,
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
        requestedMode: state.requestedMode,
        modeSource: state.modeSource,
        reportedMode: state.reportedMode,
      };
      process.stdout.write(JSON.stringify(info, null, 2) + '\n');
      return 0;
    }

    if (stopRequested) throw new Error('stopped by the caller before the turn started');
    if (state.requestedMode && state.reportedMode !== state.requestedMode) {
      throw new Error('agent mode changed before prompt');
    }
    state.prompting = true;
    emit(eventRecord('prompt', { text: prompt }, nowIso()));
    // The scratch session has no project files of its own: tell the agent where
    // the real tree is so relative paths in the prompt resolve against it.
    const sentPrompt = readOnlySession
      ? `Read-only session. The project to inspect is at ${nativeCwd}; resolve relative paths against it and use absolute paths there. You cannot modify anything.\n\n${prompt}`
      : prompt;
    // Best-effort, never fatal: an unreadable store leaves the after-read
    // labelled `session-total` instead of `delta`, and the run goes on.
    usageBase = snapshotUsage(agent.name, { sessionId, cwd: nativeCwd });
    // 0: no client timer. The deadline lives here so a held permission can
    // pause it; requestStop() below is what turns an expired turn into a
    // cancelled agent and a status of "timeout".
    armTurnTimer(opts.timeout);
    const result = await client.prompt(sessionId, sentPrompt, { timeoutMs: 0 });
    state.prompting = false;
    clearTurnTimer();
    stopReason = result?.stopReason ?? null;
    if (state.modeChanged) {
      throw new Error('agent reported a mode change during the turn; cancellation requested');
    } else if (turnExpired) {
      status = 'timeout';
      exitCode = 2;
    } else if (state.budgetExceeded) {
      // The budget cut is what stopped this turn; "cancelled" would hide why.
      status = 'budget';
      exitCode = 1;
    } else if (state.contextExceeded) {
      // Same for the context ceiling: the turn was cut for a reason worth naming.
      status = 'context';
      exitCode = 1;
    } else if (stopRequested) {
      status = 'cancelled';
      exitCode = 1;
    } else if (!state.text.trim()) status = 'empty';
  } catch (err) {
    failure = err;
    if (state.modeChanged) {
      await modeStopping;
      status = 'failed';
      exitCode = 1;
      failure = new Error(
        cancel?.ack
          ? 'agent reported a mode change during the turn; cancellation acknowledged'
          : `agent reported a mode change; cancellation was not acknowledged -- ${sessionCwd} may still be changing`,
      );
    } else if (turnExpired) {
      await stopping;
      status = 'timeout';
      exitCode = 2;
    } else if (state.budgetExceeded) {
      await stopping;
      status = 'budget';
      exitCode = 1;
    } else if (state.contextExceeded) {
      await stopping;
      status = 'context';
      exitCode = 1;
    } else if (stopRequested) {
      await stopping;
      status = 'cancelled';
      exitCode = 1;
      failure = new Error(
        cancel?.ack
          ? 'stopped by the caller'
          : `stopped by the caller; the agent did not confirm within ${cancel?.waitedMs ?? 0}ms and was ` +
              `terminated -- ${sessionCwd} may still be changing`,
      );
    } else if (/timed out/i.test(err.message)) {
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
    clearTurnTimer();
    await stopping;
    await modeStopping;
    await client.close({ graceMs: cancel && !cancel.ack ? 5000 : 1500 });
    clearInflight();
    if (lockAcquired) releaseTreeLock(LOCKS_DIR, nativeCwd);
  }

  // A turn that ran out of time is a timeout whether the agent answered the
  // cancel or had to be taken down; say which, after the cancellation settled.
  if (turnExpired) {
    failure = new Error(
      cancel?.ack
        ? `turn timed out after ${opts.timeout}ms; the agent acknowledged the cancellation`
        : `turn timed out after ${opts.timeout}ms; session/cancel was not acknowledged after ` +
            `${cancel?.waitedMs ?? 0}ms -- ${sessionCwd} may still be changing`,
    );
  }

  // The profile should make mutating tools impossible. If one still ran, the
  // guarantee failed: say so loudly rather than returning a "read-only" answer.
  if (readOnlySession) {
    const violations = readOnlyViolations(state.tools);
    if (violations.length) {
      status = 'failed';
      exitCode = 1;
      failure = new Error(`read-only guarantee violated: ${violations.map((tool) => `${tool.kind} ${tool.title}`).join('; ')}`);
      process.stderr.write(`[acp] ${agent.name} ${failure.message}\n`);
    }
  }

  // The turn's text is written once, as a whole, so a key split across streamed
  // chunks is seen by redact() before anything reaches disk. The transcript
  // keeps the turn's text only once this stop record is written: a run hard-killed
  // before that point leaves no agent text in the transcript, and no audit line
  // either (writeLog runs after the stop emit). While the turn runs, recentText
  // in the inflight file -- and job_status -- is the live view.
  if (state.text.trim()) {
    const whole = redact(state.text);
    for (let offset = 0; offset < whole.length; offset += MAX_TEXT_CHARS) {
      emit(eventRecord('text', { text: whole.slice(offset, offset + MAX_TEXT_CHARS) }, nowIso()));
    }
  }
  emit(eventRecord('stop', { reason: stopReason ?? '', status }, nowIso()));
  flushTranscript();

  const durationMs = Date.now() - startedMs;
  const cost = state.usage?.cost ?? null;
  // Tokens are not in ACP: they come from the agent's local store, read before
  // the prompt and again here. `probe` starts no session, so it measures nothing.
  const usage = opts.probe
    ? null
    : captureUsage({ agent: agent.name, sessionId, cwd: nativeCwd, base: usageBase, startedMs, state });

  // A run that did not answer may still have touched the tree. Record what it
  // left behind, so whoever reads the failure can look instead of guessing.
  if (!opts.probe && status !== 'ok' && (opts.permission === 'allow-all' || opts.permission === 'ask')) {
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
    // Redact before truncating: a secret cut at the cap boundary would
    // otherwise survive as a fragment that no longer matches its shape.
    prompt: opts.probe ? undefined : truncate(redact(prompt), MAX_PROMPT_CHARS),
    // The model is part of what a run is: with the free-first chain, the same
    // call can be answered by a different model on the next attempt.
    model: appliedModel,
    requestedMode: state.requestedMode,
    modeSource: state.modeSource,
    reportedMode: state.reportedMode,
    modeChanged: state.modeChanged,
    effort: opts.effort ?? null,
    // Tokens the turn consumed, from the agent's local store; `cost` above is
    // only what the provider chose to report over ACP. Attribution (task,
    // label, cwd, session) lives here; volume stays in the provider scan in
    // workspaces-panel/tool/lib/costs.mjs. They join by sessionId, they never add up.
    usage,
    sessionId,
    label: opts.label ?? null,
    sessionMode,
    stopReason,
    durationMs,
    cost,
    output: truncate(redact(String(state.text ?? '')), MAX_OUTPUT_CHARS),
    permissions: state.permissions,
    // What the agent actually did, not just what it was allowed to do. The
    // permission list above records policy decisions; this records the tool
    // calls that followed. Bounded so one noisy run cannot bloat the log.
    toolCount: state.tools.size,
    tools: [...state.tools.entries()].slice(0, MAX_LOGGED_TOOLS).map(([id, tool]) => ({
      id,
      title: redact(String(tool.title ?? '')),
      kind: tool.kind,
      status: tool.status,
    })),
    budgetExceeded: state.budgetExceeded,
    // The ceiling that applied to this turn (null when there was none), and
    // whether it cut the turn; the peak it reached is in `usage.context_peak`.
    contextLimit: state.contextLimit || null,
    contextExceeded: state.contextExceeded,
    error: failure ? redact(String(failure.message ?? failure)) : undefined,
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
    writeFileSync(file, header + redact(state.text.trimEnd()) + '\n', 'utf8');
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
          tokens: usage,
          contextLimit: state.contextLimit || null,
          contextExceeded: state.contextExceeded,
          text: redact(state.text),
          tools: [...state.tools.entries()].map(([id, t]) => ({
            id, ...t, title: redact(String(t.title ?? '')),
          })),
          permissions: state.permissions,
          budgetExceeded: state.budgetExceeded,
          agentInfo: client.agentInfo,
          agentCapabilities: client.agentCapabilities,
          configOptions: client.configOptions,
          error: failure ? redact(String(failure.message ?? failure)) : undefined,
          cancelAck: cancel?.ack ?? null,
          cancelWaitMs: cancel?.waitedMs ?? null,
          model: appliedModel,
          requestedMode: state.requestedMode,
          modeSource: state.modeSource,
          reportedMode: state.reportedMode,
          modeChanged: state.modeChanged,
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
