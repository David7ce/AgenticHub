// Unit tests for the pieces of `hubctl live` that do not need a TTY or the OS
// process table: lock files, the frame model and the text render.

import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { buildLiveModel, readLocks, renderLive, snapshotTrees } from '../live.mjs';

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'hubctl-live-'));
}

test('readLocks reports a live holder and its age', () => {
  const dir = tempDir();
  try {
    writeFileSync(join(dir, 'tree.lock'), JSON.stringify({
      agent: 'opencode', pid: process.pid, cwd: 'D:\\Workspaces\\x', startedAt: 1000,
    }));
    const [lock] = readLocks(dir, { now: 5000 });
    assert.equal(lock.agent, 'opencode');
    assert.equal(lock.alive, true);
    assert.equal(lock.ageMs, 4000);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readLocks keeps an unparseable lock out instead of throwing', () => {
  const dir = tempDir();
  try {
    writeFileSync(join(dir, 'broken.lock'), '{not json');
    assert.deepEqual(readLocks(dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('buildLiveModel marks a silent turn as stalled and a running tool as work', () => {
  const status = {
    inflight: [
      { pid: 1, agent: 'opencode', cwd: 'C:\\w', stalled: true, silentMs: 900000, lastTool: null, toolCount: 0 },
      { pid: 2, agent: 'claude', cwd: 'C:\\w2', stalled: false, silentMs: 2000, lastTool: 'gradle (running)', toolCount: 3 },
    ],
    runs: [],
  };
  const model = buildLiveModel({ status, now: 5000 });
  assert.equal(model.inflight[0].phase, 'stalled?');
  assert.equal(model.inflight[1].phase, 'tool');
});

test('renderLive prints every section and omits ANSI when colour is off', () => {
  const model = {
    now: Date.parse('2026-11-08T19:00:00Z'),
    platform: 'win32',
    inflight: [{
      pid: 7, agent: 'opencode', cwd: 'D:\\w', phase: 'prompt', stalled: false,
      silentMs: 1000, toolCount: 2, model: 'opencode-go/x', lastTool: 'Edit file (completed)',
    }],
    locks: [{ cwd: 'D:\\w', agent: 'opencode', pid: 7, alive: true, ageMs: 5000 }],
    external: [{ pid: 9, name: 'codex.exe', cmd: 'codex exec' }],
    trees: [{ cwd: 'D:\\w', changes: 3, watching: true, lastChangeMs: 4000 }],
    runs: [{ time: '2026-11-08T18:59:00Z', agent: 'claude', status: 'ok', durationMs: 4000, model: 'sonnet' }],
  };
  const text = renderLive(model, { color: false, width: 100 });
  for (const heading of ['AGENTHUB LIVE', 'runs', 'trees', 'external', 'recent']) {
    assert.match(text, new RegExp(heading));
  }
  assert.doesNotMatch(text, /\x1b\[/);
  assert.match(text, /Edit file/);
  assert.match(text, /3 change/);
});

test('snapshotTrees reports changes since the watcher started', () => {
  const trees = new Map([['C:\\w', { cwd: 'C:\\w', changes: 2, watching: true, lastChange: 1000 }]]);
  const [row] = snapshotTrees(trees, { now: 3000 });
  assert.equal(row.changes, 2);
  assert.equal(row.lastChangeMs, 2000);
  assert.equal(row.watching, true);
});
