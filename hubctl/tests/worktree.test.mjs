import test from 'node:test';
import assert from 'node:assert/strict';

import { ageLabel, planPrune } from '../hubctl.mjs';

const rows = [
  { path: '/w/clean-a', dirty: false },
  { path: '/w/dirty-b', dirty: true },
  { path: '/w/clean-c', dirty: false },
];

test('prune removes the clean worktrees and keeps the dirty ones', () => {
  const plan = planPrune(rows);
  assert.deepEqual(plan.remove.map((r) => r.path), ['/w/clean-a', '/w/clean-c']);
  assert.deepEqual(plan.keep.map((r) => r.path), ['/w/dirty-b']);
});

test('--force discards work, so only then are dirty trees removed', () => {
  const plan = planPrune(rows, { force: true });
  assert.equal(plan.remove.length, 3);
  assert.deepEqual(plan.keep, []);
});

test('an empty list plans nothing', () => {
  assert.deepEqual(planPrune([]), { remove: [], keep: [] });
});

test('ages read as days, hours, or unknown', () => {
  assert.equal(ageLabel(3.2), '3d');
  assert.equal(ageLabel(0.5), '12h');
  assert.equal(ageLabel(0.01), '1h');
  assert.equal(ageLabel(null), '?');
});
