// scan.mjs — find every git repo under the root and describe it.
//
// Read-only by construction: status, diff, ls-files, log, rev-list, branch,
// stash list and remote get-url. It never fetches or writes.

import { existsSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

import { ACCOUNTS, AI_PROVIDERS, classifyCommit } from './accounts.mjs';
import { git } from './git.mjs';
import { GITHUB_USER, OVERRIDES, readExclusions } from './local.mjs';
import { resolveRoot, toWindowsPath } from './paths.mjs';
import { mapPool } from './pool.mjs';
import { resolveRemote, sanitizeRemote } from './remote.mjs';

export const DEFAULT_DEPTH = 6;
export const GIT_FORK = 'Git Fork';
export const GIT_CLONE = 'Git Clone';
// The folder for upstream clones; renamed Git-forks -> Git-clones on 2026-11-19, both accepted.
const FORK_FOLDER = /^git[-_](forks|clones)$/i;
const DATE_FORMAT = '--date=format-local:%Y-%m-%d %H:%M';

/** Every git working tree under `root`. Nested repos are found; `.git` and `node_modules` are pruned. */
export function findRepos(root, depth = DEFAULT_DEPTH) {
  const found = [];
  const walk = (dir, level) => {
    if (level > depth) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // unreadable folder: skip it
    }
    if (entries.some((entry) => entry.name === '.git')) found.push(dir);
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink?.()) continue;
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      walk(join(dir, entry.name), level + 1);
    }
  };
  walk(root, 1);
  return found;
}

/** Drop exact root-relative paths; another clone with the same name stays. */
export function filterExcludedRepos(repos, root, exclusions, caseInsensitive = process.platform === 'win32') {
  const normalize = (path) => {
    const value = path.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
    return caseInsensitive ? value.toLowerCase() : value;
  };
  const excluded = new Set(exclusions.map(normalize));
  return repos.filter((repo) => !excluded.has(normalize(relative(root, repo))));
}

/**
 * Real changes only. WSL's DrvFs makes every file look 755 and a CRLF checkout
 * of LF blobs is not an edit, so both are ignored. Staged and untracked count.
 */
async function worktreeChanges(repo) {
  const changed = new Set();
  for (const args of [
    ['-c', 'core.filemode=false', 'diff', '--ignore-cr-at-eol', '--name-only'],
    ['-c', 'core.filemode=false', 'diff', '--cached', '--ignore-cr-at-eol', '--name-only'],
    ['ls-files', '--others', '--exclude-standard'],
  ]) {
    for (const line of ((await git(repo, args)) ?? '').split('\n')) if (line) changed.add(line);
  }
  return changed.size;
}

/**
 * Branch, upstream, ahead/behind and dirty count. One `status --porcelain=v2`
 * answers all of it; the exact diff commands run only when it reports a change,
 * because status still counts CRLF/filemode noise. `sync` calls this live.
 */
export async function readState(repo) {
  const out = await git(repo, ['-c', 'core.filemode=false', 'status', '--porcelain=v2', '--branch']);
  if (out === null) return null;

  const state = { branch: null, upstream: null, ahead: 0, behind: 0, dirty: 0 };
  let touched = false;
  for (const line of out.split('\n')) {
    if (line.startsWith('# branch.head ')) state.branch = line.slice('# branch.head '.length).trim();
    else if (line.startsWith('# branch.upstream ')) state.upstream = line.slice('# branch.upstream '.length).trim();
    else if (line.startsWith('# branch.ab ')) {
      const counts = line.match(/\+(\d+)\s+-(\d+)/);
      if (counts) [state.ahead, state.behind] = [Number(counts[1]), Number(counts[2])];
    } else if (line && !line.startsWith('#')) touched = true;
  }
  if (!state.branch) return null; // bare, broken, or not a working tree
  if (touched) state.dirty = await worktreeChanges(repo);
  return state;
}

