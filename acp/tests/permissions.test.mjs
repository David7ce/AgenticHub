import test from 'node:test';
import assert from 'node:assert/strict';

import { makePermissionHandler } from '../acp-client.mjs';

const options = [
  { optionId: 'allow-once', kind: 'allow_once' },
  { optionId: 'allow-always', kind: 'allow_always' },
  { optionId: 'reject-once', kind: 'reject_once' },
];

const read = { toolCallId: 't1', title: 'Read a file', kind: 'read', status: 'pending' };
const edit = { toolCallId: 't2', title: 'Write a file', kind: 'edit', status: 'pending' };
const exec = { toolCallId: 't3', title: 'Run a command', kind: 'execute', status: 'pending' };

test('deny rejects an otherwise safe tool', async () => {
  const outcome = await makePermissionHandler('deny')({ toolCall: read, options });
  assert.deepEqual(outcome, { outcome: { outcome: 'selected', optionId: 'reject-once' } });
});

test('allow-reads permits read/search/fetch/think', async () => {
  for (const kind of ['read', 'search', 'fetch', 'think']) {
    const outcome = await makePermissionHandler('allow-reads')({
      toolCall: { ...read, kind },
      options,
    });
    assert.equal(outcome.outcome.optionId, 'allow-once', kind);
  }
});

test('allow-reads still rejects edit/execute', async () => {
  for (const toolCall of [edit, exec]) {
    const outcome = await makePermissionHandler('allow-reads')({ toolCall, options });
    assert.equal(outcome.outcome.optionId, 'reject-once', toolCall.kind);
  }
});

test('allow-all picks allow_once, never allow_always implicitly', async () => {
  const outcome = await makePermissionHandler('allow-all')({ toolCall: exec, options });
  assert.equal(outcome.outcome.optionId, 'allow-once');
});

test('no reject option means cancelled, not allowed', async () => {
  const outcome = await makePermissionHandler('deny')({
    toolCall: read,
    options: [{ optionId: 'allow-once', kind: 'allow_once' }],
  });
  assert.deepEqual(outcome, { outcome: { outcome: 'cancelled' } });
});

test('permission decisions are reported with the policy and tool kind', async () => {
  const logged = [];
  const handler = makePermissionHandler('allow-reads', (d) => logged.push(d));
  await handler({ toolCall: read, options });
  await handler({ toolCall: edit, options });
  assert.deepEqual(
    logged.map((d) => [d.decision, d.kind, d.policy]),
    [
      ['allow', 'read', 'allow-reads'],
      ['reject', 'edit', 'allow-reads'],
    ],
  );
});
