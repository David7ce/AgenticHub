#!/usr/bin/env node
// server.mjs — the hub as an MCP server (stdio, newline-delimited JSON-RPC).
//
// This is what lets the agent you already chat with call the other agents.
// It owns the ambient I/O (stdin/stdout, child processes, files); every
// decision lives in core.mjs. Each tool call is a real hub-acp/fanout-acp
// invocation, so consent.json, logs/runs.jsonl, budgets, permission policy
// and worktrees behave exactly as they do from the command line -- there is
// no second path to audit.
//
//   node agent-hub/mcp/server.mjs          # speaks MCP on stdio
//
// Register it in the client's MCP config; see README.md. Nothing is written
// to stdout except protocol messages: logs go to stderr, or the client
// treats them as protocol and disconnects.


import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

import { handleMessage, SERVER_INFO, ToolError } from './core.mjs';
import { createJobRegistry } from './jobs.mjs';
import { createSessionRegistry, foreignOwner } from './sessions.mjs';
import { readTranscript, transcriptPath } from '../acp/transcript.mjs';
import { ensureWorktree, removeWorktree, repoInfo, worktreeHasChanges } from '../acp/worktree.mjs';
import { TRANSCRIPTS_DIR } from '../acp/hub-env.mjs';
import { HUB_CONFIG } from '../acp/config.mjs';
import {
  decideRoute,
  describeAttempts,
  modelChain,
  readAgentEntry,
  readRunStats,
  shouldTryNextModel,
} from '../acp/router.mjs';
import { CONSENT_PATH, normalizeTree, testConsent } from '../acp/consent.mjs';
import { gatherBrief, renderBrief } from '../hubctl/commands/brief.mjs';
import { ROOT as WORKSPACE_ROOT, STATE_DIR, INDEX_PATH } from '../hubctl/common.mjs';
import { openIndex, reindex, search as searchIndex } from '../hubctl/search.mjs';
import { gatherStatus, readInflight, renderStatus } from '../hubctl/hubctl.mjs';

import {
  HUB_ACP, FANOUT_ACP, REGISTRY, DEFAULT_TURN_TIMEOUT_MS, log, spawnHub, parseHubJson, runHubScript, registryArgs, defaultModels, resolveCwd, hubArgsFor, requestStop, stopHubProcesses,
} from './hub-process.mjs';


// ── named sessions ──────────────────────────────────────────────────────────
//
// The registry is the durable record (core.mjs only decides; this is the I/O).
// A labelled turn marks its session running, and settling it -- foreground in
// ask(), background in settleSession() -- puts it back to idle.

const sessionRegistry = createSessionRegistry({ path: join(HUB_CONFIG.resultsDir, 'sessions.json') });

// A locked registry is a tool error the caller can retry, not a crashed call.
function sessionIO(fn) {
  try {
    return fn();
  } catch (err) {
    if (/session registry is locked/.test(err?.message ?? '')) throw new ToolError(err.message);
    throw err;
  }
}

const isActive = (session) => session?.state === 'running' || session?.state === 'waiting-permission';

// Labels this process is driving right now. A foreground ask holds its turn
// without a job id, so the registry alone cannot tell it from a stale `running`
// record; this set can. Background turns also pass through it until they settle.
const runningTurns = new Set();

// `worktree` is the checkout this turn runs in, when one was made (or already
// kept) for it. The first time a session is given one it is recorded -- new or
// existing -- so later turns return there; a checkout already on the record is
// never replaced. The original `cwd` stays the tree ownership errors name.
// `ownerPid` marks the window driving the turn, so another server start does
// not mistake this process's live job for a stale record.
function beginTurn(request, worktree = null) {
  const { label, agent, cwd } = request;
  if (!label) return;
  const existing = sessionRegistry.get(label);
  const kept = existing?.worktree?.path ?? null;
  sessionIO(() => sessionRegistry.upsert(label, {
    agent,
    cwd: cwd ? resolveCwd(cwd) : process.cwd(),
    state: 'running',
    ownerPid: process.pid,
    ...(kept || !worktree ? {} : { worktree: { path: worktree } }),
  }));
  runningTurns.add(label);
}

// How a turn ended, as the registry records it in lastTurn.
function turnOutcome(status) {
  if (status === 'ok') return 'ok';
  return status === 'cancelled' ? 'cancelled' : 'failed';
}

const reportedCost = (cost) => (typeof cost === 'number' ? cost : cost?.amount);

function endTurn(label, result, outcome = null) {
  runningTurns.delete(label);
  const session = sessionRegistry.get(label);
  if (!session) return;
  const cost = reportedCost(result?.cost);
  sessionIO(() => sessionRegistry.upsert(label, {
    state: session.state === 'closed' ? 'closed' : 'idle',
    jobId: null,
    acpSessionId: session.acpSessionId ?? result?.sessionId ?? null,
    ...(outcome ? { lastTurn: outcome } : {}),
    ...(typeof cost === 'number' && Number.isFinite(cost) ? { spendUsd: (session.spendUsd ?? 0) + cost } : {}),
  }));
}

