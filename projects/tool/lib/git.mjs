// git.mjs — the one way this tool runs git.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** Run git in `repo`. Never throws: `{ ok, out }`, where `out` is stdout or the error text. */
export async function runGit(repo, args, { timeout = 60_000 } = {}) {
  try {
    const { stdout } = await run('git', ['-C', repo, ...args], {
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
      timeout,
    });
    return { ok: true, out: stdout.trim() };
  } catch (error) {
    return { ok: false, out: String(error.stderr ?? '').trim() || String(error.message) };
  }
}

/** stdout, or null when git fails (no upstream, no commits, not a repo). */
export async function git(repo, args, options) {
  const result = await runGit(repo, args, options);
  return result.ok ? result.out : null;
}
