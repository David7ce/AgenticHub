// tree-lock.mjs — claim a tree before write-permission hub runs start.
//
// This does NOT enforce "one orchestrator per tree" in general: an agent (or
// any other tool outside this hub) does not know this file exists, so it can
// still collide silently with a hub run. What this catches is the collision
// the hub can actually see coming -- two of its own allow-all runs (e.g. two
// `ask_agent` calls from two different chat sessions) landing on the same
// non-worktree cwd at the same time, which is exactly the gotcha
// agent-hub/README.md already names: "Workers run with write access in the
// repo ... pass --worktree before letting parallel workers edit."
//
// Conflicts reject in hub-acp.mjs unless explicitly overridden by the caller.
//
// Scope: only a run with permission "allow-all" should call this. A worktree
// run never needs it -- it already has an exclusive checkout.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

// Only malformed records expire by age; live holders retain their claims.
export const STALE_MS = 30 * 60 * 1000;

export function lockPathFor(locksDir, cwd) {
  const key = String(cwd).replace(/[\\/:]+/g, '_').replace(/^_+/, '');
  return join(locksDir, `${key}.lock`);
}

function isAlive(pid) {
  if (!Number.isInteger(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but belongs to someone else -- still
    // alive, just not ours to signal. Any other error means it is gone.
    return err.code === 'EPERM';
  }
}

function readHolder(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Claim the lock for `cwd`, or report who already holds it.
 * Returns { ok: true, path } on success, { ok: false, holder } otherwise.
 * `holder` may be null when the lock file exists but could not be parsed.
 */
export function acquireTreeLock(locksDir, cwd, { agent, pid = process.pid, now = Date.now() } = {}) {
  const path = lockPathFor(locksDir, cwd);
  if (existsSync(path)) {
    const holder = readHolder(path);
    const stale = holder ? !isAlive(holder.pid) : now - statSync(path).mtimeMs > STALE_MS;
    if (!stale) return { ok: false, holder };
    rmSync(path, { force: true });
  }
  mkdirSync(dirname(path), { recursive: true });
  try {
    writeFileSync(path, JSON.stringify({ agent, pid, cwd, startedAt: now }), { encoding: 'utf8', flag: 'wx' });
  } catch (error) {
    if (error.code === 'EEXIST') return { ok: false, holder: readHolder(path) };
    throw error;
  }
  return { ok: true, path };
}

/** Release the lock, but only if this process is still the one holding it. */
export function releaseTreeLock(locksDir, cwd, pid = process.pid) {
  const path = lockPathFor(locksDir, cwd);
  if (!existsSync(path)) return;
  const holder = readHolder(path);
  if (holder && holder.pid !== pid) return; // staleness already gave it to someone else
  rmSync(path, { force: true });
}
