import test from 'node:test';
import assert from 'node:assert/strict';

import { createJobRegistry } from '../jobs.mjs';

// A fake spawner: jobs.mjs only needs { pid, promise, kill }, so the registry
// is testable without a child process, a model call or a working tree.
function fakeSpawner() {
  const calls = [];
  const spawnJob = ({ args, input }) => {
    let settle;
    const promise = new Promise((resolve) => {
      settle = resolve;
    });
    const call = { args, input, settle, killed: false };
    calls.push(call);
    return {
      pid: 1000 + calls.length,
      kill: () => {
        call.killed = true;
        settle({ ok: false, status: 'cancelled', tools: [] });
      },
      promise,
    };
  };
  return { spawnJob, calls };
}

test('a job reports running, then its answer', async () => {
  const { spawnJob, calls } = fakeSpawner();
  const jobs = createJobRegistry({ spawnJob });
  const started = jobs.start({ agent: 'opencode', prompt: 'do it', cwd: '/repo', args: ['--x'] });

  assert.match(started.id, /^job_/);
  assert.equal(jobs.status(started.id).running, true);
  assert.equal(jobs.result(started.id).answer, null, 'no answer while running');

  calls[0].settle({ ok: true, status: 'ok', model: 'opencode-go/deepseek-v4.1-flash', text: 'done', tools: [] });

  // Let the promise chain settle.
  await new Promise((resolve) => setImmediate(resolve));
  const status = jobs.status(started.id);
  assert.equal(status.running, false);
  assert.equal(status.state, 'ok');
  assert.equal(status.model, 'opencode-go/deepseek-v4.1-flash');
  assert.equal(jobs.result(started.id).answer.text, 'done');
});

test('cancelling a job waits for proof that it stopped', async () => {
  const { spawnJob, calls } = fakeSpawner();
  const jobs = createJobRegistry({ spawnJob });
  const { id } = jobs.start({ agent: 'opencode', prompt: 'long', cwd: '/repo', args: [] });

  const outcome = await jobs.cancel(id);
  assert.equal(outcome.ok, true);
  assert.equal(outcome.ack, true, 'the fake settles when killed');
  assert.equal(calls[0].killed, true);
  assert.equal(jobs.status(id).state, 'cancelled');

  // Cancelling twice is a no-op, not an error to shout about.
  const again = await jobs.cancel(id);
  assert.equal(again.ok, false);
  assert.match(again.reason, /already cancelled/);
});

test('a job that ignores the kill is reported as not acknowledged', async () => {
  // The wrapper dies; the work does not (the OpenCode-in-a-daemon case).
  const jobs = createJobRegistry({
    spawnJob: () => ({
      pid: 4242,
      kill: () => {},
      promise: new Promise(() => {}),
    }),
  });
  const { id } = jobs.start({ agent: 'opencode', prompt: 'long', cwd: '/repo', args: [] });
  const outcome = await jobs.cancel(id, { waitMs: 50 });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.ack, false);
  assert.match(outcome.detail, /may still be changing/);
});

test('an unknown job is null everywhere, never a crash', () => {
  const { spawnJob } = fakeSpawner();
  const jobs = createJobRegistry({ spawnJob });
  assert.equal(jobs.status('job_nope'), null);
  assert.equal(jobs.result('job_nope'), null);
  return jobs.cancel('job_nope').then((outcome) => {
    assert.deepEqual(outcome, { ok: false, reason: 'unknown job' });
  });
});

test('finished jobs are pruned by ttl and by limit', async () => {
  let clock = 1_000;
  const { spawnJob, calls } = fakeSpawner();
  const jobs = createJobRegistry({ spawnJob, now: () => clock, ttlMs: 500, limit: 2 });

  const first = jobs.start({ agent: 'a', prompt: 'p', cwd: '/r', args: [] });
  calls[0].settle({ ok: true, status: 'ok', tools: [] });
  await new Promise((resolve) => setImmediate(resolve));

  clock += 2_000; // past the ttl
  jobs.start({ agent: 'b', prompt: 'p', cwd: '/r', args: [] });
  assert.equal(jobs.status(first.id), null, 'an expired job is dropped on the next start');

  // Limit is enforced newest-first: only the most recent `limit` survive.
  calls[1].settle({ ok: true, status: 'ok', tools: [] });
  await new Promise((resolve) => setImmediate(resolve));
  jobs.start({ agent: 'c', prompt: 'p', cwd: '/r', args: [] });
  jobs.start({ agent: 'd', prompt: 'p', cwd: '/r', args: [] });
  assert.ok(jobs.list().length <= 2);
});

