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


import { join } from 'node:path';
import { createInterface } from 'node:readline';

import { handleMessage, SERVER_INFO } from './core.mjs';
import { createJobRegistry } from './jobs.mjs';
import {
  decideRoute,
  describeAttempts,
  modelChain,
  readAgentEntry,
  readRunStats,
  shouldTryNextModel,
} from '../acp/router.mjs';
import { CONSENT_PATH, testConsent } from '../acp/consent.mjs';
import { gatherBrief, renderBrief } from '../hubctl/commands/brief.mjs';
import { ROOT as WORKSPACE_ROOT, STATE_DIR, INDEX_PATH } from '../hubctl/common.mjs';
import { openIndex, reindex, search as searchIndex } from '../hubctl/search.mjs';
import { gatherStatus, readInflight, renderStatus } from '../hubctl/hubctl.mjs';

import {
  HUB_ACP, FANOUT_ACP, REGISTRY, DEFAULT_TURN_TIMEOUT_MS, log, spawnHub, parseHubJson, runHubScript, registryArgs, defaultModels, resolveCwd, hubArgsFor, requestStop,
} from './hub-process.mjs';


async function ask({ agent, prompt, model, cwd, permission, timeoutMs, budgetUsd, effort, sessionId }, { signal } = {}) {

  // Free models run out mid-day and say so in an ordinary error. That is a
  // price step, not a failed task: walk the registry's fallbacks (Go models,
  // cheapest capable first) and report which one answered. An explicit `model`
  // is a decision and is never substituted -- see acp/router.mjs.
  const chain = modelChain(readAgentEntry(REGISTRY, agent), { requested: model });
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
      budgetUsd,
      effort,
      sessionId,
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
    model: result.model ?? chain[chain.length - 1] ?? null,
    modelAttempts: attempts,
    modelTrail: describeAttempts(attempts),
    sessionId: result.sessionId ?? null,
    stopReason: result.stopReason ?? null,
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
    })),
    synthesis: result.synthesis
      ? {
          agent: result.synthesis.agent,
          ok: result.synthesis.ok === true,
          text: result.synthesis.text ?? '',
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

const jobs = createJobRegistry({
  // A job walks the same model ladder a foreground ask does. The registry only
  // needs {pid, kill, promise}, so the retries live here: each attempt is its
  // own hub-acp run with its own audit line, exactly like the synchronous path.
  spawnJob: ({ args, input, meta, id }) => {
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
        last = await current.exit.then(
          (result) => parseHubJson(result, HUB_ACP),
          (err) => ({ ok: false, status: 'failed', error: err.message }),
        );
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
// collision the queue exists to prevent.
const activeTrees = new Map();
const markTree = (key) => activeTrees.set(key, (activeTrees.get(key) ?? 0) + 1);
const unmarkTree = (key) => {
  const count = (activeTrees.get(key) ?? 1) - 1;
  if (count <= 0) activeTrees.delete(key);
  else activeTrees.set(key, count);
};
const treeBusy = (key) => activeTrees.has(key);

async function startJob(request) {
  const { agent, prompt, cwd, permission, timeoutMs, model, budgetUsd, effort, sessionId } = request;
  // model is left out here on purpose: spawnJob's own retry loop is the only
  // place that appends --model, once per attempt. Baking it in here too (as
  // this used to) meant a pinned model on a background job shipped --model
  // twice -- harmless by luck (hub-acp just applied the same config option
  // twice) but not something to leave in place.
  const { args, cwd: resolvedCwd } = hubArgsFor({
    agent,
    cwd,
    permission,
    timeoutMs,
    model: null,
    budgetUsd,
    effort,
    sessionId,
    save: true,
  });
  const chain = modelChain(readAgentEntry(REGISTRY, agent), { requested: model });
  if (treeBusy(resolvedCwd)) {
    return {
      error:
        `another run is already writing to ${resolvedCwd} — wait for it (see job_status / ` +
        'the status tool) or dispatch against a different tree',
    };
  }
  markTree(resolvedCwd);
  return jobs.start({
    agent,
    prompt,
    cwd: resolvedCwd,
    model,
    args,
    meta: { chain },
    onSettled: () => unmarkTree(resolvedCwd),
  });
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

const handlers = {
  ask,
  brief,
  search: searchHistory,
  fanout,
  route,
  agents,
  status,
  startJob,
  // hub-acp writes results/inflight/<pid>.json while it works, so a poll can
  // report the tool in progress instead of waiting for the final answer.
  jobStatus: async (id) => {
    const job = jobs.status(id);
    if (!job) return null;
    if (!job.running) return job;
    const live = readInflight().find((record) => record.pid === job.pid);
    return live
      ? {
          ...job,
          model: job.model ?? live.model ?? null,
          lastTool: job.lastTool ?? live.lastTool ?? null,
          toolCount: job.toolCount ?? live.toolCount ?? null,
        }
      : job;
  },
  jobResult: async (id) => jobs.result(id),
  // Long enough for the run to cancel its agent and write its audit line.
  jobCancel: async (id) => jobs.cancel(id, { waitMs: 12_000 }),
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
    return resolveCwd(args.cwd);
  } catch {
    // Let the tool itself report the bad cwd, under the default tree.
    return process.cwd();
  }
}

// ── stdio loop ──────────────────────────────────────────────────────────────

function main() {
  log(`v${SERVER_INFO.version} · registry ${REGISTRY} · consent ${CONSENT_PATH}`);

  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

  let closed = false;
  const inFlight = new Set();

  const write = (message) => {
    if (closed) return;
    process.stdout.write(JSON.stringify(message) + '\n');
  };

  // One AbortController per tool call in flight (or queued), by request id, so
  // `notifications/cancelled` -- what a client sends when the person presses
  // stop -- reaches the run instead of being ignored while it works on.
  const calls = new Map();

  const dispatch = (message, treeKey = null) => {
    if (treeKey) markTree(treeKey);
    const signal = calls.get(message.id)?.signal;
    const task = handleMessage(message, handlers, { log, signal })
      .then((response) => {
        // A cancelled request gets no response (MCP): the client stopped waiting.
        if (response && !signal?.aborted) write(response);
      })
      .catch((err) => {
        log(`fatal dispatch error: ${err?.stack ?? err}`);
      });
    inFlight.add(task);
    void task.finally(() => {
      inFlight.delete(task);
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
    // A client that hangs up mid-turn (Stop in the chat) used to leave its runs
    // dangling with no trace. Let them finish if they are close, then leave --
    // the hub-acp children keep going on their own and now show up in
    // `hubctl status` as running, so nothing is invisible either way.
    const pending = [...inFlight];
    if (pending.length) {
      await Promise.race([
        Promise.allSettled(pending),
        new Promise((resolve) => setTimeout(resolve, 5000)),
      ]);
    }
    closed = true;
    process.exit(0);
  });
}

main();

