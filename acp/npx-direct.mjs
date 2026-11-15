// npx-direct.mjs — start a pinned adapter without npx when it is already cached.
//
// Claude and Codex are registered as `npx -y <package>@<exact version>`. npx
// resolves the package on every start even when it is cached: measured on
// codex-acp@2.6.0 (Linux, Node 22), 915-1005 ms to the initialize response
// through npx against 245-277 ms running the same cached file with node.
// That is paid on every turn, because every turn starts the agent.
//
// So: if the registry line is exactly that shape and npx's own cache already
// holds that exact version, run its bin with this Node. Anything else -- a
// range, a tag, extra npx flags, a cache miss -- goes through npx as before,
// which is also what fills the cache the first time. Same code either way.
// HUB_NO_NPX_SHORTCUT=1 turns it off.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const NPX = /(^|[\\/])npx(\.cmd|\.exe)?$/i;
// name@1.2.3 or @scope/name@1.2.3-pre.4 -- an exact version, never a range or a tag.
const PINNED = /^((?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*)@(\d+\.\d+\.\d+(?:-[\w.]+)?)$/i;

export function npmCacheDir(env = process.env, platform = process.platform) {
  if (env.npm_config_cache) return env.npm_config_cache;
  if (platform === 'win32' && env.LOCALAPPDATA) return join(env.LOCALAPPDATA, 'npm-cache');
  return join(homedir(), '.npm');
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

// The bin script of name@version inside npx's cache, or null.
function cachedBin(name, version, cacheDir) {
  const root = join(cacheDir, '_npx');
  let entries;
  try {
    entries = readdirSync(root);
  } catch {
    return null;
  }
  for (const entry of entries) {
    const dir = join(root, entry, 'node_modules', ...name.split('/'));
    const pkg = readJson(join(dir, 'package.json'));
    if (pkg?.version !== version) continue;
    const bin = typeof pkg.bin === 'string' ? pkg.bin : Object.values(pkg.bin ?? {})[0];
    // Only a JavaScript bin can be handed to node; anything else stays with npx.
    if (typeof bin !== 'string' || !/\.[cm]?js$/.test(bin)) continue;
    const file = join(dir, bin);
    if (existsSync(file)) return file;
  }
  return null;
}

// { command, args } to spawn instead, or null to leave the registry line alone.
export function directCommand(command, args = [], { cacheDir = npmCacheDir(), env = process.env } = {}) {
  if (env.HUB_NO_NPX_SHORTCUT === '1') return null;
  if (!NPX.test(command)) return null;
  const [flag, spec, ...rest] = args;
  if (flag !== '-y' && flag !== '--yes') return null;
  const match = PINNED.exec(spec ?? '');
  if (!match) return null;
  const bin = cachedBin(match[1], match[2], cacheDir);
  return bin ? { command: process.execPath, args: [bin, ...rest] } : null;
}
