import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planClean } from '../commands/clean.mjs';

test('clean never plans a worktree that has changes', () => {
  const plan = planClean({
    worktrees: [{ path: 'a', dirty: false }, { path: 'b', dirty: true }],
    backups: ['old'],
  });
  assert.deepEqual(plan.worktrees, ['a']);
  assert.deepEqual(plan.keptDirty, ['b']);
  assert.deepEqual(plan.backups, ['old']);
});