test('onSettled runs once, so a tree lock is always released', async () => {
  const { spawnJob, calls } = fakeSpawner();
  let settled = 0;
  const jobs = createJobRegistry({ spawnJob });
  jobs.start({ agent: 'a', prompt: 'p', cwd: '/r', args: [], onSettled: () => (settled += 1) });
  calls[0].settle({ ok: true, status: 'ok', tools: [] });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, 1);
});


test('expired completions do not consume the eviction count for retained jobs', async () => {
  let clock = 1000;
  const { spawnJob, calls } = fakeSpawner();
  const jobs = createJobRegistry({ spawnJob, now: () => clock, ttlMs: 500, limit: 2 });
  const first = jobs.start({ agent: 'a', args: [] });
  const second = jobs.start({ agent: 'b', args: [] });
  const running = jobs.start({ agent: 'c', args: [] });
  calls[0].settle({ ok: true });
  await new Promise((resolve) => setImmediate(resolve));
  clock = 1400;
  calls[1].settle({ ok: true });
  await new Promise((resolve) => setImmediate(resolve));
  clock = 1600;
  const newest = jobs.start({ agent: 'd', args: [] });

  assert.equal(jobs.status(first.id), null);
  assert.equal(jobs.status(second.id), null, 'the completed job is evicted after the expired one');
  assert.deepEqual(new Set(jobs.list().map((job) => job.id)), new Set([running.id, newest.id]));
});

