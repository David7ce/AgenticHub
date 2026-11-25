#!/usr/bin/env node
// check.mjs — one command that proves the hub still works.
//
//   node tools/check.mjs            # tests + bench dry-run (from the hub repo root)
//   node tools/check.mjs --no-bench # tests only
//
// CI (.github/workflows/checks.yml) repeats this on push; locally it is the guard: every test that makes no
// model calls, plus the bench's dry run, which proves every task is still
// broken before an agent is asked to fix it. Exit 0 only if both pass.

import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const HUB = resolve(HERE, '..');

const TEST_DIRS = [
  'acp/tests',
  'tools/tests',
  'hubctl/tests',
  'mcp/tests',
];

// `node --test <dir>` is not supported on this Node, so the files are listed.
const TEST_FILES = TEST_DIRS.flatMap((dir) =>
  readdirSync(join(HUB, dir))
    .filter((name) => name.endsWith('.test.mjs'))
    .sort()
    .map((name) => join(dir, name)),
);

const noBench = process.argv.includes('--no-bench');

// The failing subtest plus a few lines of its YAML detail, not the last 60
// lines of TAP (which are the tests that passed after it).
function failureDetail(output) {
  const lines = String(output ?? '').trim().split('\n');
  const picked = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (/^\s*not ok \d+/.test(lines[i]) || /^# fail [1-9]/.test(lines[i])) {
      picked.push(...lines.slice(i, i + 16));
    }
  }
  if (picked.length) return picked.slice(0, 120).join('\n');
  return lines.slice(-60).join('\n');
}

function run(label, args, cwd = HUB) {
  const started = Date.now();
  const result = spawnSync(process.execPath, args, { cwd, encoding: 'utf8' });
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  const ok = result.status === 0;
  // A tail is not enough: TAP lists every passing subtest after the failure.
  // Print the `not ok` block itself, and fall back to the tail for a crash.
  const tail = ok ? '' : failureDetail(`${result.stderr || ''}\n${result.stdout || ''}`);
  process.stdout.write(`${ok ? 'ok  ' : 'FAIL'} ${label} (${seconds}s)\n`);
  if (tail) process.stdout.write(tail + '\n');
  return ok;
}

const results = [];
results.push(['docs', run('documentation links', [join(HUB, 'tools', 'docs-check.mjs')])]);
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