// Is a turn really driving this session? A live turn in another window counts,
// as does a job or a foreground ask in this one. Anything else -- a `running`
// record whose endTurn failed -- is stale and the next turn may take it over.
function sessionLive(session) {
  if (!session) return false;
  if (runningTurns.has(session.label)) return true;
  if (foreignOwner(session) !== null) return true;
  return session.jobId ? jobs.status(session.jobId)?.running === true : false;
}

// Atomic check-and-append: the turn is queued only if the session is busy.
function queueTurn(label, request) {
  const session = sessionRegistry.get(label);
  if (!isActive(session)) return null;
  // A stale active record is not busy: it must be taken over, not queued behind.
  if (!sessionLive(session)) return null;
  // Each entry carries its own options: a later queuer must never widen (or
  // narrow) what an earlier prompt was allowed to do.
  const queued = [...(session.queued ?? []), { prompt: request.prompt, ...pickOptions(request) }];
  sessionIO(() => sessionRegistry.upsert(label, { queued }));
  return queued.length;
}

function pickOptions({ permission, budgetUsd, timeoutMs, mode, worktree }) {
  return Object.fromEntries(
    Object.entries({ permission, budgetUsd, timeoutMs, mode, worktree }).filter(([, v]) => v !== undefined),
  );
}

// Ends the turn in the registry, once more if the first write fails. Never
// throws: the turn already ran, and its answer must not be lost to the record.
// Returns a warning when the session could not be put back to idle.
function finishTurn(label, result, outcome) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      endTurn(label, result, outcome);
      return null;
    } catch (err) {
      log(`ending session ${label} (attempt ${attempt + 1}): ${err?.message ?? err}`);
    }
  }
  return `session ${label} could not be updated and may still read as running; session_close can end it`;
}

// A queued prompt that could not be started is not deleted: it moves to
// `dropped` so `sessions` still shows it and the person can send it again.
function recordDropped(label, entry) {
  try {
    sessionIO(() => sessionRegistry.upsert(label, {
      dropped: [...(sessionRegistry.get(label)?.dropped ?? []), entry],
    }));
  } catch (err) {
    log(`recording the dropped prompt of ${label}: ${err?.message ?? err}`);
  }
}

// Starts the next queued prompt of an idle session as a background job, with
// exactly the options it was queued with.
function drainQueue(label) {
  try {
    const session = sessionRegistry.get(label);
    if (!session || session.state !== 'idle' || !session.queued?.length) return;
    const [entry, ...rest] = session.queued;
    const next = typeof entry === 'string' ? { prompt: entry } : entry;
    sessionIO(() => sessionRegistry.upsert(label, { queued: rest }));
    void startJob({
      permission: next.permission,
      budgetUsd: next.budgetUsd,
      timeoutMs: next.timeoutMs,
      mode: next.mode,
      worktree: next.worktree,
      agent: session.agent,
      prompt: next.prompt,
      cwd: session.cwd,
      label,
      sessionId: session.acpSessionId ?? undefined,
      model: session.model ?? undefined,
      effort: session.effort ?? undefined,
    }).then((started) => {
      if (started?.error) {
        log(`queued turn for ${label} not started: ${started.error}`);
        recordDropped(label, next);
      }
    }).catch((err) => {
      // The entry was already taken out of the queue; without this it would be
      // lost, which is the one outcome a queued prompt must never have.
      log(`queued turn for ${label} failed to start: ${err?.message ?? err}`);
      recordDropped(label, next);
    });
  } catch (err) {
    log(`draining session ${label}: ${err?.message ?? err}`);
  }
}

// The person stopped the work: prompts queued behind it are not started. They
// move to dropped so `sessions` still lists them.
function dropQueue(label) {
  try {
    const session = sessionRegistry.get(label);
    if (!session?.queued?.length) return;
    sessionIO(() => sessionRegistry.upsert(label, {
      queued: [],
      dropped: [...(session.dropped ?? []), ...session.queued],
    }));
  } catch (err) {
    log(`dropping queue of ${label}: ${err?.message ?? err}`);
  }
}

// After a turn: a cancelled one drops what was queued behind it, any other
// outcome starts the next queued prompt.
function afterTurn(label, outcome) {
  if (outcome === 'cancelled') dropQueue(label);
  else drainQueue(label);
}

// Job onSettled hook for a labelled job: session back to idle with the turn
// recorded, then the queue is drained (or dropped, after a cancel).
function settleSession(label, job) {
  const outcome = turnOutcome(job.state);
  finishTurn(label, job.output, outcome);
  afterTurn(label, outcome);
}

