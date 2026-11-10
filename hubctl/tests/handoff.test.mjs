import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildHandoffPrompt, recentRunsFor, MAX_PROMPT } from '../../acp/handoff.mjs';

const fakeGit = (args) => {
  const cmd = args.join(' ');
  const out = cmd.includes('status') ? ' M a.js' : cmd.includes('log') ? 'abc123 fix' : 'main';
  return { status: 0, stdout: out };
};

test('recentRunsFor keeps only this tree, skips probes, newest last', () => {
  const log = [
    { cwd: 'D:\\r', status: 'ok', agent: 'claude', prompt: 'one' },
    { cwd: 'D:\\other', status: 'ok', agent: 'claude', prompt: 'x' },
    { cwd: 'D:\\r', status: 'probe', agent: 'codex' },
    { cwd: 'd:/r/', status: 'ok', agent: 'codex', prompt: 'two' },
  ].map((e) => JSON.stringify(e)).join('\n');
  const runs = recentRunsFor(log, 'D:\\r');
  assert.deepEqual(runs.map((r) => r.prompt), ['one', 'two']);
});

test('the prompt names the target, the changes, the note, and stays under the cap', () => {
  const prompt = buildHandoffPrompt({
    cwd: 'D:/r', target: 'codex', note: 'x'.repeat(5000), logText: '', run: (_c, args) => fakeGit(args),
  });
  assert.match(prompt, /You are codex/);
  assert.match(prompt, /M a\.js/);
  assert.match(prompt, /abc123 fix/);
  assert.ok(prompt.length <= MAX_PROMPT);
});

test('a failover prompt carries the original task and still respects the cap', () => {
  const prompt = buildHandoffPrompt({
    cwd: 'D:/r', target: 'opencode', from: 'claude', task: 'Fix the parser bug in src/p.js '.repeat(200),
    run: (_c, args) => fakeGit(args),
  });
  assert.match(prompt, /Task to carry out/);
  assert.match(prompt, /Fix the parser bug/);
  assert.ok(prompt.length <= MAX_PROMPT);
});
