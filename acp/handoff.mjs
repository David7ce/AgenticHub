// handoff.mjs — build the relay prompt when one agent has to pick up another's work.
//
// Used when a pool runs out (Claude's quota is the usual case). It gathers only
// facts that already exist: git state of the tree, the last audit lines for that
// tree, and an optional note from the person. No secrets, no file contents.
// The prompt stays under the hub's 4000-character prompt cap.

import { spawnSync } from 'node:child_process';

export const MAX_PROMPT = 3800;

function git(cwd, args, run = spawnSync) {
  const r = run('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  return r.status === 0 ? String(r.stdout).trim() : '';
}

function clip(text, max) {
  const t = String(text ?? '').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** Last N finished audit lines that ran in `cwd`, newest last. */
export function recentRunsFor(logText, cwd, count = 4) {
  const want = String(cwd).replace(/[\\/]+$/, '').toLowerCase().replaceAll('\\', '/');
  const out = [];
  for (const line of String(logText ?? '').split('\n')) {
    if (!line.trim()) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (!e.cwd || !e.status || e.status === 'probe') continue;
    if (String(e.cwd).toLowerCase().replaceAll('\\', '/').replace(/\/+$/, '') !== want) continue;
    out.push(e);
  }
  return out.slice(-count);
}

export function buildHandoffPrompt({ cwd, target, from = 'claude', note = '', task = '', logText = '', run = spawnSync }) {
  const branch = git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'], run) || '?';
  const status = git(cwd, ['status', '--short'], run);
  const commits = git(cwd, ['log', '--oneline', '-n', '3'], run);
  const runs = recentRunsFor(logText, cwd)
    .map((e) => `- ${e.agent} ${e.status}: ${clip(e.prompt, 110)}`)
    .join('\n');
  const lines = [
    `You are taking over work from ${from}, which is out of quota. You are ${target}.`,
    `Tree: ${cwd} (branch ${branch}). Treat it as live: you are the only writer.`,
    '',
    'First read, in this order, whichever exist: AGENTS.md, working/ROADMAP.md, docs/agent/HANDOFF.md.',
    'Then continue; do not redo what the log below shows as done.',
    task ? `\nTask to carry out (the one ${from} was given):\n${clip(task, 1600)}` : '',
    note ? `\nInstruction from the owner: ${clip(note, 700)}` : '',
    status ? `\nUncommitted changes:\n${clip(status, 900)}` : '\nWorking tree is clean.',
    commits ? `\nLast commits:\n${commits}` : '',
    runs ? `\nRecent hub runs in this tree:\n${runs}` : '',
    '\nRules: never print secrets; do not widen consent; do not commit or push unless asked;',
    'finish by writing what you did and the next step to the tree\'s handoff file.',
  ];
  return clip(lines.filter((l) => l !== '').join('\n'), MAX_PROMPT);
}