/**
 * Work that status cannot see: stashes, and local branches not in HEAD whose
 * commits are on no remote. A branch level with its own upstream does not count.
 */
async function hiddenWork(repo) {
  const [stashList, unmerged] = await Promise.all([
    git(repo, ['stash', 'list']),
    git(repo, ['branch', '--no-merged', 'HEAD', '--format=%(refname:short)']),
  ]);
  const otherBranches = [];
  for (const branch of (unmerged ?? '').split('\n').filter(Boolean)) {
    const upstream = await git(repo, ['rev-parse', '--abbrev-ref', `${branch}@{u}`]);
    if (!upstream || Number(await git(repo, ['rev-list', '--count', `${upstream}..${branch}`])) > 0) {
      otherBranches.push(branch);
    }
  }
  return { stashes: (stashList ?? '').split('\n').filter(Boolean).length, otherBranches };
}

/**
 * One `git log` per repo, read three ways: `{ days }` for this machine's commits
 * (the calendar), `{ accounts }` per signed account and `{ ai }` per provider
 * that authored or co-authored a commit. Each is `{ key: { "YYYY-MM-DD": n } }`.
 */
async function commitActivity(repo) {
  const out = await git(repo, [
    'log', '--format=%ae%x09%an%x09%ad%x09%(trailers:key=Co-authored-by,valueonly,separator=%x1f)', '--date=short',
  ], { timeout: 120_000 });
  const days = {};
  const accounts = {};
  const ai = {};
  const accountAi = {};
  const bump = (grouped, key, date) => {
    const group = (grouped[key] = grouped[key] ?? {});
    group[date] = (group[date] ?? 0) + 1;
  };
  for (const line of (out ?? '').split('\n')) {
    if (!line) continue;
    const [email, name, date, trailers] = line.split('\t');
    if (!date) continue;
    const hit = classifyCommit({ name, email, trailers });
    if (hit.owner) days[date] = (days[date] ?? 0) + 1;
    if (hit.account) {
      bump(accounts, hit.account, date);
      // The same commit can list two providers (say, Claude and Copilot); each
      // counts once for that account, so the per-account lines stay readable.
      for (const provider of hit.ai) bump(accountAi, hit.account + '\u001f' + provider, date);
    }
    for (const provider of hit.ai) bump(ai, provider, date);
  }
  return { days, accounts, ai, accountAi };
}

const prettify = (value) => String(value ?? '')
  .replace(/[-_]+/g, ' ')
  .split(/\s+/)
  .filter(Boolean)
  .map((word) => word[0].toUpperCase() + word.slice(1))
  .join(' ');