async function sessions({ agent, state, includeClosed }) {
  return sessionIO(() => sessionRegistry.list({ agent, state }))
    .filter((session) => includeClosed || state === 'closed' || session.state !== 'closed');
}

async function sessionLog(label, { before, limit, textOnly }) {
  const session = sessionIO(() => sessionRegistry.get(label));
  if (!session) return null;
  if (!session.acpSessionId) return { noTranscript: true };
  return readTranscript(TRANSCRIPTS_DIR, session.acpSessionId, { before, limit, textOnly });
}

// `from` hands another session's result over. One read with a limit high enough
// that a long turn cannot page the prompt that starts it out; the newest
// `turns` turns are joined oldest first, and the caller gets the whole
// transcript's path for anything the prompt budget could not carry. The
// returned `turns` is how many were really carried, which is what the heading
// must say: a transcript with one turn cannot honour a request for three.
const HANDOFF_RECORD_LIMIT = 1_000_000;

async function handoffSource(label, turns) {
  const session = sessionIO(() => sessionRegistry.get(label));
  if (!session) return null;
  if (!session.acpSessionId) return { noTranscript: true };
  const { records } = readTranscript(TRANSCRIPTS_DIR, session.acpSessionId, { limit: HANDOFF_RECORD_LIMIT });
  // Records are newest first. A turn starts at a prompt record and runs to the
  // newest record, so the Nth-newest prompt is the oldest edge of N turns; if
  // fewer turns exist than asked for, the oldest prompt is used.
  const promptPositions = [];
  records.forEach((record, position) => {
    if (record.kind === 'prompt') promptPositions.push(position);
  });
  if (!promptPositions.length) return { noTranscript: true };
  const carried = Math.min(turns, promptPositions.length);
  const edge = promptPositions[carried - 1];
  const text = records
    .slice(0, edge + 1)
    .filter((record) => record.kind === 'text' && typeof record.text === 'string' && record.text.trim())
    .map((record) => record.text)
    .reverse()
    .join('\n\n');
  return { agent: session.agent, text, path: transcriptPath(TRANSCRIPTS_DIR, session.acpSessionId), turns: carried };
}

async function sessionClose(label) {
  const session = sessionRegistry.get(label);
  if (!session) return null;
  // A session still marked active with no live job behind it is stale (for
  // example a failed registry write); it must stay closable. One being driven
  // by another live hub process is not stale: that window owns it and its jobs
  // registry, so closing it here would pull the record out from under a turn.
  const jobLive = session.jobId ? jobs.status(session.jobId)?.running === true : false;
  const foreign = isActive(session) ? foreignOwner(session) : null;
  if (foreign) {
    throw new ToolError(`${label} is ${session.state} in another hub process (pid ${foreign}); close it there or wait`);
  }
  if (isActive(session) && jobLive) {
    throw new ToolError(`${label} is ${session.state}${session.jobId ? ` (job ${session.jobId})` : ''}; job_cancel it first`);
  }
  // Nothing will drain this session again, so what still waits is recorded as
  // dropped rather than silently vanishing.
  sessionIO(() => sessionRegistry.close(label, { dropQueue: !jobLive }));
  // Close reports the checkout and whether it holds work; it never deletes
  // one, because a worktree with changes is the only copy of that work.
  const kept = session.worktree && typeof session.worktree === 'object' ? session.worktree.path : null;
  const tree = kept
    ? existsSync(kept)
      ? ` · worktree kept at ${kept} (${worktreeHasChanges(kept) ? 'has changes' : 'clean'})`
      : ` · worktree missing at ${kept}`
    : session.worktree ? ' · worktree (if any) kept; close never deletes one' : '';
  return { text: `${label}: closed${tree}` };
}

async function sessionConfig(label, patch) {
  if (!sessionRegistry.get(label)) return null;
  return sessionIO(() => sessionRegistry.upsert(label, patch));
}

