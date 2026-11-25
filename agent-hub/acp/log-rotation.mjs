// log-rotation.mjs — keep an append-only JSONL log from growing forever.
//
// Rotation, not deletion: once the live file would cross maxBytes, it is
// renamed to "<base>-<timestamp>.jsonl" and the caller starts a fresh file
// at the original path. Nothing is thrown away or compressed, so every
// existing reader (router.mjs's readRunStats, hubctl, grep) keeps working
// unmodified on both the live file and any archived one.
//
// Checked once per write, not on a timer: a personal, bursty workload has no
// "idle" moment to rotate in, and a stat() before an append is cheap.

import { existsSync, renameSync, statSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';

export const DEFAULT_MAX_BYTES = 10 * 1024 * 1024; // 10 MB

/** Deterministic down to the second, so two rotations in the same run never collide. */
export function archivedPath(path, now = new Date()) {
  const ext = extname(path);
  const base = basename(path, ext);
  const stamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return join(dirname(path), `${base}-${stamp}${ext}`);
}

/**
 * Rotate `path` if it exists and is already at least `maxBytes`. Returns the
 * archived path, or null when no rotation happened (missing file, under the
 * threshold, or an unreadable stat). Safe to call before every append.
 */
export function rotateIfNeeded(path, { maxBytes = DEFAULT_MAX_BYTES, now = new Date() } = {}) {
  if (!existsSync(path)) return null;
  let size;
  try {
    size = statSync(path).size;
  } catch {
    return null;
  }
  if (size < maxBytes) return null;

  let target = archivedPath(path, now);
  // Same machine, same second, two different log files rotating -- vanishingly
  // rare, but a silent overwrite would lose a log instead of just being ugly.
  let suffix = 1;
  while (existsSync(target)) {
    target = archivedPath(path, now).replace(/(\.[^.]*)$/, `-${suffix++}$1`);
  }
  renameSync(path, target);
  return target;
}
