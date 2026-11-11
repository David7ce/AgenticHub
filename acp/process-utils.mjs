// process-utils.mjs -- the two process chores every part of the hub needs:
// starting an agent the same way everywhere, and stopping it with its children.
//
// Both used to be copied (three killTree versions, two spawn blocks); they live
// here so a fix lands once.

import { spawn, spawnSync } from 'node:child_process';

// child.kill() signals one PID. On Windows the child is usually a wrapper --
// cmd.exe for an npx shim, wsl.exe for OpenCode -- whose own children survive
// the signal (a plain `taskkill /pid` without /T orphans them and leaves their
// sessions "running"). Take the whole tree down.
export function killTree(child) {
  // No `child.killed` guard: callers often signal the child first (which sets it)
  // and only then reach for the tree, and a taskkill on a dead PID is harmless.
  if (!child || child.pid == null) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    return;
  }
  // The agent is a grandchild behind a wrapper: children first, then the child.
  spawnSync('pkill', ['-TERM', '-P', String(child.pid)], { stdio: 'ignore' });
  try {
    child.kill('SIGTERM');
  } catch {}
}

// Starts an ACP agent with piped stdio.
//
// Node cannot spawn .cmd/.bat wrappers directly on Windows (EINVAL since the
// CVE-2024-27980 fix), and passing args with shell:true triggers a deprecation
// warning. Run the wrapper through cmd.exe instead. Registry args are static
// and trusted; refuse anything that would need cmd quoting rather than
// hand-rolling it.
export function spawnAgentProcess({ command, args = [], cwd, env }) {
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(command)) {
    const line = [command, ...args];
    if (line.some((part) => /[\s"&|<>^%]/.test(part))) {
      throw new Error(`refusing to shell out to ${command}: registry args contain cmd metacharacters`);
    }
    return spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', line.join(' ')], {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsVerbatimArguments: true,
      windowsHide: true,
    });
  }
  return spawn(command, args, {
    cwd,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
}