async function ask(request, { signal, treeKey } = {}) {
  const placement = placeTurn(request, { selfTree: treeKey });
  // A non-write turn does not claim the tree, so a busy one is left for the
  // consent/permission gate to answer (reads may overlap by contract).
  const writeCapable = request.permission === 'allow-all' || request.permission === 'ask';
  if (placement.error || (placement.busy && writeCapable)) {
    const error = placement.error ?? busyMessage(placement.cwd);
    return {
      ok: false,
      status: 'failed',
      agent: request.agent,
      cwd: placement.cwd ?? placement.origin,
      error,
      text: error,
      tools: [],
    };
  }
  let result = null;
  let warning = null;
  let began = false;
  try {
    beginTurn(request, placement.worktree);
    began = true;
    result = await runAsk({ ...request, cwd: placement.cwd }, { signal });
    if (placement.note) result = { ...result, text: `${result.text ?? ''}\n\n${placement.note}` };
  } catch (err) {
    // Deliberately no discard here: a throw can come after the agent ran (a
    // hub-script failure), and a checkout can then hold committed work --
    // `worktreeHasChanges` only sees `git status`, not the detached commits.
    // Removing it would make that work unreachable. The checkout leaks instead;
    // it is harmless and `hubctl clean` removes it. Only the `denied`/
    // `rejected` branch below discards, because those are refused before the
    // agent starts.
    throw err;
  } finally {
    // A denied/rejected run is refused before the agent starts: the checkout
    // it was placed in holds no work and must not outlive the turn. Everything
    // else (a failure mid-turn, a timeout) keeps a checkout that may hold edits.
    const status = signal?.aborted ? 'cancelled' : (result?.ok === true ? 'ok' : result?.status);
    const outcome = turnOutcome(status);
    if (status === 'denied' || status === 'rejected') discardUntouchedCheckout(placement, request.label);
    // `began` false means beginTurn did not record a turn (a locked registry):
    // there is nothing of ours to end, and another process may own the record.
    if (began && request.label) {
      warning = finishTurn(request.label, result, outcome);
      // Prompts queued behind this turn (from background calls) start now.
      // Deferred a tick: this call still holds the tree claim until its reply is sent.
      setTimeout(() => afterTurn(request.label, outcome), 0);
    }
  }
  return warning ? { ...result, text: `${result.text}\n\n[warning: ${warning}]` } : result;
}

async function runAsk({ agent, prompt, model, mode, cwd, permission, timeoutMs, budgetUsd, effort, sessionId, label }, { signal } = {}) {

  // Free models run out mid-day and say so in an ordinary error. That is a
  // price step, not a failed task: walk the registry's fallbacks (Go models,
  // cheapest capable first) and report which one answered. An explicit `model`
  // is a decision and is never substituted -- see acp/router.mjs.
  const chain = sessionId && !model ? [] : modelChain(readAgentEntry(REGISTRY, agent), { requested: model });
  // No chain (unknown agent or bare registry): let hub-acp apply whatever the
  // registry says and report back.
  if (!chain.length) chain.push(null);
  const attempts = [];
  let result = null;

  for (const [index, candidate] of chain.entries()) {
    const { args, cwd: resolvedCwd } = hubArgsFor({
      agent,
      cwd,
      permission,
      timeoutMs,
      model: candidate,
      mode,
      budgetUsd,
      effort,
      sessionId,
      label,
    });

    result = await runHubScript(HUB_ACP, args, {
      input: prompt,
      timeoutMs: timeoutMs ?? DEFAULT_TURN_TIMEOUT_MS,
      signal,
    });
    attempts.push({
      model: result.model ?? candidate,
      status: result.status ?? (result.ok ? 'ok' : 'failed'),
    });

    if (signal?.aborted || !shouldTryNextModel(result) || index === chain.length - 1) break;
    log(`model ${candidate} is out of quota; retrying on ${chain[index + 1]}`);
  }

  return {
    ok: result.ok === true,
    status: result.status ?? (result.ok ? 'ok' : 'failed'),
    agent: result.agent ?? agent,
    cwd: cwd ? resolveCwd(cwd) : process.cwd(),
    model: result.model ?? (['denied', 'rejected'].includes(result.status) ? null : attempts.at(-1)?.model ?? null),
    modelAttempts: attempts,
    modelTrail: describeAttempts(attempts),
    sessionId: result.sessionId ?? null,
    requestedMode: result.requestedMode ?? null,
    modeSource: result.modeSource ?? null,
    reportedMode: result.reportedMode ?? null,
    modeChanged: result.modeChanged ?? false,
    stopReason: result.stopReason ?? null,
    cancelAck: result.cancelAck ?? null,
    cancelWaitMs: result.cancelWaitMs ?? null,
    durationMs: result.durationMs,
    cost: result.cost ?? null,
    text: result.text ?? '',
    tools: result.tools ?? [],
    concurrentWrite: result.concurrentWrite ?? null,
    salvage: result.salvage ?? null,
    error: result.error ?? null,
  };
}

async function fanout({ agents, prompt, synthesize, worktree, permission, effort }, { signal } = {}) {
  const args = [
    '--agents',
    agents.join(','),
    '--prompt',
    '-',
    '--json',
    '--permission',
    permission ?? 'deny',
    ...registryArgs(),
  ];
  if (synthesize) args.push('--synthesize', synthesize);
  if (worktree) args.push('--worktree');
  if (effort) args.push('--effort', effort);

  const result = await runHubScript(FANOUT_ACP, args, { input: prompt, signal });
  return {
    ok: result.ok === true,
    status: result.status ?? (result.ok ? 'ok' : 'failed'),
    cancelAck: result.cancelAck ?? null,
    okCount: result.okCount ?? 0,
    durationMs: result.durationMs,
    agents: (result.agents ?? []).map((entry) => ({
      agent: entry.agent,
      ok: entry.ok === true,
      status: entry.status ?? 'failed',
      durationMs: entry.durationMs,
      cost: entry.cost ?? null,
      text: entry.text ?? '',
      error: entry.error ?? null,
      cancelAck: entry.cancelAck ?? null,
      cancelWaitMs: entry.cancelWaitMs ?? null,
    })),
    synthesis: result.synthesis
      ? {
          agent: result.synthesis.agent,
          ok: result.synthesis.ok === true,
          text: result.synthesis.text ?? '',
          scratch: result.synthesis.scratch ?? null,
        }
      : null,
    worktrees: result.worktrees ?? [],
  };
}

