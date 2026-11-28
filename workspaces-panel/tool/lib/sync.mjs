// sync.mjs — fetch every repo and fast-forward the ones that are safe to move.
//
// Only a clean fast-forward: never a merge, reset or force. Uncommitted work,
// unpushed commits, no remote or no upstream -> reported and left alone. Dirty
// and ahead are read live, because repos.json may be hours old and a stale
// "clean" must never be the reason a fast-forward runs over someone's edits.

import { runGit } from './git.mjs';
import { toLocalPath } from './paths.mjs';
import { mapPool } from './pool.mjs';
import { readState } from './scan.mjs';

const oneLine = (text, max = 120) => String(text).replace(/\s+/g, ' ').trim().slice(0, max);

async function syncOne(row, { pull, dryRun }) {
  const local = toLocalPath(row.local);
  const result = (state, reason) => ({ name: row.displayName || row.name, local, state, reason });

  if (!row.remote) return result('skip', 'no remote');
  const state = await readState(local);
  if (!state) return result('fail', 'could not read repo state (git status failed)');
  if (!state.upstream) return result('skip', `branch '${state.branch}' has no upstream`);

  const busy = state.dirty > 0 || state.ahead > 0;
  const busyReason = `local changes (dirty ${state.dirty}, ahead ${state.ahead})`;
  if (dryRun) return busy ? result('skip', busyReason) : result('would', 'clean, has upstream');

  // Fetch before deciding: it only moves remote-tracking refs, and it keeps the
  // Pull count truthful even for a repo skipped below.
  const fetched = await runGit(local, ['fetch', '--quiet'], { timeout: 180_000 });
  if (!fetched.ok) return result('fail', `fetch failed: ${oneLine(fetched.out)}`);
  if (busy) return result('skip', busyReason);
  if (!pull) return result('ok', 'fetched');

  const merged = await runGit(local, ['merge', '--ff-only', '@{u}']);
  if (!merged.ok) return result('fail', `not a fast-forward: ${oneLine(merged.out, 80)}`);
  if (/already up.to.date/i.test(merged.out)) return result('ok', 'up to date');
  const head = await runGit(local, ['rev-parse', '--short', 'HEAD']);
  return result('ok', `fast-forward to ${head.out}`);
}

/**
 * @param rows      repos from dist/repos.json
 * @param names     only these names (empty = all)
 * @param pull      fast-forward after fetching
 * @param dryRun    report what would happen, touch nothing
 * @param parallel  fetch in parallel even without an ssh-agent
 */
export async function syncRepos(rows, { names = [], pull = true, dryRun = false, parallel = false, jobs = 6, log = console.log } = {}) {
  const wanted = new Set(names);
  const selected = wanted.size ? rows.filter((row) => wanted.has(row.name) || wanted.has(row.displayName)) : rows;
  if (!selected.length) {
    throw new Error(wanted.size ? `no repo named: ${[...wanted].join(', ')}` : 'no repos to sync');
  }

  // Without an agent, one at a time so a passphrase prompt is not buried.
  const serial = !process.env.SSH_AUTH_SOCK && !parallel;
  if (serial && selected.length > 1) {
    log(`no ssh-agent: fetching one repo at a time (${selected.length}); pass --jobs N to go parallel anyway`);
  }
  const results = await mapPool(selected, serial ? 1 : jobs, (row) => syncOne(row, { pull, dryRun }));

  const tags = { ok: 'ok  ', skip: 'skip', fail: 'FAIL', would: 'plan' };
  for (const result of results) log(`[${tags[result.state]}] ${result.name.padEnd(28)} ${result.reason}`);

  const count = (state) => results.filter((result) => result.state === state).length;
  const summary = { total: results.length, ok: count('ok'), skipped: count('skip'), failed: count('fail'), planned: count('would'), dryRun };
  log('');
  log(dryRun
    ? `plan: ${summary.planned} clean, ${summary.skipped} skipped, ${summary.total} total (nothing touched)`
    : `synced: ${summary.ok}, skipped: ${summary.skipped}, failed: ${summary.failed}, total: ${summary.total}`);
  if (!dryRun) log('run `node workspaces-panel/tool/cli.mjs build` to refresh dist/ with the new state.');
  return { results, summary };
}
