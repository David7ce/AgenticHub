import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createModelFilter } from '../model-filter.mjs';

const POLICY = { allow: ['opencode-go/'], default: 'opencode-go/deepseek-v4.1-flash' };
const opt = (values, currentValue) => ({ id: 'model', type: 'select', currentValue, options: values.map((value) => ({ value, name: value })) });
const reply = (id, configOptions, sessionId = 's1') => ({ jsonrpc: '2.0', id, result: { sessionId, configOptions } });
const open = (f, id = 1) => f.fromClient({ jsonrpc: '2.0', id, method: 'session/new', params: { cwd: 'D:/x' } });

test('keeps only allowed models and leaves other options alone', () => {
  const f = createModelFilter({ agent: 'opencode', policy: POLICY });
  open(f);
  const mode = { id: 'mode', currentValue: 'build', options: [{ value: 'build' }] };
  const out = f.fromAgent(reply(1, [opt(['opencode/gpt-6-luna', 'opencode-go/glm-5.3', 'opencode-go/kimi-k3'], 'opencode-go/glm-5.3'), mode]));
  assert.deepEqual(out.msg.result.configOptions[0].options.map((o) => o.value), ['opencode-go/glm-5.3', 'opencode-go/kimi-k3']);
  assert.equal(out.msg.result.configOptions[0].currentValue, 'opencode-go/glm-5.3');
  assert.deepEqual(out.msg.result.configOptions[1], mode);
  assert.equal(out.inject, undefined);
});

test('a current model outside the list is moved to the default and the agent is told', () => {
  const f = createModelFilter({ agent: 'opencode', policy: POLICY });
  open(f);
  const out = f.fromAgent(reply(1, [opt(['opencode/claude-opus-5-5', 'opencode-go/deepseek-v4.1-flash'], 'opencode/claude-opus-5-5')]));
  assert.equal(out.msg.result.configOptions[0].currentValue, 'opencode-go/deepseek-v4.1-flash');
  assert.equal(out.inject.length, 1);
  assert.deepEqual(out.inject[0].params, { sessionId: 's1', configId: 'model', value: 'opencode-go/deepseek-v4.1-flash' });
  // the agent's answer to that injected request never reaches the client
  assert.deepEqual(f.fromAgent({ jsonrpc: '2.0', id: out.inject[0].id, result: {} }), { swallow: true });
});

test('falls back to the first allowed model when the default is not in the list', () => {
  const f = createModelFilter({ agent: 'opencode', policy: { allow: ['opencode-go/'], default: 'opencode-go/gone' } });
  open(f);
  const out = f.fromAgent(reply(1, [opt(['opencode/a', 'opencode-go/b', 'opencode-go/c'], 'opencode/a')]));
  assert.equal(out.msg.result.configOptions[0].currentValue, 'opencode-go/b');
});

test('refuses a switch to a model outside the list, by config option or set_model', () => {
  const f = createModelFilter({ agent: 'opencode', policy: POLICY });
  const a = f.fromClient({ jsonrpc: '2.0', id: 7, method: 'session/set_config_option', params: { sessionId: 's1', configId: 'model', value: 'opencode/gpt-6-luna' } });
  assert.equal(a.forward, false);
  assert.equal(a.reply.error.code, -32602);
  const b = f.fromClient({ jsonrpc: '2.0', id: 8, method: 'session/set_model', params: { sessionId: 's1', modelId: 'opencode/gpt-6-luna' } });
  assert.equal(b.forward, false);
  assert.equal(f.fromClient({ jsonrpc: '2.0', id: 9, method: 'session/set_config_option', params: { sessionId: 's1', configId: 'model', value: 'opencode-go/kimi-k3' } }).forward, true);
  // other options are none of its business
  assert.equal(f.fromClient({ jsonrpc: '2.0', id: 10, method: 'session/set_config_option', params: { sessionId: 's1', configId: 'effort', value: 'high' } }).forward, true);
});

test('handles grouped options and is inert without a policy', () => {
  const f = createModelFilter({ agent: 'opencode', policy: POLICY });
  open(f);
  const grouped = { id: 'model', currentValue: 'opencode-go/a', options: [
    { group: 'zen', options: [{ value: 'opencode/x' }] },
    { group: 'go', options: [{ value: 'opencode-go/a' }, { value: 'opencode/y' }] },
  ] };
  const out = f.fromAgent(reply(1, [grouped]));
  assert.deepEqual(out.msg.result.configOptions[0].options, [{ group: 'go', options: [{ value: 'opencode-go/a' }] }]);
  const none = createModelFilter({ agent: 'claude', policy: undefined });
  assert.equal(none.active, false);
  assert.deepEqual(none.fromAgent(reply(1, [opt(['a'], 'a')])), {});
  assert.equal(none.fromClient({ jsonrpc: '2.0', id: 1, method: 'session/set_model', params: { modelId: 'z' } }).forward, true);
});