async function route(prompt) {
  const stats = readRunStats();
  return decideRoute(prompt, { stats });
}

async function agents() {
  const rows = await runHubScript(HUB_ACP, ['--list', '--json', ...registryArgs()]);
  const models = defaultModels();
  return rows.map((row) => ({
    name: row.name,
    label: row.label,
    available: row.available === true,
    consent: testConsent(row.name, CONSENT_PATH),
    defaultModel: models[row.name] ?? null,
  }));
}

// Same snapshot `hubctl status` prints, reused rather than re-derived: one
// place computes it, so the MCP tool can never drift from the terminal view.
// Background jobs are appended because they only exist in this process.
async function status() {
  const text = renderStatus(await gatherStatus(), { color: false });
  const live = jobs.list();
  if (!live.length) return text;
  const lines = live.map((job) => {
    const seconds = (job.elapsedMs / 1000).toFixed(0);
    return (
      `  ${job.id} · ${job.agent} · ${job.state} · ${seconds}s` +
      (job.cwd ? ` · ${job.cwd}` : '') +
      (job.lastTool ? ` · ${job.lastTool}` : '')
    );
  });
  return `${text}\n\njobs      ${live.length} in this process\n${lines.join('\n')}`;
}

// ── background jobs ─────────────────────────────────────────────────────────
//
// A delegation that takes 20-40 minutes is not a tool call; it is a job. The
// registry keeps them in this process (its death should end its jobs, and
// `hubctl status` still shows every run through the inflight files).

// Answers sent to a hub-acp child are acknowledged over the same channel, so a
// late answer (its request already timed out) is reported instead of looking
// applied. Keyed `<jobId>:<requestId>`.
const permissionAcks = new Map();

const jobs = createJobRegistry({
  // A job walks the same model ladder a foreground ask does. The registry only
  // needs {pid, kill, promise}, so the retries live here: each attempt is its
  // own hub-acp run with its own audit line, exactly like the synchronous path.
  spawnJob: ({ args, input, meta, id, hold }) => {
    let current = null;
    let cancelled = false;
    const models = meta?.chain?.length ? meta.chain : [null];
    // The run carries its job id into results/inflight, which is how the
    // terminal view (`hubctl status`) names the same job the chat is polling.
    const env = id ? { AGENT_HUB_JOB_ID: id } : undefined;

    const promise = (async () => {
      let last = null;
      for (const [index, model] of models.entries()) {
        if (cancelled) break;
        const attemptArgs = model ? [...args, '--model', model] : args;
        current = spawnHub(HUB_ACP, attemptArgs, { input, env });
        const child = current.child;
        // The hub-acp child holds an `ask` permission and asks this process;
        // the answer goes back over the same channel. `permission-closed` is
        // the child saying it is done, so the job stops reading waiting.
        child.on('message', (message) => {
          if (message?.type === 'permission-request') {
            Promise.resolve(hold?.(message)).then((decision) => {
              try {
                child.send({
                  type: 'permission-answer',
                  requestId: message.requestId,
                  decision: decision === 'allow_once' ? 'allow_once' : 'reject',
                });
              } catch { /* the child is gone: its turn ends without an answer */ }
            }).catch(() => {});
          } else if (message?.type === 'permission-ack') {
            const waiter = permissionAcks.get(`${id}:${message.requestId}`);
            if (waiter) waiter(message.applied === true);
          } else if (message?.type === 'permission-closed') {
            jobs.closePermission(id, message.requestId);
          }
        });
        last = await current.exit.then(
          (result) => parseHubJson(result, HUB_ACP),
          (err) => ({ ok: false, status: 'failed', error: err.message }),
        );
        // The child is gone, so it cannot still be holding a permission. A hold
        // left in the map would make the job read waiting-permission forever
        // and would survive into the next attempt.
        jobs.dropPermissions(id);
        if (last.ok === true || !shouldTryNextModel(last) || index === models.length - 1) {
          return last;
        }
        log(`job model ${model} is out of quota; retrying on ${models[index + 1]}`);
      }
      return last ?? { ok: false, status: 'failed', error: 'no model attempted' };
    })();

    return {
      get pid() {
        return current?.child?.pid ?? null;
      },
      kill: () => {
        cancelled = true;
        requestStop(current?.child);
      },
      promise,
    };
  },
});

