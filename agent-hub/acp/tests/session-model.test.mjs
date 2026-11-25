import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sessionModel, sessionRequestedMode } from '../session-model.mjs';

test('session model is scoped to agent, working tree and latest successful turn, including rotation', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hub-session-model-'));
  const log = join(dir, 'runs.jsonl');
  const row = (fields) => JSON.stringify({ agent: 'codex', sessionId: 's1', cwd: dir, status: 'ok', model: 'first', ...fields });
  writeFileSync(join(dir, 'runs-2026-01-01T00-00-00.jsonl'), row({ model: 'archived' }) + '\n');
  writeFileSync(log, [
    row({ model: 'correct' }),
    row({ model: 'wrong-agent', agent: 'other' }),
    row({ model: 'wrong-tree', cwd: join(dir, 'other') }),
    row({ model: 'failed', status: 'failed' }),
    '{bad json',
  ].join('\n'));
  assert.equal(sessionModel(log, { agent: 'codex', sessionId: 's1', cwd: dir }), 'correct');
  writeFileSync(log, '');
  assert.equal(sessionModel(log, { agent: 'codex', sessionId: 's1', cwd: dir }), 'archived');
  assert.equal(sessionModel(log, { agent: 'codex', sessionId: 'missing', cwd: dir }), null);
});

test('requested mode uses only the latest successful scoped turn, including explicit absence', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hub-session-mode-'));
  const log = join(dir, 'runs.jsonl');
  const row = (fields) => JSON.stringify({ agent: 'codex', sessionId: 's1', cwd: dir, status: 'ok', ...fields });
  writeFileSync(join(dir, 'runs-2026-01-01.jsonl'), row({ requestedMode: 'plan' }) + '\n');
  writeFileSync(log, [
    row({ requestedMode: 'read-only' }),
    row({ requestedMode: 'bad', agent: 'other' }),
    row({ requestedMode: 'bad', status: 'failed' }),
  ].join('\n'));
  const scope = { agent: 'codex', sessionId: 's1', cwd: dir };
  assert.equal(sessionRequestedMode(log, scope), 'read-only');
  writeFileSync(log, row({ reportedMode: 'agent', requestedMode: null }));
  assert.equal(sessionRequestedMode(log, scope), null);
  writeFileSync(log, '');
  assert.equal(sessionRequestedMode(log, scope), 'plan');
  assert.equal(sessionRequestedMode(log, { ...scope, cwd: join(dir, 'other') }), null);
});
