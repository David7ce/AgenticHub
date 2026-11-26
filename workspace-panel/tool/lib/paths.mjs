// paths.mjs — where things live, and path spellings across Windows, Git Bash and WSL.

import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const TOOL_DIR = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]$/, '');
export const PROJECTS_DIR = resolve(TOOL_DIR, '..');
export const DIST_DIR = join(PROJECTS_DIR, 'dist');
export const LOCAL_DIR = join(PROJECTS_DIR, 'local');

/** The workspace root: `--root`, then AGENTHUB_WORKSPACE_ROOT, then two levels above workspace-panel/. */
export function resolveRoot(explicit) {
  const configured = explicit || process.env.AGENTHUB_WORKSPACE_ROOT;
  // PowerShell does not expand `~`; accept it here.
  if (configured) return resolve(configured.replace(/^~(?=$|[\\/])/, homedir()));
  return resolve(PROJECTS_DIR, '../..');
}

/** `D:\Workspaces\...` for stored data, whichever shell this runs under. */
export function toWindowsPath(absolute) {
  const normalized = String(absolute).replace(/\\/g, '/');
  const drive = normalized.match(/^\/(?:mnt\/)?([A-Za-z])\//);
  if (drive) {
    return `${drive[1].toUpperCase()}:\\${normalized.slice(drive[0].length).replace(/\//g, '\\')}`;
  }
  // Node can report `d:\...`; stored paths always use an upper-case drive.
  return normalized.replace(/^([a-z]):/, (m, letter) => `${letter.toUpperCase()}:`).replace(/\//g, '\\');
}

/** Drive paths in Windows style; anything else (a Linux root) untouched. */
export function toDisplayPath(absolute) {
  return /^(\/mnt\/[A-Za-z]\/|[A-Za-z]:[\\/])/.test(String(absolute))
    ? toWindowsPath(absolute)
    : String(absolute);
}

/** A stored path, spelled the way git and the filesystem use it on this platform. */
export function toLocalPath(stored) {
  if (process.platform === 'win32') return stored.replace(/\//g, '\\');
  const drive = stored.match(/^([A-Za-z]):[\\/](.*)$/);
  if (drive) return `/mnt/${drive[1].toLowerCase()}/${drive[2].replace(/\\/g, '/')}`;
  return stored;
}