// One orchestrator per tree, whether the run is a tool call or a job: a job
// that starts on a tree somebody is already writing would be the exact
// collision the queue exists to prevent. Keys are the canonical tree identity
// (acp/consent.mjs's normalizeTree: real path, case folded on Windows), so
// `d:\x` and `D:\x` cannot pretend to be two trees. The real paths stay in
// `cwd`, `hubArgsFor` and every reply.
const activeTrees = new Map();
const markTree = (key) => {
  const tree = normalizeTree(key);
  activeTrees.set(tree, (activeTrees.get(tree) ?? 0) + 1);
};
const unmarkTree = (key) => {
  const tree = normalizeTree(key);
  const count = (activeTrees.get(tree) ?? 1) - 1;
  if (count <= 0) activeTrees.delete(tree);
  else activeTrees.set(tree, count);
};
const busyMessage = (tree) =>
  `another run is already writing to ${tree} — wait for it (see job_status / ` +
  'the status tool) or dispatch against a different tree';

// A foreground turn marks its own tree before its handler runs, so a turn
// asking about the tree must not count itself as the other writer.
function busyBesides(tree, selfTree) {
  const key = normalizeTree(tree);
  const own = selfTree && normalizeTree(selfTree) === key ? 1 : 0;
  return (activeTrees.get(key) ?? 0) - own > 0;
}

// Where a turn runs. Precedence, chosen so a session never silently changes
// tree: a kept worktree, then an explicit `worktree: true` (a fresh checkout
// for this turn, recorded so the session keeps it), then an automatic checkout
// for a write-capable turn whose tree is claimed. Everything else runs where it
// was asked to, and a non-write turn keeps today's refusal.
//
// Returns {cwd, origin, worktree, created, note, busy} or {error, origin}.
function placeTurn(request, { selfTree = null } = {}) {
  const origin = resolveCwd(request.cwd);
  const session = request.label ? sessionRegistry.get(request.label) : null;
  const kept = session?.worktree && typeof session.worktree === 'object' ? session.worktree.path : null;

  if (kept) {
    // A checkout removed by hand is an error, not an invitation to put the
    // session back on a tree another writer may hold.
    if (!existsSync(kept)) {
      return {
        error: `cannot use a worktree: ${kept} is missing (the session's checkout was removed)`,
        origin,
      };
    }
    const cwd = resolveCwd(kept);
    return { cwd, origin, worktree: cwd, created: false, note: null, busy: busyBesides(cwd, selfTree) };
  }

  const requested = request.worktree === true;
  const writeCapable = request.permission === 'allow-all' || request.permission === 'ask';
  const busy = busyBesides(origin, selfTree);
  if (!requested && !(writeCapable && busy)) {
    return { cwd: origin, origin, worktree: null, created: false, note: null, busy };
  }

  const made = ensureWorktree(origin, request.label, request.agent);
  if (!made.ok) {
    return {
      error: requested
        ? `cannot use a worktree: ${made.reason}`
        : `${busyMessage(origin)} (no worktree: ${made.reason})`,
      origin,
    };
  }
  return {
    cwd: made.path,
    origin,
    worktree: made.path,
    created: true,
    note: requested ? null : `placed in worktree ${made.path} because ${origin} is busy`,
    busy: false,
  };
}

// A checkout this turn made is removed only when the run never reached the
// agent: a consent denial or rejection happens before startup, so nothing can
// have been edited. The clean check is belt and braces; anything dirty may be
// the only copy of an edit and is always kept. The session's record is cleared
// too, or the label would be wedged on a path that no longer exists.
function discardUntouchedCheckout(placement, label = null) {
  if (!placement?.created || !placement.worktree) return;
  try {
    if (worktreeHasChanges(placement.worktree)) return;
    const info = repoInfo(placement.origin);
    if (!info || !removeWorktree(info.root, placement.worktree)) return;
  } catch {
    return;
  }
  if (!label) return;
  try {
    const session = sessionRegistry.get(label);
    if (session?.worktree?.path === placement.worktree) {
      sessionIO(() => sessionRegistry.upsert(label, { worktree: null }));
    }
  } catch (err) {
    log(`clearing the worktree of ${label}: ${err?.message ?? err}`);
  }
}

