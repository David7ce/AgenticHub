import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planClean } from '../commands/clean.mjs';

test('clean never plans a worktree that has changes', () => {
  const plan = planClean({
    worktrees: [{ path: 'a', dirty: false }, { path: 'b', dirty: true }],
    inflight: [
      { alive: false, file: '/i/dead.json' },
      { alive: null, file: '/i/unknown.json' },
      { alive: true, file: '/i/live.json' },
    ],
  });
  assert.deepEqual(plan.worktrees, ['a']);
  assert.deepEqual(plan.keptDirty, ['b']);
  // Only a pid proven dead on this platform is reaped; unknown (other side of
  // WSL) and live records stay.
  assert.deepEqual(plan.inflight, ['/i/dead.json']);
});
