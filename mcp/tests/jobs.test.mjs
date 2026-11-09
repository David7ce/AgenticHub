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
