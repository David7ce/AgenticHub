import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

import { createSessionRegistry, foreignOwner, pidAlive, validLabel } from '../sessions.mjs';

function tmp(t) {
  const dir = mkdtempSync(join(tmpdir(), 'sessions-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, 'sessions.json');
}

test('create, get, and list newest-first with filters', (t) => {
  let clock = 1000;
  const reg = createSessionRegistry({ path: tmp(t), now: () => clock });
  const a = reg.upsert('a', { agent: 'claude', cwd: '/w/a' });
  assert.equal(a.state, 'idle');
  assert.equal(a.createdAt, 1000);
  assert.deepEqual(a.queued, []);
  assert.equal(a.jobId, null);
  clock = 2000;
  reg.upsert('b', { agent: 'codex', cwd: '/w/b' });
  clock = 3000;
  reg.upsert('a', { spendUsd: 0.5 });
  assert.equal(reg.get('a').spendUsd, 0.5);
  assert.equal(reg.get('a').createdAt, 1000);
  assert.deepEqual(reg.list().map((s) => s.label), ['a', 'b']);
  assert.deepEqual(reg.list({ agent: 'codex' }).map((s) => s.label), ['b']);
  assert.equal(reg.get('zzz'), null);
  assert.throws(() => reg.upsert('c', { agent: 'claude' }), /cwd/);
  assert.throws(() => reg.upsert('Bad Label', { agent: 'claude', cwd: '/x' }), /label/);
});

test('close sets state closed', (t) => {
  const reg = createSessionRegistry({ path: tmp(t) });
  reg.upsert('a', { agent: 'claude', cwd: '/w' });
  assert.equal(reg.close('a').state, 'closed');
  assert.equal(reg.get('a').state, 'closed');
  assert.equal(reg.close('nope'), null);
  assert.deepEqual(reg.list({ state: 'closed' }).map((s) => s.label), ['a']);
});

test('close records prompts still queued as dropped', (t) => {
  const reg = createSessionRegistry({ path: tmp(t) });
  reg.upsert('a', { agent: 'claude', cwd: '/w', queued: ['later'], dropped: ['earlier'] });
  const closed = reg.close('a', { dropQueue: true });
  assert.equal(closed.state, 'closed');
  assert.deepEqual(closed.queued, []);
  assert.deepEqual(closed.dropped, ['earlier', 'later']);
});

test('reconcile cancels dead running sessions and drops queued', (t) => {
  const reg = createSessionRegistry({ path: tmp(t) });
  reg.upsert('dead', { agent: 'claude', cwd: '/w', state: 'running', jobId: 'j1', queued: ['next one'] });
  reg.upsert('live', { agent: 'claude', cwd: '/w', state: 'running', jobId: 'j2' });
  reg.upsert('idle', { agent: 'claude', cwd: '/w' });
  const changed = reg.reconcile((id) => id === 'j2');
  assert.deepEqual(changed.map((s) => s.label), ['dead']);
  const d = reg.get('dead');
  assert.equal(d.state, 'idle');
  assert.equal(d.lastTurn, 'cancelled');
  assert.equal(d.jobId, null);
  assert.deepEqual(d.queued, []);
  assert.deepEqual(d.dropped, ['next one']);
  assert.equal(reg.get('live').state, 'running');
});

test('a session records its owning process, null by default', (t) => {
  const reg = createSessionRegistry({ path: tmp(t) });
  assert.equal(reg.upsert('a', { agent: 'claude', cwd: '/w' }).ownerPid, null);
  assert.equal(reg.upsert('a', { ownerPid: 4242 }).ownerPid, 4242);
});

test('reconcile leaves a session driven by another live process alone', async (t) => {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
  t.after(() => child.kill());
  const reg = createSessionRegistry({ path: tmp(t) });
  reg.upsert('foreign', { agent: 'claude', cwd: '/w', state: 'running', jobId: 'j1', ownerPid: child.pid });
  reg.upsert('dead-owner', { agent: 'claude', cwd: '/w', state: 'running', jobId: 'j2', ownerPid: 999999 });
  // A record from before ownerPid existed, and a stale one this process owns.
  reg.upsert('legacy', { agent: 'claude', cwd: '/w', state: 'running', jobId: 'j3' });
  reg.upsert('own-stale', { agent: 'claude', cwd: '/w', state: 'waiting-permission', jobId: 'j4', ownerPid: process.pid });

  const changed = reg.reconcile(() => false, { selfPid: process.pid });
  assert.deepEqual(changed.map((s) => s.label).sort(), ['dead-owner', 'legacy', 'own-stale']);
  assert.equal(reg.get('foreign').state, 'running', 'a live owner in another process keeps its turn');
  assert.equal(reg.get('foreign').ownerPid, child.pid);
  for (const label of ['dead-owner', 'legacy', 'own-stale']) assert.equal(reg.get(label).state, 'idle', label);
});

test('foreignOwner names a live other process, never a dead or own one', async (t) => {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
  t.after(() => child.kill());
  assert.equal(pidAlive(process.pid), true);
  assert.equal(pidAlive(999999), false);
  assert.equal(foreignOwner({ ownerPid: null }), null);
  assert.equal(foreignOwner({ ownerPid: process.pid }), null);
  assert.equal(foreignOwner({ ownerPid: 999999 }), null, 'a dead owner is not foreign');
  assert.equal(foreignOwner({ ownerPid: child.pid }), child.pid);
  assert.equal(foreignOwner({ ownerPid: child.pid }, child.pid), null, 'the owner itself may close it');
});

test('stored prompt text is redacted and truncated', (t) => {
  const reg = createSessionRegistry({ path: tmp(t) });
  const s = reg.upsert('a', { agent: 'claude', cwd: '/w', queued: ['x'.repeat(5000)] });
  assert.ok(s.queued[0].length <= 4000 + 50);
});

test('two registries on one file lose nothing', (t) => {
  const path = tmp(t);
  const r1 = createSessionRegistry({ path });
  const r2 = createSessionRegistry({ path });
  r1.get('x');
  r2.get('x');
  r1.upsert('one', { agent: 'claude', cwd: '/w' });
  r2.upsert('two', { agent: 'codex', cwd: '/w' });
  assert.deepEqual(r1.list().map((s) => s.label).sort(), ['one', 'two']);
  assert.ok(r2.get('one'));
});

test('corrupted file starts empty and keeps a .bad copy', (t) => {
  const path = tmp(t);
  writeFileSync(path, '{not json');
  const reg = createSessionRegistry({ path });
  assert.deepEqual(reg.list(), []);
  assert.ok(existsSync(`${path}.bad`));
  assert.equal(readFileSync(`${path}.bad`, 'utf8'), '{not json');
  reg.upsert('a', { agent: 'claude', cwd: '/w' });
  assert.ok(reg.get('a'));
});

test('validLabel', () => {
  assert.equal(validLabel('claude-auth-fix'), true);
  assert.equal(validLabel('Claude Fix'), false);
  assert.equal(validLabel('-x'), false);
  assert.equal(validLabel('a'.repeat(48)), true);
  assert.equal(validLabel('a'.repeat(49)), false);
});

test('two processes upserting concurrently lose nothing', async (t) => {
  const path = tmp(t);
  const sessionsUrl = new URL('../sessions.mjs', import.meta.url).href;
  const script = `
    import { createSessionRegistry } from ${JSON.stringify(sessionsUrl)};
    const [path, prefix] = process.argv.slice(1);
    const reg = createSessionRegistry({ path });
    for (let i = 0; i < 25; i++) reg.upsert(prefix + '-' + i, { agent: 'claude', cwd: '/w' });
  `;
  const run = (prefix) => new Promise((resolve, reject) => {
    const c = spawn(process.execPath, ['--input-type=module', '-e', script, path, prefix], { stdio: 'pipe' });
    let err = '';
    c.stderr.on('data', (d) => { err += d; });
    c.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(err))));
  });
  await Promise.all([run('p'), run('q')]);
  const data = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(Object.keys(data).length, 50);
  assert.equal(existsSync(`${path}.bad`), false);
});
