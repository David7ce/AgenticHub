import test from 'node:test';
import assert from 'node:assert/strict';

import { buildSynthesisPrompt, renderMarkdown } from '../fanout-acp.mjs';

const results = [
  {
    agent: 'opencode',
    ok: true,
    status: 'ok',
    stopReason: 'end_turn',
    durationMs: 7300,
    cost: { amount: 0.0008, currency: 'USD' },
    text: 'FANOUT_OK',
    error: null,
  },
  {
    agent: 'hermes',
    ok: false,
    status: 'timeout',
    stopReason: null,
    durationMs: 129000,
    cost: null,
    text: '',
    error: 'session/prompt timed out after 120000ms',
  },
];

test('renders a status table and one section per agent', () => {
  const md = renderMarkdown({ prompt: 'Reply with exactly: FANOUT_OK', results, stamp: '20261029-120000' });
  assert.match(md, /^# ACP fan-out 20261029-120000/);
  assert.match(md, /\| opencode \| ok \| end_turn \| 7\.3s \| \$0\.0008 \|/);
  assert.match(md, /\| hermes \| timeout \| — \| 129\.0s \| — \|/);
  assert.match(md, /## opencode — ok — 7\.3s/);
  assert.match(md, /FANOUT_OK\n\n## hermes/);
  assert.match(md, /## hermes — timeout — 129\.0s/);
  assert.match(md, /_No answer\._/);
  assert.match(md, /session\/prompt timed out/);
});

test('fences the prompt with more tildes than it contains', () => {
  const md = renderMarkdown({
    prompt: 'text with ~~~ inside',
    results: [results[0]],
    stamp: 'x',
  });
  assert.match(md, /^~~~~text$/m);
  assert.match(md, /^~~~~$/m);
});

test('an empty answer with no error still renders a placeholder', () => {
  const md = renderMarkdown({
    prompt: 'p',
    results: [{ ...results[0], text: '', error: null, status: 'empty' }],
    stamp: 'x',
  });
  assert.match(md, /## opencode — empty — 7\.3s\n\n_No answer\._/);
});

test('synthesis is rendered before the per-agent answers', () => {
  const synthesis = {
    agent: 'opencode',
    status: 'ok',
    durationMs: 4200,
    cost: { amount: 0.001 },
    text: 'MERGED_ANSWER',
    error: null,
  };
  const md = renderMarkdown({ prompt: 'p', results, synthesis, stamp: 'x' });
  assert.match(md, /## Synthesis — opencode — ok — 4\.2s\n\nMERGED_ANSWER/);
  assert.ok(md.indexOf('## Synthesis') < md.indexOf('## opencode'));
});

test('a failed synthesis still leaves the source answers visible', () => {
  const synthesis = {
    agent: 'opencode',
    status: 'failed',
    durationMs: 1000,
    cost: null,
    text: '',
    error: 'agent exited (code 1)',
  };
  const md = renderMarkdown({ prompt: 'p', results, synthesis, stamp: 'x' });
  assert.match(md, /## Synthesis — opencode — failed/);
  assert.match(md, /_No synthesis\._/);
  assert.match(md, /FANOUT_OK/);
});

test('buildSynthesisPrompt needs two non-empty answers', () => {
  assert.equal(
    buildSynthesisPrompt({ prompt: 'x', results: [{ agent: 'a', text: 'only one' }] }),
    null,
  );
  assert.equal(
    buildSynthesisPrompt({
      prompt: 'x',
      results: [{ agent: 'a', text: 'one' }, { agent: 'b', text: '  ' }],
    }),
    null,
  );
});

test('buildSynthesisPrompt includes the task and every agent label', () => {
  const prompt = buildSynthesisPrompt({
    prompt: 'do the thing',
    results: [
      { agent: 'opencode', text: 'answer one' },
      { agent: 'hermes', text: 'answer two' },
    ],
  });
  assert.match(prompt, /TASK:\ndo the thing/);
  assert.match(prompt, /--- ANSWER FROM opencode ---\nanswer one/);
  assert.match(prompt, /--- ANSWER FROM hermes ---\nanswer two/);
  assert.match(prompt, /Surface material disagreements/);
});

test('buildSynthesisPrompt respects the character ceiling', () => {
  const prompt = buildSynthesisPrompt({
    prompt: 'x'.repeat(1000),
    results: [
      { agent: 'a', text: 'A'.repeat(50_000) },
      { agent: 'b', text: 'B'.repeat(50_000) },
    ],
    maxChars: 5000,
  });
  assert.ok(prompt.length <= 5000, `length ${prompt.length}`);
  assert.match(prompt, /\[truncated\]/);
});

test('kept worktrees are listed after the answers', () => {
  const md = renderMarkdown({
    prompt: 'p',
    results: [{ ...results[0], worktree: '/repo/.git/agent-worktrees/x-opencode', worktreeKept: true }],
    stamp: 'x',
  });
  assert.match(md, /## Kept worktrees/);
  assert.match(md, /- \*\*opencode\*\*: `\/repo\/\.git\/agent-worktrees\/x-opencode`/);
});

test('discarded worktrees are not listed', () => {
  const md = renderMarkdown({
    prompt: 'p',
    results: [{ ...results[0], worktree: '/repo/.git/agent-worktrees/x-opencode', worktreeKept: false }],
    stamp: 'x',
  });
  assert.doesNotMatch(md, /## Kept worktrees/);
});

// ── allow-all fanout: isolated agents, synthesizer outside the real tree ────
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const FANOUT = resolve(HERE, '..', 'fanout-acp.mjs');
const FAKE = resolve(HERE, '..', '..', 'mcp', 'tests', 'fixtures', 'fake-acp-agent.mjs');

function fanoutBox() {
  const dir = mkdtempSync(join(tmpdir(), 'fanout-allow-all-'));
  const repo = join(dir, 'repo');
  const git = (...args) => spawnSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.invalid', ...args], { cwd: repo, encoding: 'utf8' });
  spawnSync('git', ['init', '-q', repo]);
  writeFileSync(join(repo, 'a.txt'), 'a\n');
  git('add', 'a.txt');
  git('commit', '-qm', 'init');
  const entry = { command: process.execPath, args: [FAKE] };
  writeFileSync(join(dir, 'agents.json'), JSON.stringify({ agents: { one: entry, two: entry } }));
  const grant = { enabled: true, overseerAck: true, expires: '2099-01-01T00:00:00Z' };
  writeFileSync(join(dir, 'consent.json'), JSON.stringify({ one: grant, two: grant }));
  const env = { ...process.env, AGENT_HUB_CONSENT: join(dir, 'consent.json'), AGENT_HUB_LOG: join(dir, 'runs.jsonl'),
    AGENT_HUB_LOCKS: join(dir, 'locks'), AGENT_HUB_INFLIGHT: join(dir, 'inflight'), AGENT_HUB_RESULTS: join(dir, 'results') };
  const run = (extra, prompt = 'ping') => spawnSync(process.execPath,
    [FANOUT, '--agents', 'one,two', '--prompt', prompt, '--permission', 'allow-all', '--cwd', repo,
      '--registry', join(dir, 'agents.json'), '--json', ...extra],
    { encoding: 'utf8', env, timeout: 60_000 });
  return { dir, repo, run };
}

test('allow-all fanout without --worktree is refused before any agent starts', () => {
  const box = fanoutBox();
  const result = box.run([]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /allow-all fanout needs --worktree/);
});

test('synthesis output files are preserved and the retained path is reported', () => {
  const box = fanoutBox();
  const result = box.run(['--worktree', '--synthesize', 'one'], 'MARK:synth-evidence');
  assert.equal(result.status, 0, result.stderr);
  const response = JSON.parse(result.stdout);
  const scratch = response.synthesis.scratch;
  assert.ok(scratch);
  assert.ok(existsSync(join(scratch, 'synth-evidence')), 'do not delete agent-created evidence');
  const records = readFileSync(join(box.dir, 'runs.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(records.find((record) => record.mode === 'fanout').synthesis.scratch, scratch);
});

test('the allow-all synthesizer runs outside the real tree', () => {
  const box = fanoutBox();
  const result = box.run(['--worktree', '--synthesize', 'one']);
  assert.equal(result.status, 0, result.stderr);
  const records = readFileSync(join(box.dir, 'runs.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    .filter((r) => r.transport === 'acp' && !r.mode);
  assert.equal(records.length, 3, JSON.stringify(records));
  const synth = records.find((r) => /merge|synth/i.test(r.prompt ?? ''));
  assert.ok(synth, 'synthesis run audited');
  const rel = relative(box.repo, synth.cwd);
  assert.ok(rel && (rel.startsWith('..') || isAbsolute(rel)), 'synthesis cwd must be outside the original repo');
  assert.ok(existsSync(synth.cwd), 'synthesis directory must be retained');
  assert.equal(JSON.parse(result.stdout).synthesis.scratch, synth.cwd);
});