const normalizeName = (value) => String(value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

function webAccount(webUrl) {
  try {
    return new URL(webUrl).pathname.split('/').filter(Boolean)[0] || null;
  } catch {
    return null;
  }
}

/** One repo -> `{ row, days, accounts, ai }`, or null when it is not a usable working tree. */
async function describe(repo, root) {
  const [state, hidden, remoteRaw, roots, lastCommit, commits, activity] = await Promise.all([
    readState(repo),
    hiddenWork(repo),
    git(repo, ['remote', 'get-url', 'origin']),
    git(repo, ['log', '--max-parents=0', '--format=%ad', DATE_FORMAT]),
    git(repo, ['log', '-1', '--format=%ad', DATE_FORMAT]),
    git(repo, ['rev-list', '--count', 'HEAD']),
    commitActivity(repo),
  ]);
  if (!state) return null;

  // Sanitized before storing: a token in an https clone URL must not reach repos.json.
  const remote = sanitizeRemote(remoteRaw ?? '');
  const { webUrl, remoteHost } = resolveRemote(remote);
  const parts = relative(root, repo).split(/[\\/]/);
  const first = parts[0] ?? '';
  let owner = prettify(first.replace(/[-_]user$/i, '')) || prettify(first);
  let project = parts.length >= 3 ? prettify(parts[1]) : '';

  // Git-clones/ holds clones worked by the local user: a fork when it has own
  // commits, a reference clone otherwise. adoptForkProjects may rename it later.
  if (FORK_FOLDER.test(first)) {
    owner = GITHUB_USER;
    project = Object.keys(activity.days).length ? GIT_FORK : GIT_CLONE;
  }

  const { branch, ahead, behind, dirty } = state;
  const { stashes, otherBranches } = hidden;
  const row = {
    owner,
    project,
    name: parts[parts.length - 1],
    local: toWindowsPath(repo),
    remote,
    branch: branch === 'HEAD' ? '(detached)' : branch,
    webUrl,
    remoteHost,
    created: roots?.split('\n').pop() || null, // several roots (rare): the oldest
    lastCommit: lastCommit || null,
    commits: Number(commits) || 0,
    dirty,
    ahead,
    behind,
    hasUpstream: Boolean(state.upstream),
    stashes,
    otherBranches,
    working: dirty > 0 || ahead > 0 || behind > 0 || stashes > 0 || otherBranches.length > 0,
  };
  return { row: { ...row, ...(OVERRIDES[row.name] ?? {}) }, ...activity };
}

/** A fork whose upstream account names a project of the same owner joins it (example-fork -> Example Fork). */
function adoptForkProjects(rows) {
  const isFork = (project) => project === GIT_FORK || project === GIT_CLONE;
  const projects = new Map();
  for (const row of rows) {
    if (row.project && !isFork(row.project)) {
      projects.set(`${normalizeName(row.owner)}|${normalizeName(row.project)}`, row.project);
    }
  }
  for (const row of rows) {
    if (!isFork(row.project)) continue;
    const match = projects.get(`${normalizeName(row.owner)}|${normalizeName(webAccount(row.webUrl))}`);
    if (match) row.project = match;
  }
}

/** Sum `entry[field][name][date]` over every repo -> `{ name: { date: n } }`. */
function sumByRepo(described, field) {
  const totals = {};
  for (const entry of described) {
    for (const [name, days] of Object.entries(entry[field])) {
      const group = (totals[name] = totals[name] ?? {});
      for (const [date, count] of Object.entries(days)) group[date] = (group[date] ?? 0) + count;
    }
  }
  return totals;
}

/**
 * Scan `root` -> `{ root, rows, days, activity }`: rows sorted by
 * owner/project/name, `days[i]` the author's commits per day for `rows[i]`, and
 * `activity` every account's and AI provider's commits per day, all repos summed.
 */
export async function scanRepos({ root, depth = DEFAULT_DEPTH, jobs = 8 } = {}) {
  const resolvedRoot = resolveRoot(root);
  if (!existsSync(resolvedRoot)) throw new Error(`root folder does not exist: ${resolvedRoot}`);
  const repos = filterExcludedRepos(findRepos(resolvedRoot, depth), resolvedRoot, readExclusions());
  const described = (await mapPool(repos, jobs, (repo) => describe(repo, resolvedRoot))).filter(Boolean);

  adoptForkProjects(described.map((entry) => entry.row));
  const key = ({ row }) => `${row.owner}\u0000${row.project}\u0000${row.name}`;
  described.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
  const accounts = sumByRepo(described, 'accounts');
  const ai = sumByRepo(described, 'ai');
  const accountAi = sumByRepo(described, 'accountAi');
  return {
    root: resolvedRoot,
    rows: described.map((entry) => entry.row),
    days: described.map((entry) => entry.days),
    activity: {
      accounts: ACCOUNTS.map((a) => ({
        name: a.name,
        days: accounts[a.name] ?? {},
        ai: AI_PROVIDERS
          .map((p) => ({ provider: p.name, days: accountAi[a.name + '\u001f' + p.name] ?? {} }))
          .filter((p) => Object.keys(p.days).length),
      })),
      ai: AI_PROVIDERS.map((p) => ({ provider: p.name, days: ai[p.name] ?? {} })),
    },
  };
}
