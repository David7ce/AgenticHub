// paths.mjs — the one place that knows how Windows and WSL spell the same file.
//
// Two processes on this machine see the same disk through different names:
// a Windows child gets `D:\Workspaces\AgentHub`, a WSL child gets `/mnt/d/Workspaces/AgentHub`, and
// a path inside the Linux filesystem has no Windows form at all except through
// the `\\wsl.localhost\<distro>` share. Every boundary that hands a path to a
// child process goes through here, so a mistake is a failing test rather than
// a session that silently opens the wrong directory.
//
// Contract:
//   - Absolute paths only. A relative path is a programming error, not a value
//     to translate, so it throws instead of guessing a base directory.
//   - Translation is lossless for the two shapes that have an exact counterpart:
//     drive paths <-> /mnt/<drive>, and \\wsl.localhost\<distro>\x <-> /x.
//   - Anything already in the target style is returned unchanged.
//   - Separators and drive-letter case are normalized on output, never on input
//     comparison.

import { isAbsolute, posix, win32 } from 'node:path';

export const DEFAULT_DISTRO = process.env.WSL_DISTRO_NAME || 'Ubuntu';

const DRIVE = /^([A-Za-z]):(?:[\\/]|$)/;
const WSL_UNC = /^\\\\wsl(?:\.localhost|\$)\\[^\\]+(\\|$)/i;
const WSL_MOUNT = /^\/mnt\/([A-Za-z])(?:\/|$)/;

/** Which spelling this path uses. Throws on relative paths. */
export function styleOf(p) {
  if (typeof p !== 'string' || !p.trim()) throw new Error('path must be a non-empty string');
  const value = p.trim();

  if (WSL_UNC.test(value)) return 'windows-unc-wsl';
  if (DRIVE.test(value)) return 'windows-drive';
  if (WSL_MOUNT.test(value)) return 'wsl-mount';
  if (value.startsWith('/')) return 'posix';
  if (isAbsolute(value)) return 'posix';
  throw new Error(`path must be absolute: ${value}`);
}

export const isWindowsPath = (p) => {
  const style = styleOf(p);
  return style === 'windows-drive' || style === 'windows-unc-wsl';
};

const stripTrailing = (p) => {
  if (p.length > 1 && /[\\/]$/.test(p) && !/^[A-Za-z]:[\\/]$/.test(p)) return p.slice(0, -1);
  return p;
};

/**
 * Any Windows spelling -> the WSL spelling.
 *   D:\Workspaces\AgentHub          -> /mnt/d/Workspaces/AgentHub
 *   \\wsl.localhost\Ubuntu\home\x  -> /home/x
 *   /mnt/d/Workspaces/AgentHub        -> unchanged
 */
export function toWsl(p) {
  const style = styleOf(p);
  const value = stripTrailing(p.trim());

  if (style === 'windows-unc-wsl') {
    // \\wsl.localhost\Ubuntu\home\user\x -> /home/user/x
    const rest = value.replace(WSL_UNC, '').replace(/\\/g, '/');
    return rest ? posix.normalize(`/${rest.replace(/^\/+/, '')}`) : '/';
  }

  if (style === 'windows-drive') {
    const m = /^([A-Za-z]):(?:[\\/](.*))?$/.exec(value);
    const drive = m[1].toLowerCase();
    const tail = (m[2] ?? '').replace(/\\/g, '/').replace(/^\/+/, '');
    return tail ? `/mnt/${drive}/${tail}` : `/mnt/${drive}`;
  }

  return posix.normalize(value);
}

/**
 * Any WSL/POSIX spelling -> the Windows spelling.
 *   /mnt/d/Workspaces/AgentHub   -> D:\Workspaces\AgentHub
 *   /home/user/x       -> \\wsl.localhost\Ubuntu\home\user\x
 *   D:\Workspaces\AgentHub       -> unchanged
 *
 * `distro` is only needed for paths outside /mnt, where Windows has no drive
 * letter and must go through the WSL share.
 */
export function toWindows(p, { distro = DEFAULT_DISTRO } = {}) {
  const style = styleOf(p);
  const value = stripTrailing(p.trim());

  if (style === 'windows-drive' || style === 'windows-unc-wsl') return value;

  const mount = WSL_MOUNT.exec(value);
  if (mount) {
    const drive = mount[1].toUpperCase();
    const tail = value.slice(mount[0].length).replace(/^\/+/, '');
    return tail ? win32.normalize(`${drive}:\\${tail.replace(/\//g, '\\')}`) : `${drive}:\\`;
  }

  const tail = value.replace(/^\/+/, '').replace(/\//g, '\\');
  return tail ? `\\\\wsl.localhost\\${distro}\\${tail}` : `\\\\wsl.localhost\\${distro}`;
}

/**
 * Translate toward a named target. `native` means "whatever this process is",
 * which is the case that matters in practice: a Windows-side spawn needs
 * Windows paths, a WSL-side spawn needs WSL paths.
 */
export function translate(p, target, opts) {
  if (target === 'native') target = process.platform === 'win32' ? 'windows' : 'wsl';
  if (target === 'windows') return toWindows(p, opts);
  if (target === 'wsl') return toWsl(p);
  throw new Error(`unknown target style: ${target}`);
}

/** Human-readable summary for `hubctl path`. */
export function describe(p, { distro = DEFAULT_DISTRO } = {}) {
  const style = styleOf(p);
  return {
    input: p,
    style,
    wsl: toWsl(p),
    windows: toWindows(p, { distro }),
  };
}
