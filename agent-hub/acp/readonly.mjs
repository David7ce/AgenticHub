// readonly.mjs -- enforced read-only sessions, for agents that can prove it.
//
// OpenCode v2 removes every tool a project-level `opencode.json` denies, so a
// session started in a scratch directory holding a deny-by-default profile has
// no write, shell, MCP, subagent or Code Mode tool at all. Verified live on
// 2026-11-19 through `hub-acp` (docs/read-only-isolation.md): marker file not
// created, outside reads rejected with `external_directory`.
//
// This is tool removal inside OpenCode, not an OS sandbox. It is only used for
// adapters listed here; every other agent keeps failing closed. The profile is
// read from the *scratch* directory, never written into the authorized project.

import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';

const OPENCODE_COMMANDS = new Set(['opencode', 'opencode.cmd', 'opencode.exe']);

/** Only the native OpenCode ACP adapter qualifies; an alias must not borrow it. */
export function isEnforcedReadOnly(agent) {
  if (!agent || agent.name !== 'opencode') return false;
  const command = basename(String(agent.command ?? '')).toLowerCase();
  return OPENCODE_COMMANDS.has(command) && Array.isArray(agent.args) && agent.args.includes('acp');
}

/** Deny everything, then re-allow reads inside the authorized tree only. */
export function readOnlyProfile(authorizedCwd) {
  const tree = resolve(String(authorizedCwd)).split('\\').join('/').replace(/\/+$/, '');
  return {
    $schema: 'https://opencode.ai/config.json',
    permissions: [
      { action: '*', resource: '*', effect: 'deny' },
      { action: 'read', resource: '*', effect: 'allow' },
      { action: 'glob', resource: '*', effect: 'allow' },
      { action: 'grep', resource: '*', effect: 'allow' },
      { action: 'external_directory', resource: `${tree}/*`, effect: 'allow' },
    ],
  };
}

/**
 * Scratch session directory for a restricted run. Stable per authorized tree so
 * session/load and resume keep finding the same project; the profile is
 * rewritten on every run so it can never drift from this code.
 */
export function prepareReadOnlySession(authorizedCwd, { base = tmpdir() } = {}) {
  const tree = resolve(String(authorizedCwd));
  const id = createHash('sha256').update(tree.toLowerCase()).digest('hex').slice(0, 12);
  const dir = join(base, 'agenthub-readonly', id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'opencode.json'), JSON.stringify(readOnlyProfile(tree), null, 2));
  return { cwd: dir };
}

const MUTATING_KINDS = new Set(['edit', 'delete', 'move', 'execute']);

/** Tool calls that should have been impossible in a read-only session. */
export function readOnlyViolations(tools) {
  return [...tools.values()].filter((tool) => MUTATING_KINDS.has(tool.kind));
}
