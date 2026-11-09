import assert from 'node:assert/strict';
import test from 'node:test';

import {
  addTask,
  claimNext,
  costAmount,
  finishTask,
  getTask,
  listTasks,
  newTaskId,
  openTaskDb,
  renderTasks,
  retryTask,
  setTaskWorktree,
} from '../tasks.mjs';

function fresh() {
  return openTaskDb(':memory:');
}

test('addTask stores a queued task with a generated id', () => {
  const db = fresh();
  const task = addTask(db, { repo: 'D:/repo', agent: 'opencode', prompt: 'do the thing' });
  assert.match(task.id, /^t-\d{8}-\d{6}-[0-9a-f]{4}$/);
  assert.equal(task.state, 'queued');
  assert.equal(task.title, 'do the thing');
  assert.equal(task.attempts, 0);
  assert.equal(getTask(db, task.id).agent, 'opencode');
});

test('addTask rejects an empty prompt, repo or agent', () => {
  const db = fresh();
  assert.throws(() => addTask(db, { repo: 'D:/r', agent: 'a', prompt: '  ' }), /needs a prompt/);
  assert.throws(() => addTask(db, { repo: '', agent: 'a', prompt: 'x' }), /needs a repo/);
  assert.throws(() => addTask(db, { repo: 'D:/r', agent: '', prompt: 'x' }), /needs an agent/);
});

test('claimNext takes the oldest task once and marks it running', () => {
  const db = fresh();
  const first = addTask(db, { repo: 'D:/r', agent: 'opencode', prompt: 'one' });
  addTask(db, { repo: 'D:/r', agent: 'opencode', prompt: 'two' });

  const claimed = claimNext(db, '2026-11-09T00:00:00Z');
  assert.equal(claimed.id, first.id);
  assert.equal(claimed.state, 'running');
  assert.equal(claimed.attempts, 1);
  assert.equal(claimed.started_at, '2026-11-09T00:00:00Z');

  const second = claimNext(db, '2026-11-09T00:01:00Z');
  assert.notEqual(second.id, first.id);
  assert.equal(claimNext(db, '2026-11-09T00:02:00Z'), null);
});

test('claimNext refuses a task another worker already took', () => {
  const db = fresh();
  addTask(db, { repo: 'D:/r', agent: 'opencode', prompt: 'only' });
  const first = claimNext(db);
  assert.ok(first);
  assert.equal(claimNext(db), null);
  assert.equal(getTask(db, first.id).state, 'running');
});

test('finishTask moves to review without evidence but done requires it', () => {
  const db = fresh();
  const task = addTask(db, { repo: 'D:/r', agent: 'opencode', prompt: 'x' });
  claimNext(db);

  const review = finishTask(db, task.id, { state: 'review', result: 'ok', cost: 0.01 });
  assert.equal(review.state, 'review');
  assert.equal(review.cost, 0.01);
  assert.ok(review.finished_at);

  assert.throws(() => finishTask(db, task.id, { state: 'done' }), /needs --evidence/);
  const done = finishTask(db, task.id, { state: 'done', evidence: 'D:/diff.patch' });
  assert.equal(done.state, 'done');
  assert.equal(done.evidence, 'D:/diff.patch');
});

test('finishTask rejects an unknown state', () => {
  const db = fresh();
  const task = addTask(db, { repo: 'D:/r', agent: 'a', prompt: 'x' });
  assert.throws(() => finishTask(db, task.id, { state: 'exploded' }), /unknown task state/);
});

test('retryTask returns a blocked task to the queue and clears the error', () => {
  const db = fresh();
  const task = addTask(db, { repo: 'D:/r', agent: 'a', prompt: 'x' });
  claimNext(db);
  finishTask(db, task.id, { state: 'blocked', error: 'boom' });

  const retried = retryTask(db, task.id);
  assert.equal(retried.state, 'queued');
  assert.equal(retried.error, null);
  assert.equal(retried.started_at, null);
  assert.throws(() => retryTask(db, 'missing'), /no such task/);
});

test('setTaskWorktree records where the run happened', () => {
  const db = fresh();
  const task = addTask(db, { repo: 'D:/r', agent: 'a', prompt: 'x' });
  setTaskWorktree(db, task.id, 'D:/r/.git/agent-worktrees/run');
  assert.equal(getTask(db, task.id).worktree, 'D:/r/.git/agent-worktrees/run');
});

test('listTasks filters by state and renderTasks prints a table', () => {
  const db = fresh();
  addTask(db, { repo: 'D:/r', agent: 'opencode', prompt: 'one' });
  const two = addTask(db, { repo: 'D:/r', agent: 'codex', prompt: 'two' });
  claimNext(db);
  finishTask(db, two.id, { state: 'blocked', error: 'no' });

  assert.equal(listTasks(db).length, 2);
  assert.equal(listTasks(db, { state: 'blocked' }).length, 1);
  const text = renderTasks(listTasks(db));
  assert.match(text, /ID\s+STATE/);
  assert.match(text, new RegExp(two.id));
  assert.equal(renderTasks([]), 'no tasks\n');
});

test('costAmount accepts a number and the ACP { amount } shape', () => {
  assert.equal(costAmount(0.01), 0.01);
  assert.equal(costAmount({ amount: 0, currency: 'USD' }), 0);
  assert.equal(costAmount(undefined), null);
  assert.equal(costAmount('nope'), null);
});

test('finishTask stores an object cost as a number', () => {
  const db = fresh();
  const task = addTask(db, { repo: 'D:/r', agent: 'a', prompt: 'x' });
  claimNext(db);
  const closed = finishTask(db, task.id, {
    state: 'review',
    cost: { amount: 0.02, currency: 'USD' },
  });
  assert.equal(closed.cost, 0.02);
});

test('finishTask clears the worktree only when the key is present', () => {
  const db = fresh();
  const task = addTask(db, { repo: 'D:/r', agent: 'a', prompt: 'x' });
  claimNext(db);
  setTaskWorktree(db, task.id, 'D:/r/.git/agent-worktrees/run');

  const kept = finishTask(db, task.id, { state: 'review', result: 'ok' });
  assert.equal(kept.worktree, 'D:/r/.git/agent-worktrees/run');

  const cleared = finishTask(db, task.id, { state: 'done', evidence: 'diff', worktree: null });
  assert.equal(cleared.worktree, null);
});

test('newTaskId is stable in shape and unique', () => {  const ids = new Set(Array.from({ length: 50 }, () => newTaskId()));
  assert.equal(ids.size, 50);
});
