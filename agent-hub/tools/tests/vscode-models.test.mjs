import test from 'node:test';
import assert from 'node:assert/strict';

import { applyByok, checkByokModels, diffByok, diffGroup } from '../vscode-models.mjs';

const curated = {
  groups: [
    { name: 'OpenRouter', vendor: 'openrouter', models: ['a/one', 'b/two'] },
  ],
};

test('diffGroup reports what is missing and what should go', () => {
  const d = diffGroup(curated.groups[0], { name: 'OpenRouter', vendor: 'openrouter', models: ['b/two', 'c/three'] });
  assert.deepEqual(d.missing, ['a/one']);
  assert.deepEqual(d.extra, ['c/three']);
  assert.equal(d.missingGroup, false);
});

test('a group without a models array means every provider model: drift, not zero', () => {
  const d = diffGroup(curated.groups[0], { name: 'OpenRouter', vendor: 'openrouter' });
  assert.deepEqual(d.missing, ['a/one', 'b/two']);
  assert.deepEqual(d.extra, []);
});

test('diffByok matches by vendor and name, and reports a missing group', () => {
  const same = diffByok(curated, [{ name: 'OpenRouter', vendor: 'openrouter', models: ['a/one', 'b/two'] }]);
  assert.deepEqual(same[0].missing, []);
  assert.deepEqual(same[0].extra, []);
  const missing = diffByok(curated, [{ name: 'Other', vendor: 'openrouter', models: [] }]);
  assert.equal(missing[0].missingGroup, true);
});

test('applyByok writes the ids and keeps the vendor and the key reference', () => {
  const keyRef = ['${input:chat.lm.secret.', 'x}'].join('');
  const user = [{ name: 'OpenRouter', vendor: 'openrouter', apiKey: keyRef, models: ['c/three'] }];
  const result = applyByok(curated, user);
  assert.equal(result.written, true);
  assert.deepEqual(user[0].models, ['a/one', 'b/two']);
  assert.equal(user[0].apiKey, keyRef);
  assert.equal(applyByok(curated, user).written, false, 'a second apply is a no-op');
});

test('checkByokModels is quiet when in sync and points at the fix when it drifts', () => {
  const inSync = checkByokModels(curated, [{ name: 'OpenRouter', vendor: 'openrouter', models: ['a/one', 'b/two'] }]);
  assert.equal(inSync[0].level, 'ok');
  assert.match(inSync[0].detail, /2 models match/);

  const drifted = checkByokModels(curated, [{ name: 'OpenRouter', vendor: 'openrouter', models: ['a/one'] }]);
  assert.equal(drifted[0].level, 'warn');
  assert.match(drifted[0].detail, /--apply/);

  assert.equal(checkByokModels(curated, null)[0].level, 'ok', 'no VS Code config is not a failure');
  assert.equal(checkByokModels(null, [])[0].level, 'warn', 'a missing curated file is a warning');
});
