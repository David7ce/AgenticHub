#!/usr/bin/env node
// check.mjs — one command that proves the hub still works.
//
//   node agent-hub/tools/check.mjs            # tests + bench dry-run
//   node agent-hub/tools/check.mjs --no-bench # tests only
//
// The repo has no CI (no remote), so this is the guard: 117 tests that make no
// model calls, plus the bench's dry run, which proves every task is still
// broken before an agent is asked to fix it. Exit 0 only if both pass.

import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const HUB = resolve(HERE, '..');
const ROOT = resolve(HUB, '..');

const TEST_DIRS = [
  'agent-hub/acp/tests',
  'agent-hub/bridge/tests',
  'agent-hub/tools/tests',
  'agent-hub/hubctl/tests',
  'agent-hub/mcp/tests',
];

// `node --test <dir>` is not supported on this Node, so the files are listed.
const TEST_FILES = TEST_DIRS.flatMap((dir) =>
  readdirSync(join(ROOT, dir))
    .filter((name) => name.endsWith('.test.mjs'))
    .sort()
    .map((name) => join(dir, name)),
);

const noBench = process.argv.includes('--no-bench');

function run(label, args, cwd = ROOT) {
  const started = Date.now();
  const result = spawnSync(process.execPath, args, { cwd, encoding: 'utf8' });
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  const ok = result.status === 0;
  const tail = ok ? '' : (result.stderr || result.stdout || '').trim().split('\n').slice(-6).join('\n');
  process.stdout.write(`${ok ? 'ok  ' : 'FAIL'} ${label} (${seconds}s)\n`);
  if (tail) process.stdout.write(tail + '\n');
  return ok;
}

const results = [];
results.push(['tests', run('tests', ['--test', ...TEST_FILES])]);

if (!noBench) {
  results.push(['bench', run('bench dry-run', [join(HUB, 'bench', 'run.mjs'), '--dry-run'])]);
}

const failed = results.filter(([, ok]) => !ok).map(([name]) => name);
if (failed.length) {
  process.stdout.write(`\n${failed.length} step(s) failed: ${failed.join(', ')}\n`);
  process.exit(1);
}
process.stdout.write(`\nall ${results.length} step(s) passed\n`);
