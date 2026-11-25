import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendTranscript, eventRecord, readTranscript, toRecord, transcriptPath,
} from '../transcript.mjs';

const NOW = '2026-01-01T00:00:00.000Z';
const tmp = (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'hub-transcript-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

test('transcriptPath sanitizes the session id', () => {
  assert.equal(transcriptPath('d', 'a/b..c'), join('d', 'a_b..c.jsonl'));
});

test('toRecord maps text, tool and usage updates and ignores the rest', () => {
  assert.deepEqual(
    toRecord({ sessionUpdate: 'agent_message_chunk', content: { text: 'hi' } }, NOW),
    { t: NOW, kind: 'text', text: 'hi' },
  );
  for (const sessionUpdate of ['tool_call', 'tool_call_update']) {
    assert.deepEqual(
      toRecord({ sessionUpdate, toolCallId: 'c1', title: 'Read x', kind: 'read', status: 'completed' }, NOW),
      { t: NOW, kind: 'tool', id: 'c1', title: 'Read x', toolKind: 'read', status: 'completed' },
    );
  }
  assert.deepEqual(
    toRecord({ sessionUpdate: 'usage_update', cost: { amount: 0.25 } }, NOW),
    { t: NOW, kind: 'usage', cost: 0.25 },
  );
  assert.equal(toRecord({ sessionUpdate: 'config_option_update' }, NOW), null);
});

test('toRecord redacts secrets, truncates, and tolerates missing fields', () => {
  const token = 'ghp_' + 'a'.repeat(36);
  const rec = toRecord({ sessionUpdate: 'tool_call', title: `curl ${token}` }, NOW);
  assert.ok(!rec.title.includes(token));
  assert.match(rec.title, /\[redacted\]/);
  assert.equal(toRecord({ sessionUpdate: 'tool_call', title: 'x'.repeat(900) }, NOW).title.length, 300);
  assert.equal(toRecord({ sessionUpdate: 'agent_message_chunk', content: { text: 'y'.repeat(9000) } }, NOW).text.length, 4000);
  assert.equal(toRecord({ sessionUpdate: 'agent_message_chunk' }, NOW).text, '');
  assert.equal(eventRecord('prompt', { text: `key ${token}` }, NOW).text.includes(token), false);
});

test('appendTranscript and readTranscript round-trip, merging adjacent text', (t) => {
  const dir = join(tmp(t), 'nested');
  appendTranscript(dir, 's1', eventRecord('prompt', { text: 'q' }, NOW));
  for (const text of ['a', 'b', 'c']) appendTranscript(dir, 's1', { t: NOW, kind: 'text', text });
  appendTranscript(dir, 's1', { t: NOW, kind: 'tool', id: '1', title: 'T' });
  const { records, total } = readTranscript(dir, 's1');
  assert.equal(total, 3);
  assert.deepEqual(records.map((r) => r.kind), ['tool', 'text', 'prompt']);
  assert.equal(records[1].text, 'abc');
  assert.deepEqual(readTranscript(dir, 'missing'), { records: [], total: 0 });
});

test('readTranscript redacts legacy chunk-split text once, after merging', (t) => {
  const dir = tmp(t);
  // Older on-disk transcripts hold one text record per streamed chunk, and a
  // secret split across two chunks was never matched at write time. One pass
  // after merging must catch it. Built by concatenation so no complete key
  // shape lives in this file.
  const token = 'sk-' + 'ABCDEFGHIJKLMNOPQRSTUVWXYZ' + '0123456789';
  appendTranscript(dir, 'secret', { t: NOW, kind: 'text', text: `before ${token.slice(0, 20)}` });
  appendTranscript(dir, 'secret', { t: NOW, kind: 'text', text: `${token.slice(20)} after` });
  const { records } = readTranscript(dir, 'secret');
  assert.equal(records.length, 1, 'adjacent text is still merged');
  assert.match(records[0].text, /\[redacted\]/);
  assert.ok(!records[0].text.includes(token));
  assert.doesNotMatch(records[0].text, /ABCDEFGHIJKLMNOP|QRSTUVWXYZ|0123456789/);
  assert.match(records[0].text, /^before \[redacted\] after$/);
});

test('appendTranscript never throws', (t) => {
  const dir = tmp(t);
  // The "directory" is a file, so it cannot be created.
  appendTranscript(dir, 's', { kind: 'text', text: 'a' });
  appendTranscript(join(transcriptPath(dir, 's')), 's', { kind: 'text', text: 'a' });
});

test('readTranscript pages newest first', (t) => {
  const dir = tmp(t);
  for (let i = 0; i < 120; i++) appendTranscript(dir, 'p', { t: NOW, kind: 'tool', id: String(i), title: `t${i}` });
  const first = readTranscript(dir, 'p', { limit: 50 });
  assert.equal(first.total, 120);
  assert.equal(first.records.length, 50);
  assert.equal(first.records[0].index, 119);
  const page = readTranscript(dir, 'p', { before: 70, limit: 50 });
  assert.equal(page.records[0].index, 69);
  assert.equal(page.records.at(-1).index, 20);
});

test('textOnly keeps text and prompt records', (t) => {
  const dir = tmp(t);
  appendTranscript(dir, 'o', eventRecord('prompt', { text: 'q' }, NOW));
  appendTranscript(dir, 'o', { t: NOW, kind: 'tool', id: '1', title: 'T' });
  appendTranscript(dir, 'o', { t: NOW, kind: 'text', text: 'a' });
  appendTranscript(dir, 'o', eventRecord('stop', { reason: 'end_turn', status: 'ok' }, NOW));
  const { records } = readTranscript(dir, 'o', { textOnly: true });
  assert.deepEqual(records.map((r) => r.kind), ['text', 'prompt']);
  assert.ok(readFileSync(transcriptPath(dir, 'o'), 'utf8').includes('"stop"'));
});

test('writeInflight records the last 600 chars of text, redacted, and a null pending permission', async (t) => {
  const dir = tmp(t);
  process.env.AGENT_HUB_INFLIGHT = dir;
  const { writeInflight, clearInflight } = await import('../run-record.mjs');
  t.after(() => clearInflight());
  const text = 'x'.repeat(700) + ' key ' + 'sk-ant-' + 'api03-abcdefghijklmnopqrstuvwxyz0123456789';
  writeInflight({ agent: { name: 'claude' }, cwd: '/w', started: NOW, state: { tools: new Map(), text } });
  const body = JSON.parse(readFileSync(join(dir, `${process.pid}.json`), 'utf8'));
  assert.ok(body.recentText.length <= 600);
  assert.doesNotMatch(body.recentText, /sk-ant-api03/);
  assert.equal(body.pendingPermission, null);
});

test('writeInflight redacts the agent-authored lastTool title', async (t) => {
  process.env.AGENT_HUB_INFLIGHT = tmp(t);
  const { writeInflight, clearInflight } = await import('../run-record.mjs');
  const { INFLIGHT_DIR } = await import('../hub-env.mjs');
  t.after(() => clearInflight());
  // Built by concatenation so no complete key shape lives in this file.
  const key = 's' + 'k-' + 'R'.repeat(24);
  writeInflight({
    agent: { name: 'claude' },
    cwd: '/w',
    started: NOW,
    state: {
      tools: new Map([['t1', { title: `Run curl with ${key}`, status: 'completed' }]]),
      text: '',
    },
  });
  const body = JSON.parse(readFileSync(join(INFLIGHT_DIR, `${process.pid}.json`), 'utf8'));
  assert.match(body.lastTool, /\[redacted\]/);
  assert.ok(!body.lastTool.includes(key));
  assert.ok(!body.lastTool.includes('R'.repeat(10)), 'no fragment of the key survives in lastTool');
});

test('writeInflight leaves no fragment of a secret that straddles the 600-char boundary', async (t) => {
  const dir = tmp(t);
  process.env.AGENT_HUB_INFLIGHT = dir; // only effective if this is the first import of hub-env
  const { writeInflight, clearInflight } = await import('../run-record.mjs');
  const { INFLIGHT_DIR } = await import('../hub-env.mjs');
  t.after(() => clearInflight());
  const token = 'sk-ant-' + 'api03-abcdefghijklmnopqrstuvwxyz0123456789';
  // The cut falls inside the token, so a slice-then-redact would keep only its tail.
  const text = 'y'.repeat(100) + ' ' + token + ' ' + 'z'.repeat(600 - 20);
  assert.ok(text.slice(-600).includes(token.slice(-8)), 'the naive cut keeps a fragment of the token');
  writeInflight({ agent: { name: 'claude' }, cwd: '/w', started: NOW, state: { tools: new Map(), text } });
  const body = JSON.parse(readFileSync(join(INFLIGHT_DIR, `${process.pid}.json`), 'utf8'));
  assert.ok(body.recentText.length <= 600);
  assert.doesNotMatch(body.recentText, /23456789|api03/);
});

test('writeInflight redacts the prompt before truncating it to 200 characters', async (t) => {
  const dir = tmp(t);
  process.env.AGENT_HUB_INFLIGHT = dir;
  const { writeInflight, clearInflight } = await import('../run-record.mjs');
  const { INFLIGHT_DIR } = await import('../hub-env.mjs');
  t.after(() => clearInflight());
  // Built by concatenation so no complete key shape lives in this file. The
  // key starts just before the 200-char cut, so a truncate-then-redact would
  // keep `sk-` plus a fragment of the body; the prefix must be gone instead.
  const key = 's' + 'k-' + 'R'.repeat(24);
  const prompt = `${'x'.repeat(180)} ${key} tail`;
  assert.ok(prompt.slice(0, 200).includes(key.slice(0, 4)), 'the naive cut keeps the key prefix');
  writeInflight({ agent: { name: 'claude' }, cwd: '/w', started: NOW, prompt, state: { tools: new Map(), text: '' } });
  const body = JSON.parse(readFileSync(join(INFLIGHT_DIR, `${process.pid}.json`), 'utf8'));
  assert.ok(body.prompt.length <= 200 + '...[truncated]'.length);
  assert.match(body.prompt, /\[redacted\]/);
  assert.ok(!body.prompt.includes('s' + 'k-'), 'the key prefix did not survive');
  assert.ok(!body.prompt.includes('R'.repeat(10)), 'no fragment of the key body survives');
});
