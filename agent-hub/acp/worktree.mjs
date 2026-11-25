// worktree.mjs — isolated git worktrees for agents that may edit files.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { stamp } from './run-record.mjs';

// --- isolated worktrees ----------------------------------------------------
// Fan-out workers share a working tree by default, so two editors can
// overwrite each other's files. `--worktree` gives each agent its own
// checkout under the repository's git dir: invisible to the working tree,
// removed with the repo, and never committed. A worktree is kept only when
// the agent left changes behind; clean ones are removed after the run.

export function safeAgentName(agent) {
  return String(agent).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'agent';
}

export function worktreePath(commonDir, runStamp, agent) {
  return join(commonDir, 'agent-worktrees', `${runStamp}-${safeAgentName(agent)}`);
}

function git(args, cwd) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  return {
    ok: result.status === 0,
    out: (result.stdout ?? '').trim(),
    err: (result.stderr ?? '').trim(),
  };
}

/**
 * Repo root plus the shared git dir. `--git-common-dir` keeps this correct
 * when the hub itself is running inside a linked worktree.
 */
export function repoInfo(cwd) {
  const top = git(['rev-parse', '--show-toplevel'], cwd);
  if (!top.ok || !top.out) return null;
  const common = git(['rev-parse', '--git-common-dir'], cwd);
  const commonDir = common.ok && common.out ? resolve(cwd, common.out) : join(top.out, '.git');
  return { root: top.out, commonDir };
}

export function createWorktree(repoRoot, path) {
  mkdirSync(dirname(path), { recursive: true });
  const result = git(['worktree', 'add', '--detach', path, 'HEAD'], repoRoot);
  if (!result.ok) throw new Error(result.err || result.out || 'git worktree add failed');
  return path;
}

/**
 * A worktree for one turn, or the reason it could not be made.
 *
 * Called from the MCP server when a writing turn arrives on a claimed tree, or
 * when the caller asked for `worktree: true`. The expected failures -- a plain
 * directory that is not a repository, `git worktree add` refusing -- are
 * answers, not exceptions: the caller still has a turn to refuse or place.
 * The label names the checkout so two turns of one agent are told apart, and
 * the attempt loop covers two turns created in the same second.
 */
export function ensureWorktree(cwd, label, agent) {
  const base = resolve(cwd ?? process.cwd());
  const info = repoInfo(base);
  if (!info) return { ok: false, reason: `${base} is not inside a git repository` };
  const name = label ? `${agent}-${label}` : String(agent);
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const suffix = attempt === 0 ? '' : `-${attempt + 1}`;
    const path = worktreePath(info.commonDir, `${stamp()}${suffix}`, name);
    try {
      createWorktree(info.root, path);
      return { ok: true, path };
    } catch (err) {
      // An existing directory is the collision this loop exists for; any other
      // failure (permissions, a repository with no HEAD) is final.
      if (existsSync(path)) continue;
      return { ok: false, reason: err?.message ?? 'git worktree add failed' };
    }
  }
  return { ok: false, reason: `no free worktree name under ${info.commonDir}` };
}

/** True when the worktree has changes that must not be discarded. */
export function worktreeHasChanges(path) {
  const result = git(['status', '--porcelain'], path);
  return !result.ok || result.out.length > 0;
}

export function removeWorktree(repoRoot, path) {
  return git(['worktree', 'remove', '--force', path], repoRoot).ok;
}
