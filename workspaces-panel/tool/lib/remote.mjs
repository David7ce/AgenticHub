// remote.mjs — clone URL -> web page + forge label, with SSH host-alias resolution.

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const HOST_LABELS = {
  'github.com': 'GitHub',
  'gitlab.com': 'GitLab',
  'bitbucket.org': 'Bitbucket',
  'codeberg.org': 'Codeberg',
  'git.sr.ht': 'SourceHut',
  'sr.ht': 'SourceHut',
};

/**
 * SSH `Host` alias -> `HostName`, so `git@github-alt.com:o/r` resolves to the
 * real forge. Under WSL the identities usually live in the Windows profile, so
 * that config is read too; the Linux one wins on conflicts.
 */
function readSshAliases() {
  const map = {};
  const candidates = [join(homedir(), '.ssh', 'config')];
  if (process.platform !== 'win32') {
    const user = process.env.USER || process.env.USERNAME;
    if (user) candidates.push(`/mnt/c/Users/${user}/.ssh/config`);
  }
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    let hosts = [];
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      const host = line.match(/^\s*Host\s+(.+)$/i);
      if (host) { hosts = host[1].trim().split(/\s+/); continue; }
      const hostName = line.match(/^\s*HostName\s+(\S+)$/i);
      if (hostName) for (const h of hosts) if (!(h in map)) map[h] = hostName[1];
    }
  }
  return map;
}

export const sshAliases = readSshAliases();

/**
 * Drop any userinfo from a scheme URL: repos.json is committed, so a token in
 * `https://user:token@host/...` must not reach it. `git@host:path` is only the
 * SSH user and stays.
 */
export function sanitizeRemote(remote) {
  return String(remote ?? '').replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@]*@/i, '$1');
}

/**
 * Clone URL -> `{ webUrl, remoteHost }`. The clone path is the web path on every
 * forge that follows host/owner/repo. Accepts `git@host:path`, `ssh://`,
 * `git://` and `http(s)://`, with or without port, `.git` or trailing slash.
 */
export function resolveRemote(remote, aliases = sshAliases) {
  const url = sanitizeRemote(remote);
  const none = { webUrl: null, remoteHost: null };
  if (!url) return none;

  const match = url.match(/^[^/@:]+@([^:/]+):(.+?)(?:\.git)?\/?$/)
    || url.match(/^(?:ssh|git\+ssh|https?|git):\/\/(?:[^/@]*@)?([^/:]+)(?::\d+)?\/(.+?)(?:\.git)?\/?$/i);
  if (!match) return none;
  const [, host, path] = match;

  let realHost = aliases[host] || host;
  // Identity aliases (github-alt.com) with no config entry are still GitHub.
  if (/^github-[^.]+\.com$/i.test(realHost)) realHost = 'github.com';
  return { webUrl: `https://${realHost}/${path}`, remoteHost: HOST_LABELS[realHost] || realHost };
}
