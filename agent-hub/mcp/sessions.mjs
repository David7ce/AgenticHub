// Durable registry of named agent sessions. Standalone: its only I/O is its
// own JSON file (atomic tmp+rename). Every mutation re-reads the file first so
// two registry instances (e.g. two OpenCode windows) never lose each other's
// writes.
import {
  closeSync, copyFileSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname } from 'node:path';

import { redact } from '../acp/redact.mjs';

const LABEL_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;
const MAX_TEXT = 4000;
const ACTIVE = new Set(['running', 'waiting-permission']);

export function validLabel(label) {
  return typeof label === 'string' && LABEL_RE.test(label);
}

// Is the process behind `pid` still running? `process.kill(pid, 0)` only probes:
// ESRCH means gone, EPERM means alive but not ours. Own pid is trivially alive.
export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

// A session being driven by another live hub process belongs to that window:
// this one must neither reconcile it away nor close it. Returns the foreign
// owner's pid, or null when the owner is this process, absent, or gone.
export function foreignOwner(session, selfPid = process.pid) {
  const pid = session?.ownerPid;
  if (!pid || pid === selfPid) return null;
  return pidAlive(pid) ? pid : null;
}

function clean(text) {
  return redact(String(text ?? '').slice(0, MAX_TEXT));
}

// queued/dropped entries are prompt strings, or { prompt, ...options } objects
// (options travel with the prompt that asked for them); only the text is cleaned.
function cleanEntry(entry) {
  if (entry && typeof entry === 'object') return { ...entry, prompt: clean(entry.prompt) };
  return clean(entry);
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function createSessionRegistry({ path, now = () => Date.now() }) {
  function load() {
    let raw;
    try {
      raw = readFileSync(path, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return {};
      throw err;
    }
    try {
      const data = JSON.parse(raw);
      if (data && typeof data === 'object' && !Array.isArray(data)) return data;
      throw new Error('not an object');
    } catch {
      try {
        copyFileSync(path, `${path}.bad`);
      } catch {
        /* best effort */
      }
      return {};
    }
  }

  function save(data) {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 2));
    let lastErr;
    for (let i = 0; i < 8; i++) {
      try {
        renameSync(tmp, path);
        return;
      } catch (err) {
        lastErr = err;
        if (err.code !== 'EPERM' && err.code !== 'EBUSY' && err.code !== 'EACCES') break;
        sleepSync(10 * (i + 1));
      }
    }
    try {
      unlinkSync(tmp);
    } catch {
      /* best effort */
    }
    throw lastErr;
  }

  // Cross-process exclusive lock around every load-modify-save.
  function withLock(fn) {
    mkdirSync(dirname(path), { recursive: true });
    const lock = `${path}.lock`;
    const deadline = Date.now() + 2000;
    let fd;
    for (let delay = 2; ; delay = Math.min(delay * 2, 50)) {
      try {
        fd = openSync(lock, 'wx');
        break;
      } catch (err) {
        if (err.code !== 'EEXIST' && err.code !== 'EPERM' && err.code !== 'EACCES') throw err;
        try {
          if (Date.now() - statSync(lock).mtimeMs > 10000) {
            unlinkSync(lock);
            continue;
          }
        } catch {
          continue; // lock vanished; retry immediately
        }
        if (Date.now() >= deadline) throw new Error(`session registry is locked: ${path}`);
        sleepSync(delay);
      }
    }
    try {
      return fn();
    } finally {
      closeSync(fd);
      try {
        unlinkSync(lock);
      } catch {
        /* already gone */
      }
    }
  }

  const get = (label) => load()[label] ?? null;

  function upsert(label, patch = {}) {
    if (!validLabel(label)) throw new Error(`invalid session label: ${label}`);
    return withLock(() => upsertLocked(label, patch));
  }

  function upsertLocked(label, patch) {
    const data = load();
    let s = data[label];
    if (!s) {
      if (!patch.agent) throw new Error('creating a session requires agent');
      if (!patch.cwd) throw new Error('creating a session requires cwd');
      const t = now();
      s = {
        label,
        agent: patch.agent,
        acpSessionId: null,
        cwd: patch.cwd,
        worktree: null,
        model: null,
        effort: null,
        state: 'idle',
        resumable: null,
        createdAt: t,
        lastActivity: t,
        spendUsd: 0,
        jobId: null,
        lastTurn: null,
        ownerPid: null,
        queued: [],
        dropped: [],
      };
    }
    const next = { ...s, ...patch, label, createdAt: s.createdAt, lastActivity: now() };
    if (patch.queued) next.queued = patch.queued.map(cleanEntry);
    if (patch.dropped) next.dropped = patch.dropped.map(cleanEntry);
    data[label] = next;
    save(data);
    return next;
  }

  function list({ agent, state } = {}) {
    return Object.values(load())
      .filter((s) => (!agent || s.agent === agent) && (!state || s.state === state))
      .sort((a, b) => b.lastActivity - a.lastActivity);
  }

  // `dropQueue` records prompts still waiting as dropped: a closed session will
  // never drain them, and losing them silently would hide what was asked.
  function close(label, { dropQueue = false } = {}) {
    return withLock(() => {
      const s = get(label);
      if (!s) return null;
      return upsertLocked(label, {
        state: 'closed',
        ...(dropQueue ? { queued: [], dropped: [...(s.dropped ?? []), ...(s.queued ?? [])] } : {}),
      });
    });
  }

  // `selfPid` is the process asking: a session owned by any other live pid is
  // still being driven there, even though its job is invisible here.
  function reconcile(isJobLive, { selfPid = null } = {}) {
    return withLock(() => reconcileLocked(isJobLive, selfPid));
  }

  function reconcileLocked(isJobLive, selfPid) {
    const data = load();
    const changed = [];
    for (const s of Object.values(data)) {
      if (!ACTIVE.has(s.state) || (s.jobId && isJobLive(s.jobId))) continue;
      // Another hub process started this turn; its jobs registry is not ours.
      if (s.ownerPid && s.ownerPid !== selfPid && pidAlive(s.ownerPid)) continue;
      Object.assign(s, {
        state: 'idle',
        lastTurn: 'cancelled',
        jobId: null,
        dropped: [...(s.dropped ?? []), ...(s.queued ?? [])],
        queued: [],
        lastActivity: now(),
      });
      changed.push(s);
    }
    if (changed.length) save(data);
    return changed;
  }

  return { get, upsert, list, close, reconcile };
}
