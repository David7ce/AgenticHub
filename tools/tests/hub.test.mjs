import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { resolveCommand, USAGE } from '../../hub.mjs';

const HUB = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

test('ask turns "agent prompt" into the hub-acp flags and passes the rest through', () => {
  assert.deepEqual(resolveCommand(['ask', 'opencode', 'fix', 'the', 'parser', '--json', '--cwd', 'D:\\repo']), {
    script: 'acp/hub-acp.mjs',
    args: ['--agent', 'opencode', '--prompt', 'fix the parser', '--json', '--cwd', 'D:\\repo'],
  });
});

test('a piped prompt becomes --prompt -, and a missing one is an error on a terminal', () => {
  assert.deepEqual(resolveCommand(['ask', 'claude', '--permission', 'deny'], { stdinIsTTY: false }).args, [
    '--agent', 'claude', '--prompt', '-', '--permission', 'deny',
  ]);
  assert.throws(() => resolveCommand(['ask', 'claude'], { stdinIsTTY: true }), /no prompt/);
});

test('flags that need no prompt are left alone', () => {
  assert.deepEqual(resolveCommand(['ask', 'codex', '--probe']).args, ['--agent', 'codex', '--probe']);
  assert.deepEqual(resolveCommand(['ask', '--list', '--json']), { script: 'acp/hub-acp.mjs', args: ['--list', '--json'] });
  assert.deepEqual(resolveCommand(['ask', 'codex', '--prompt', 'x']).args, ['--agent', 'codex', '--prompt', 'x']);
  assert.throws(() => resolveCommand(['ask', '--json']), /name an agent/);
});

test('fanout and route map the same way', () => {
  assert.deepEqual(resolveCommand(['fanout', 'opencode,claude', 'review this', '--worktree']), {
    script: 'acp/fanout-acp.mjs',
    args: ['--agents', 'opencode,claude', '--prompt', 'review this', '--worktree'],
  });
  assert.deepEqual(resolveCommand(['route', 'rename a variable', '--explain']), {
    script: 'acp/router.mjs',
    args: ['--prompt', 'rename a variable', '--explain'],
  });
  assert.throws(() => resolveCommand(['fanout', '--worktree']), /list the agents/);
});

test('everything else is hubctl, untouched', () => {
  assert.deepEqual(resolveCommand(['status', '--json']), { script: 'hubctl/hubctl.mjs', args: ['status', '--json'] });
  assert.deepEqual(resolveCommand(['tasks', 'add', '--repo', '.']).args, ['tasks', 'add', '--repo', '.']);
  assert.deepEqual(resolveCommand(['mcp']), { script: 'mcp/server.mjs', args: [] });
  assert.equal(resolveCommand([]).usage, USAGE);
});

test('the front door really runs the script it names', () => {
  const run = (...args) => spawnSync(process.execPath, [join(HUB, 'hub.mjs'), ...args], { encoding: 'utf8' });
  const path = run('path', 'D:\\repo', '--json');
  assert.equal(path.status, 0, path.stderr);
  assert.match(path.stdout, /mnt\/d\/repo/);
  const usage = run('ask', '--help');
  assert.match(`${usage.stdout}${usage.stderr}`, /usage: node hub-acp\.mjs/);
  assert.equal(run('ask').status, 2);
});
