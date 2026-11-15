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

  function start({ agent, prompt, cwd, permission, timeoutMs, model, args, meta, onSettled }) {
    const id = `job_${randomUUID().slice(0, 8)}`;
    const job = {
      id,
      agent,
      cwd,
      model: model ?? null,
      startedAt: now(),
      finishedAt: null,
      state: 'running',
      output: null,
      error: null,
      pid: null,
    };
    jobs.set(id, job);
    let child;
    try {
      child = spawnJob({ args, input: prompt, meta, id });
    } catch (err) {
      job.state = 'failed';
      job.error = err?.message ?? String(err);
      job.finishedAt = now();
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
        try {
          onSettled?.(job);
        } catch {}
        prune();
      });

    // Active jobs count toward the limit but are never evicted to satisfy it.
    prune();
    return { id, agent, cwd, pid: job.pid };
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
      model: job.output?.model ?? job.model,
      state: job.state,
      running: job.state === 'running',
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
    if (job.state !== 'running') return { ok: false, reason: `already ${job.state}` };
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
    if (job.state === 'running') {
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

  return { start, status, result, cancel, list };
}

