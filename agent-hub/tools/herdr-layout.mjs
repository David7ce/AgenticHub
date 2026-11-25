#!/usr/bin/env node
// herdr-layout.mjs — open a Herdr workspace with one pane per agent and a live view.
//
//   node agent-hub/tools/herdr-layout.mjs               # workspace + OpenCode, Codex, Claude + hubctl live
//   node agent-hub/tools/herdr-layout.mjs --no-agents   # same panes, plain shells (nothing is started)
//   node agent-hub/tools/herdr-layout.mjs --dry-run     # print the herdr commands, run nothing
//   node agent-hub/tools/herdr-layout.mjs --cwd D:\repo --label MyRepo
//
//   +----------------------+-----------------+
//   |  OpenCode (surface)  |  Codex          |
//   |                      +-----------------+
//   +----------------------+  Claude         |
//   |  hubctl live         |                 |
//   +----------------------+-----------------+
//
// Herdr is a terminal workspace manager; this only drives its CLI. It does not
// touch consent: agents started here are interactive sessions, outside the hub's
// gate. Use them as surfaces, and send governed work through the hub.

import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');

export const AGENTS = [
  { name: 'opencode', kind: 'opencode' },
  { name: 'codex', kind: 'codex' },
  { name: 'claude', kind: 'claude' },
];

/** The ordered herdr commands for the layout; `ids` maps step names to pane ids once known. */
export function planLayout({ cwd, label, agents = true }) {
  return [
    { id: 'main', args: ['workspace', 'create', '--label', label, '--cwd', cwd, '--no-focus'], pick: (r) => r.root_pane.pane_id },
    { id: 'codex', args: (ids) => ['pane', 'split', ids.main, '--direction', 'right', '--ratio', '0.45', '--no-focus'], pick: (r) => r.pane.pane_id },
    { id: 'claude', args: (ids) => ['pane', 'split', ids.codex, '--direction', 'down', '--ratio', '0.5', '--no-focus'], pick: (r) => r.pane.pane_id },
    { id: 'live', args: (ids) => ['pane', 'split', ids.main, '--direction', 'down', '--ratio', '0.8', '--no-focus'], pick: (r) => r.pane.pane_id },
    ...(agents
      ? AGENTS.map((a) => ({
          id: `start-${a.name}`,
          args: (ids) => ['agent', 'start', a.name, '--kind', a.kind, '--pane', ids[a.name === 'opencode' ? 'main' : a.name]],
        }))
      : []),
    {
      id: 'run-live',
      args: (ids) => ['pane', 'run', ids.live, `node ${join('agent-hub', 'hubctl', 'hubctl.mjs')} live`],
    },
  ];
}

function herdr(args) {
  const result = spawnSync('herdr', args, { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error(`herdr ${args.join(' ')} failed: ${(result.stderr || result.stdout).trim()}`);
  try { return JSON.parse(result.stdout).result; } catch { return {}; }
}

function main(argv) {
  const flag = (name) => argv.includes(name);
  const value = (name, fallback) => { const i = argv.indexOf(name); return i === -1 ? fallback : argv[i + 1]; };
  const cwd = resolve(value('--cwd', ROOT));
  const label = value('--label', 'AgentHub');
  const steps = planLayout({ cwd, label, agents: !flag('--no-agents') });
  const ids = {};
  for (const step of steps) {
    const args = typeof step.args === 'function' ? step.args(ids) : step.args;
    if (flag('--dry-run')) { process.stdout.write(`herdr ${args.join(' ')}\n`); ids[step.id] = step.id; continue; }
    const result = herdr(args);
    if (step.pick) ids[step.id] = step.pick(result);
  }
  if (!flag('--dry-run')) process.stdout.write(`workspace "${label}" ready (${Object.keys(ids).length} panes). Attach with: herdr\n`);
}

if (process.argv[1] && import.meta.url === new URL(`file:///${process.argv[1].replace(/\\/g, '/')}`).href) main(process.argv.slice(2));