async function startJob(request) {
  const { agent, prompt, permission, timeoutMs, model, mode, budgetUsd, effort, sessionId, label } = request;
  // The tree this job runs in, which is not necessarily the one it was asked
  // for: a session's kept worktree wins, and a write-capable job on a claimed
  // tree is moved to a fresh checkout rather than refused.
  const placement = placeTurn(request);
  if (placement.error) return { error: placement.error };
  if (placement.busy) return { error: busyMessage(placement.cwd) };

  // model is left out here on purpose: spawnJob's own retry loop is the only
  // place that appends --model, once per attempt. Baking it in here too (as
  // this used to) meant a pinned model on a background job shipped --model
  // twice -- harmless by luck (hub-acp just applied the same config option
  // twice) but not something to leave in place.
  const { args, cwd: resolvedCwd } = hubArgsFor({
    agent,
    cwd: placement.cwd,
    permission,
    timeoutMs,
    model: null,
    mode,
    budgetUsd,
    effort,
    sessionId,
    label,
    save: true,
  });
  const chain = sessionId && !model ? [] : modelChain(readAgentEntry(REGISTRY, agent), { requested: model });
  beginTurn(request, placement.worktree);
  markTree(resolvedCwd);
  let job;
  try {
    job = jobs.start({
      agent,
      prompt,
      cwd: resolvedCwd,
      model,
      label,
      note: placement.note,
      args,
      meta: { chain },
      onSettled: (settled) => {
        unmarkTree(resolvedCwd);
        // hub-acp refuses a denied/rejected run before the agent starts, so a
        // checkout created for it was never touched and should not outlive it.
        if (settled?.state === 'denied' || settled?.state === 'rejected') {
          discardUntouchedCheckout(placement, label);
        }
        if (label) settleSession(label, settled);
      },
      // A held `ask` request is the person's move, not a stalled run: the
      // session shows waiting-permission until the child closes the request.
      onPermissionChange: (changed) => {
        if (!label) return;
        try {
          const current = sessionRegistry.get(label);
          if (!current || !isActive(current)) return;
          sessionIO(() => sessionRegistry.upsert(label, {
            state: changed.state === 'waiting-permission' ? 'waiting-permission' : 'running',
          }));
        } catch (err) {
          log(`session ${label} after a permission request: ${err?.message ?? err}`);
        }
      },
    });
  } catch (err) {
    if (label) endTurn(label, null);
    discardUntouchedCheckout(placement, label);
    throw err;
  }
  if (label) sessionIO(() => sessionRegistry.upsert(label, { jobId: job.id }));
  return job;
}

// Read-only views over the same files hubctl reads; neither starts an agent.
async function brief({ json }) {
  const snapshot = gatherBrief();
  return json ? JSON.stringify(snapshot, null, 2) : renderBrief(snapshot);
}

async function searchHistory({ query, since, source, limit }) {
  const db = openIndex(INDEX_PATH);
  try {
    reindex(db, { logsDir: join(STATE_DIR, 'logs'), workingDir: join(STATE_DIR, 'working'), repo: WORKSPACE_ROOT });
    const hits = searchIndex(db, query, { since, source, limit });
    if (!hits.length) return 'no matches';
    return hits
      .map((hit) => `${hit.date}  ${hit.source.padEnd(8)} ${String(hit.label).slice(0, 40)}\n    ${hit.snippet.replace(/\s+/g, ' ')}`)
      .join('\n');
  } finally {
    db.close();
  }
}

function withLiveJobDetails(job) {
  if (!job || !job.running) return job;
  const live = readInflight().find((record) => record.pid === job.pid);
  return {
    ...job,
    model: live?.model ?? job.model ?? null,
    requestedMode: live?.requestedMode ?? null,
    reportedMode: live?.reportedMode ?? null,
    modeSource: live?.modeSource ?? null,
    lastTool: job.lastTool ?? live?.lastTool ?? null,
    toolCount: job.toolCount ?? live?.toolCount ?? null,
    recentText: live?.recentText ?? null,
    pendingPermission: job.pendingPermission ?? live?.pendingPermission ?? null,
  };
}

const handlers = {
  ask,
  brief,
  search: searchHistory,
  fanout,
  route,
  agents,
  status,
  startJob,
  session: async (label) => sessionIO(() => {
    const session = sessionRegistry.get(label);
    if (!session) return null;
    return { ...session, live: sessionLive(session) };
  }),
  sessionQueue: async (label, request) => queueTurn(label, request),
  sessions,
  sessionClose,
  sessionLog,
  handoffSource,
  sessionConfig,
  // hub-acp writes results/inflight/<pid>.json while it works, so a poll can
  // report the tool in progress instead of waiting for the final answer.
  jobStatus: async (id) => withLiveJobDetails(jobs.status(id)),
  jobResult: async (id) => withLiveJobDetails(jobs.result(id)),
  // Long enough for the run to cancel its agent and write its audit line.
  jobCancel: async (id) => jobs.cancel(id, { waitMs: 12_000 }),
  // The person's answer to a request the hub held for them. Bounded wait for
  // the child's acknowledgement: "sent" for an answer the agent never saw
  // would be a lie the person acts on.
  permissionAnswer: async (id, decision, requestId) => {
    const outcome = jobs.answer(id, decision, requestId);
    if (!outcome.ok) return outcome;
    const key = `${id}:${outcome.requestId}`;
    const acknowledged = await new Promise((resolve) => {
      const timer = setTimeout(() => {
        permissionAcks.delete(key);
        resolve(false);
      }, 2000);
      timer.unref?.();
      permissionAcks.set(key, (applied) => {
        clearTimeout(timer);
        permissionAcks.delete(key);
        resolve(applied === true);
      });
    });
    return { ...outcome, acknowledged };
  },
};