test('completed bursts return to the retention limit without another dispatch', async () => {
  const { spawnJob, calls } = fakeSpawner();
  const jobs = createJobRegistry({ spawnJob, limit: 2 });
  const ids = Array.from({ length: 5 }, () => jobs.start({ agent: 'a', args: [] }).id);
  assert.equal(jobs.list().length, 5, 'active jobs must never be evicted to meet a retention limit');
  for (const call of calls) call.settle({ ok: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(jobs.list().length, 2);
  assert.deepEqual(new Set(jobs.list().map((job) => job.id)), new Set(ids.slice(-2)));
});

test('a synchronous launch failure releases ownership and leaves no phantom job', () => {
  const failure = new Error('spawn unavailable');
  const settled = [];
  const jobs = createJobRegistry({ spawnJob: () => { throw failure; } });
  assert.throws(() => jobs.start({ agent: 'a', args: [], onSettled: (job) => settled.push(job) }), failure);
  assert.equal(settled.length, 1);
  assert.equal(settled[0].state, 'failed');
  assert.equal(settled[0].error, 'spawn unavailable');
  assert.deepEqual(jobs.list(), []);
});

test('cleanup preserves a cancellation whose child has not stopped', async () => {
  let clock = 1000;
  let settle;
  const jobs = createJobRegistry({
    now: () => clock, ttlMs: 100, limit: 1,
    spawnJob: () => ({ pid: 4242, kill: () => {}, promise: new Promise((resolve) => { settle = resolve; }) }),
  });
  const first = jobs.start({ agent: 'a', args: [] });
  const completeFirst = settle;
  assert.equal((await jobs.cancel(first.id, { waitMs: 1 })).ack, false);
  clock += 1000;
  const second = jobs.start({ agent: 'b', args: [] });
  const completeSecond = settle;
  assert.notEqual(jobs.status(first.id), null, 'an unconfirmed cancellation still owns its controller');
  completeFirst({ ok: false, status: 'cancelled' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(jobs.status(first.id), null, 'the record can be evicted once the child actually settles');
  assert.equal(jobs.status(second.id).running, true);
  completeSecond({ ok: true });
  await new Promise((resolve) => setImmediate(resolve));
});

test('a wrapper exit retains a negative cancel verdict and completes ownership cleanup first', async () => {
  let finish, released = 0;
  const promise = new Promise((resolve) => { finish = resolve; });
  const jobs = createJobRegistry({ spawnJob: () => ({
    pid: 1234, promise,
    kill: () => finish({ok:false,status:'cancelled',cancelAck:false}),
  }) });
  const {id} = jobs.start({agent:'a',args:[],onSettled:()=>{released+=1;}});
  const outcome = await jobs.cancel(id);
  assert.equal(outcome.ack,false);
  assert.match(outcome.detail,/agent did not confirm/);
  assert.equal(released,1);
  assert.equal(jobs.result(id).answer.cancelAck,false);
  assert.equal(jobs.status(id).cancelAck,false);
});

test('a job carries its session label, running and finished', async () => {
  const { spawnJob, calls } = fakeSpawner();
  const jobs = createJobRegistry({ spawnJob });
  const labelled = jobs.start({ agent: 'claude', prompt: 'p', cwd: '/r', args: [], label: 'a-1' });
  const plain = jobs.start({ agent: 'claude', prompt: 'p', cwd: '/r2', args: [] });
  assert.equal(jobs.status(labelled.id).sessionLabel, 'a-1');
  calls[0].settle({ ok: true, status: 'ok', tools: [] });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(jobs.status(labelled.id).running, false);
  assert.equal(jobs.status(labelled.id).sessionLabel, 'a-1');
  assert.equal(jobs.status(plain.id).sessionLabel, null);
});

// ── a held permission ───────────────────────────────────────────────────────

test('a held request makes the job waiting-permission, and an answer releases it', async () => {
  const states = [];
  let captured;
  const jobs = createJobRegistry({
    spawnJob: ({ hold }) => {
      captured = hold;
      return { pid: 4242, kill: () => {}, promise: new Promise(() => {}) };
    },
  });
  const { id } = jobs.start({
    agent: 'claude',
    prompt: 'edit the module',
    cwd: '/repo',
    args: [],
    onPermissionChange: (job) => states.push(job.state),
  });

  const answer = captured({ requestId: 'perm-1', title: 'Run npm test', toolKind: 'execute', locations: [] });
  const status = jobs.status(id);
  assert.equal(status.state, 'waiting-permission');
  assert.equal(status.running, true, 'a waiting job is still active');
  assert.equal(status.pendingPermission.requestId, 'perm-1');
  assert.equal(status.pendingPermission.title, 'Run npm test');
  assert.equal(status.pendingPermission.toolKind, 'execute');
  assert.ok(status.pendingPermission.heldMs >= 0);

  const outcome = jobs.answer(id, 'reject', 'perm-1');
  assert.equal(outcome.ok, true);
  assert.equal(outcome.requestId, 'perm-1');
  assert.equal(outcome.decision, 'reject');
  assert.equal(await answer, 'reject');

  // The child confirms it closed the request: the job is running again.
  jobs.closePermission(id, 'perm-1');
  assert.equal(jobs.status(id).state, 'running');
  assert.equal(jobs.status(id).pendingPermission, null);

  const again = jobs.answer(id, 'allow_once', 'perm-1');
  assert.equal(again.ok, false);
  assert.match(again.reason, new RegExp(`no pending permission request for ${id}`));
  assert.deepEqual(states, ['waiting-permission', 'running']);
});

test('a job waiting for permission can still be cancelled', async () => {
  let captured;
  const jobs = createJobRegistry({
    spawnJob: ({ hold }) => {
      captured = hold;
      return { pid: 7, kill: () => {}, promise: new Promise(() => {}) };
    },
  });
  const { id } = jobs.start({ agent: 'a', args: [] });
  captured({ requestId: 'perm-2', title: 'x', toolKind: 'edit', locations: [] });
  assert.equal(jobs.status(id).state, 'waiting-permission');
  const outcome = await jobs.cancel(id, { waitMs: 10 });
  assert.equal(outcome.ok, true);
  assert.equal(jobs.status(id).state, 'cancelled');
});

test('two held requests are answered by id, and the job clears only when both close', async () => {
  let captured;
  const jobs = createJobRegistry({
    spawnJob: ({ hold }) => {
      captured = hold;
      return { pid: 9, kill: () => {}, promise: new Promise(() => {}) };
    },
  });
  const { id } = jobs.start({ agent: 'a', args: [] });
  const first = captured({ requestId: 'perm-1', title: 'one', toolKind: 'execute', locations: [] });
  const second = captured({ requestId: 'perm-2', title: 'two', toolKind: 'fetch', locations: [] });
  assert.equal(jobs.status(id).pendingPermissionCount, 2);
  assert.equal(jobs.status(id).pendingPermission.requestId, 'perm-1', 'status shows the oldest');

  // The request id is required: an answer must name the request that was read.
  const bare = jobs.answer(id, 'allow_once');
  assert.equal(bare.ok, false);
  assert.match(bare.reason, /requestId is required/);

  // An answer can only land on the request it names.
  const wrong = jobs.answer(id, 'allow_once', 'perm-9');
  assert.equal(wrong.ok, false);
  assert.match(wrong.reason, /no pending permission request for .*\(perm-9\)/);

  assert.equal(jobs.answer(id, 'reject', 'perm-2').ok, true);
  assert.equal(await second, 'reject');
  jobs.closePermission(id, 'perm-2');
  assert.equal(jobs.status(id).state, 'waiting-permission', 'the first is still held');
  assert.equal(jobs.status(id).pendingPermission.requestId, 'perm-1');
  assert.equal(jobs.answer(id, 'reject', 'perm-2').ok, false, 'an answered request cannot be answered twice');

  assert.equal(jobs.answer(id, 'allow_once', 'perm-1').ok, true);
  jobs.closePermission(id, 'perm-1');
  assert.equal(jobs.status(id).state, 'running');
  assert.equal(jobs.status(id).pendingPermissionCount, 0);
  assert.equal(await first, 'allow_once');
});

test('a request that arrives after the job was cancelled is refused, not surfaced', async () => {
  let captured;
  const jobs = createJobRegistry({
    spawnJob: ({ hold }) => {
      captured = hold;
      return { pid: 11, kill: () => {}, promise: new Promise(() => {}) };
    },
  });
  const { id } = jobs.start({ agent: 'a', args: [] });
  await jobs.cancel(id, { waitMs: 10 });
  assert.equal(jobs.status(id).state, 'cancelled');

  const late = await captured({ requestId: 'perm-late', title: 'too late', toolKind: 'execute', locations: [] });
  assert.equal(late, 'reject');
  assert.equal(jobs.status(id).pendingPermissionCount, 0);
  assert.equal(jobs.status(id).state, 'cancelled', 'a cancelled job never reopens as waiting');
});

test('an answer to a cancelled job is refused instead of reported as sent', async () => {
  // The child dies while a request is still in the map (its permission-closed
  // never arrives). Reporting "sent" would leave the person waiting on an ack
  // that cannot come; the cancelled state is the honest answer.
  let captured;
  let settle;
  const jobs = createJobRegistry({
    spawnJob: ({ hold }) => {
      captured = hold;
      return { pid: 12, kill: () => {}, promise: new Promise((resolve) => { settle = resolve; }) };
    },
  });
  const { id } = jobs.start({ agent: 'a', args: [] });
  captured({ requestId: 'perm-held', title: 'still here', toolKind: 'execute', locations: [] });
  assert.equal(jobs.status(id).pendingPermissionCount, 1);

  const cancelled = await jobs.cancel(id, { waitMs: 10 });
  assert.equal(cancelled.ok, true, 'the kill was sent');
  assert.equal(jobs.status(id).state, 'cancelled');
  assert.equal(jobs.status(id).pendingPermissionCount, 1, 'the child never closed its request');

  const answer = jobs.answer(id, 'allow_once', 'perm-held');
  assert.deepEqual(answer, { ok: false, reason: `no pending permission request for ${id}` });

  settle({ ok: false, status: 'cancelled' });
  await new Promise((resolve) => setImmediate(resolve));
});

test('a dead child\'s held permission is dropped, so it cannot wait forever', async () => {
  let captured;
  const states = [];
  const jobs = createJobRegistry({
    spawnJob: ({ hold }) => {
      captured = hold;
      return { pid: 13, kill: () => {}, promise: new Promise(() => {}) };
    },
  });
  const { id } = jobs.start({
    agent: 'a',
    args: [],
    onPermissionChange: (job) => states.push(job.state),
  });
  const answer = captured({ requestId: 'perm-dead', title: 'Run npm test', toolKind: 'execute', locations: [] });
  assert.equal(jobs.status(id).state, 'waiting-permission');

  const dropped = jobs.dropPermissions(id);
  assert.equal(dropped, 1);
  assert.equal(jobs.status(id).pendingPermissionCount, 0);
  assert.equal(jobs.status(id).state, 'running', 'nothing is held, so the job reads as running');
  assert.equal(await answer, 'reject', 'the waiting turn ends as a refusal, not a hang');
  assert.deepEqual(states, ['waiting-permission', 'running']);
  assert.equal(jobs.dropPermissions(id), 0, 'dropping again is a no-op');
});
