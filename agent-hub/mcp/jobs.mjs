// jobs.mjs — delegations that outlive the tool call that started them.
//
// The MCP surface is request/response: a tool call that takes 40 minutes is a
// 40-minute blocked chat, and clients give up long before that (600 s in the
// 2026-11-03 case, which turned four delegations into a deadlock). A job is the
// same hub-acp run, started detached: `ask_agent({background: true})` returns an
// id immediately, and `job_status`/`job_result` read it later.
//
// The registry is in memory on purpose — it belongs to the MCP server process,
// which is the thing whose death should end its jobs — while `job_status` also
// reads the run's inflight file for the last tool, so progress keeps coming
// from hub-acp itself rather than being re-derived here.

import { randomUUID } from 'node:crypto';

const DEFAULT_LIMIT = 20;
const DEFAULT_TTL_MS = 60 * 60 * 1000;

/**
 * @param spawnJob ({args, input}) => { pid, promise, kill } — injectable so the
 *   registry can be tested without a real child process.
 */
export function createJobRegistry({ spawnJob, now = () => Date.now(), limit = DEFAULT_LIMIT, ttlMs = DEFAULT_TTL_MS }) {
  if (typeof spawnJob !== 'function') throw new Error('createJobRegistry needs a spawnJob function');
  const jobs = new Map();

  const prune = () => {
    const done = [...jobs.values()]
      // An unacknowledged cancellation changes state before the child exits.
      // Keep its controller and eventual answer until settlement clears kill.
      .filter((job) => job.finishedAt !== null && job.kill === null)
      .sort((a, b) => (a.finishedAt ?? a.startedAt) - (b.finishedAt ?? b.startedAt));
    const cutoff = now() - ttlMs;
    for (const job of done) {
      if ((job.finishedAt ?? job.startedAt) < cutoff) jobs.delete(job.id);
    }
    for (const job of done) {
      if (jobs.size <= limit) break;
      jobs.delete(job.id);
    }
  };

  function start({ agent, prompt, cwd, permission, timeoutMs, model, args, meta, onSettled, label, onPermissionChange, note = null }) {
    const id = `job_${randomUUID().slice(0, 8)}`;
    const job = {
      id,
      agent,
      cwd,
      model: model ?? null,
      label: label ?? null,
      // Where the turn was moved, when the caller did not choose the tree:
      // the start reply and every later view must keep saying so.
      note,
      startedAt: now(),
      finishedAt: null,
      state: 'running',
      output: null,
      error: null,
      pid: null,
      // Permissions the agent is holding mid-turn: the job is alive, but it is
      // the person's move. An agent can hold more than one at once, so this is
      // a map by request id; `answer` releases one, closePermission is the
      // child saying it is done with it (answered, timed out, cancelled).
      pending: new Map(),
      onPermissionChange: null,
    };
    job.onPermissionChange = onPermissionChange ?? null;
    const hold = (request) => new Promise((resolve) => {
      // The turn is already over (cancelled, failed or finished): an approval
      // could not apply to anything, and surfacing it would reopen a job the
      // person just stopped.
      if (job.state === 'cancelled' || job.finishedAt !== null) {
        resolve('reject');
        return;
      }
      const requestId = request?.requestId ?? `req_${job.pending.size + 1}`;
      job.pending.set(requestId, {
        resolve,
        heldSince: now(),
        resolved: false,
        info: {
          requestId,
          title: request?.title ?? 'tool call',
          toolKind: request?.toolKind ?? 'other',
          locations: Array.isArray(request?.locations) ? request.locations : [],
        },
      });
      job.state = 'waiting-permission';
      try { job.onPermissionChange?.(job); } catch {}
    });
    jobs.set(id, job);
    let child;
    try {
      child = spawnJob({ args, input: prompt, meta, id, hold });
    } catch (err) {
      job.state = 'failed';
      job.error = err?.message ?? String(err);
      job.finishedAt = now();
      job.pending.clear();
      jobs.delete(id);
      // The caller reserved the tree before starting. Release it even when
      // no child or promise was created, then preserve the original error.
      try { onSettled?.(job); } catch {}
      throw err;
    }
    // Keep the controller: a job that walks a model chain changes pid, so the
    // pid has to be read lazily rather than snapshotted here.
    job.controller = child;
    job.pid = child.pid ?? null;
    job.kill = child.kill;

    job.settled = child.promise
      .then((result) => {
        job.output = result;
        job.state = result?.ok === true ? 'ok' : (result?.status ?? 'failed');
      })
      .catch((err) => {
        job.error = err?.message ?? String(err);
        job.state = 'failed';
      })
      .finally(() => {
        job.finishedAt = now();
        job.kill = null;
        job.pending.clear();
        try {
          onSettled?.(job);
        } catch {}
        prune();
      });

    // Active jobs count toward the limit but are never evicted to satisfy it.
    prune();
    return { id, agent, cwd, note, pid: job.pid };
  }

  function get(id) {
    return jobs.get(id) ?? null;
  }

  function describe(job) {
    const endedAt = job.finishedAt ?? now();
    return {
      id: job.id,
      agent: job.agent,
      cwd: job.cwd,
      note: job.note,
      sessionLabel: job.label,
      model: job.output?.model ?? job.model,
      requestedMode: job.output?.requestedMode ?? null,
      reportedMode: job.output?.reportedMode ?? null,
      modeSource: job.output?.modeSource ?? null,
      cancelAck: job.output?.cancelAck ?? null,
      state: job.state,
      running: job.state === 'running' || job.state === 'waiting-permission',
      pendingPermission: job.pending.size
        ? (() => {
            const [entry] = job.pending.values();
            return { ...entry.info, heldMs: Math.max(0, now() - entry.heldSince) };
          })()
        : null,
      pendingPermissionCount: job.pending.size,
      elapsedMs: endedAt - job.startedAt,
      pid: job.controller?.pid ?? job.pid,
      error: job.output?.error ?? job.error ?? null,
      toolCount: Array.isArray(job.output?.tools) ? job.output.tools.length : null,
      lastTool: Array.isArray(job.output?.tools) && job.output.tools.length
        ? job.output.tools[job.output.tools.length - 1]?.title ?? null
        : null,
    };
  }

  function status(id) {
    const job = get(id);
    return job ? describe(job) : null;
  }

  function result(id) {
    const job = get(id);
    if (!job) return null;
    return { ...describe(job), answer: job.state === 'running' ? null : job.output ?? null };
  }

  // Killing the wrapper is not proof the work stopped (2026-11-03: an OpenCode
  // session lived on in its daemon for ten minutes). Wait, bounded, for the
  // child to actually exit and say whether it did.
  async function cancel(id, { waitMs = 3000 } = {}) {
    const job = get(id);
    if (!job) return { ok: false, reason: 'unknown job' };
    if (job.state !== 'running' && job.state !== 'waiting-permission') {
      return { ok: false, reason: `already ${job.state}` };
    }
    try {
      job.kill?.();
    } catch {}
    let timer;
    const timedOut = new Promise((resolve) => {
      // Deliberately not unref'd: this timer is the only thing that can answer
      // the race below. Unref'd, Node 22 can consider the loop done while
      // `cancel()` is still awaiting a job that never settles, and the caller
      // gets "Promise resolution is still pending" instead of ack:false.
      timer = setTimeout(() => resolve(false), waitMs);
    });
    const exited = await Promise.race([
      Promise.resolve(job.settled).then(() => true, () => true),
      timedOut,
    ]);
    clearTimeout(timer);
    // An exited wrapper is not proof its daemon-backed agent ended the turn.
    const acknowledged = exited && job.output?.cancelAck !== false && !job.error;
    if (job.state === 'running' || job.state === 'waiting-permission') {
      job.state = 'cancelled';
      job.finishedAt = now();
    }
    return {
      ok: true,
      ack: acknowledged,
      state: job.state,
      detail: acknowledged
        ? 'the callee stopped'
        : exited
          ? 'the process exited, but the agent did not confirm cancellation — its tree may still be changing'
          : 'cancel sent, but the process has not exited — its tree may still be changing',
    };
  }

  function list() {
    return [...jobs.values()].map(describe).sort((a, b) => b.elapsedMs - a.elapsedMs);
  }

  // Release one held request with the person's answer. The answer is resolved
  // here; whoever owns the child process sends it over IPC, and the child's
  // `permission-closed` message is what clears the entry. `requestId` is
  // optional but, when given, the answer can only land on that request -- an
  // answer read from a job_status a moment ago must never hit a later request.
  function answer(id, decision, requestId) {
    const job = get(id);
    if (!job) return { ok: false, reason: 'unknown job' };
    // A cancelled job's turn is over: an approval could not apply to anything,
    // and reporting "sent" would leave the person waiting on an ack that cannot
    // arrive. A request that was held when the cancel landed is still in the
    // map until the child exits, so state is the only honest signal here.
    if (job.state === 'cancelled') {
      return { ok: false, reason: `no pending permission request for ${id}` };
    }
    // The request id is not optional: an answer must name the request the
    // person actually read, or an answer read a moment ago would pass itself
    // to whatever request arrived next.
    if (!requestId) return { ok: false, reason: `requestId is required to answer ${id} (job_status shows it)` };
    const entry = job.pending.get(String(requestId));
    if (!entry || entry.resolved) {
      return {
        ok: false,
        reason: `no pending permission request for ${id} (${requestId})`,
      };
    }
    entry.resolved = true;
    const answerText = decision === 'allow_once' ? 'allow_once' : 'reject';
    entry.resolve(answerText);
    return { ok: true, requestId: entry.info.requestId, decision: answerText };
  }

  // The child is done with one request (answered, timed out, or the turn was
  // stopped). The job is running again only once nothing is held.
  function closePermission(id, requestId) {
    const job = get(id);
    if (!job || !job.pending.size) return false;
    if (requestId && !job.pending.has(requestId)) return false;
    const key = requestId ?? [...job.pending.keys()][0];
    job.pending.delete(key);
    if (!job.pending.size && job.state === 'waiting-permission') {
      job.state = 'running';
      try { job.onPermissionChange?.(job); } catch {}
    }
    return true;
  }

  // The child that held these requests is gone -- a model retry, not a person's
  // decision. Resolving them as `reject` means the waiting turn ends instead of
  // a hold surviving into an attempt that can never answer it. Returns how many
  // were dropped.
  function dropPermissions(id) {
    const job = get(id);
    if (!job || !job.pending.size) return 0;
    const dropped = job.pending.size;
    for (const entry of job.pending.values()) {
      entry.resolved = true;
      entry.resolve('reject');
    }
    job.pending.clear();
    if (job.state === 'waiting-permission') {
      job.state = 'running';
      try { job.onPermissionChange?.(job); } catch {}
    }
    return dropped;
  }

  return { start, status, result, cancel, list, answer, closePermission, dropPermissions };
}