// ── per-tree serialization ──────────────────────────────────────────────────
//
// Two runs that can edit the same working tree must not overlap, but two runs
// on different repos have no reason to wait for each other. This used to be one
// global promise chain, which turned four independent delegations into a queue
// four calls deep -- each of them burning its own timeout while the others
// waited.
const treeQueues = new Map();

function serializeOnTree(key, task) {
  const previous = treeQueues.get(key) ?? Promise.resolve();
  const next = previous.then(task, task);
  const tail = next.then(
    () => {},
    () => {},
  );
  treeQueues.set(key, tail);
  tail.then(() => {
    if (treeQueues.get(key) === tail) treeQueues.delete(key);
  });
  return next;
}

// null means "do not queue": reads (status, agents, route without run) are
// cheap and must never sit behind a ten-minute turn.
function queueKeyFor(message) {
  if (message?.method !== 'tools/call') return null;
  const name = message.params?.name;
  const args = message.params?.arguments ?? {};
  if (name !== 'ask_agent' && name !== 'route') return null;
  if (name === 'route' && args.run !== true) return null;
  // A background start does not run a turn here: it hands the work to a job,
  // which claims the tree itself. Queueing it would also make it see its own
  // claim and refuse to start.
  if (args.background === true) return null;
  try {
    // A labelled follow-up without a cwd runs in the session's own tree -- its
    // worktree when it has one, which is the tree its later turns really use.
    const session = typeof args.label === 'string' ? sessionRegistry.get(args.label) : null;
    const kept = session?.worktree && typeof session.worktree === 'object' ? session.worktree.path : null;
    return resolveCwd(args.cwd ?? kept ?? session?.cwd);
  } catch {
    // Let the tool itself report the bad cwd, under the default tree.
    return process.cwd();
  }
}

// ── stdio loop ──────────────────────────────────────────────────────────────

function main() {
  log(`v${SERVER_INFO.version} · registry ${REGISTRY} · consent ${CONSENT_PATH}`);

  // No job in this process survives a restart, so sessions it was driving are
  // stale -- but a session owned by another live hub process is not ours to
  // reconcile. `selfPid` keeps this window from clobbering that one's turns.
  try {
    sessionRegistry.reconcile(() => false, { selfPid: process.pid });
  } catch (err) {
    log(`session reconcile skipped: ${err?.message ?? err}`);
  }

  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

  let closed = false;

  const write = (message) => {
    if (closed) return;
    process.stdout.write(JSON.stringify(message) + '\n');
  };

  // One AbortController per tool call in flight (or queued), by request id, so
  // `notifications/cancelled` -- what a client sends when the person presses
  // stop -- reaches the run instead of being ignored while it works on.
  const calls = new Map();

  const dispatch = (message, treeKey = null) => {
    const signal = calls.get(message.id)?.signal;
    if (closed || signal?.aborted) {
      calls.delete(message.id);
      return Promise.resolve();
    }
    if (treeKey) markTree(treeKey);
    // treeKey lets a handler tell its own claim from another writer's.
    const task = handleMessage(message, handlers, { log, signal, treeKey })
      .then((response) => {
        // A cancelled request gets no response (MCP): the client stopped waiting.
        if (response && !signal?.aborted) write(response);
      })
      .catch((err) => {
        log(`fatal dispatch error: ${err?.stack ?? err}`);
      });
    void task.finally(() => {
      calls.delete(message.id);
      if (treeKey) unmarkTree(treeKey);
    });
    return task;
  };

  rl.on('line', (line) => {
    if (!line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch (err) {
      write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: `invalid JSON: ${err.message}` } });
      return;
    }
    // One write() per message keeps single-line JSON-RPC intact, so concurrent
    // replies cannot interleave; only the working tree needs a lock.
    if (message?.method === 'notifications/cancelled') {
      const call = calls.get(message.params?.requestId);
      if (call) {
        log(`request ${message.params.requestId} cancelled by the client`);
        call.abort();
      }
      return;
    }
    if (message?.method === 'tools/call' && message.id != null) calls.set(message.id, new AbortController());
    const key = queueKeyFor(message);
    if (key == null) {
      void dispatch(message);
      return;
    }
    void serializeOnTree(key, () => dispatch(message, key));
  });

  rl.on('close', async () => {
    closed = true;
    // Prevent queued requests or a routing decision still in flight from
    // starting another turn while the owned children are being stopped.
    for (const call of calls.values()) call.abort();
    const outcome = await stopHubProcesses();
    if (outcome.pending) log(`shutdown: ${outcome.pending} hub scripts did not exit; inspect inflight records`);
    process.exit(outcome.pending ? 1 : 0);
  });
}

main();
