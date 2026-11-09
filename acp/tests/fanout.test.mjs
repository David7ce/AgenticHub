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
