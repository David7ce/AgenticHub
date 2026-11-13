import test from 'node:test';
import assert from 'node:assert/strict';

import { knownProviders, providerOf, pruneModelMap } from '../vscode-state.mjs';

test('providerOf reads the BYOK provider out of a model id', () => {
  assert.equal(providerOf('agent-host-copilotcli:openrouter/OpenRouter/deepseek/deepseek-v4.1-flash'), 'openrouter/OpenRouter');
  assert.equal(providerOf('agent-host-copilotcli:customendpoint/OpenCode Go/iceman-contributor-free'), 'customendpoint/OpenCode Go');
  assert.equal(providerOf('copilot/auto'), null, 'a built-in provider is not a BYOK one');
  assert.equal(providerOf('agent-host-copilotcli:auto'), null);
});

test('pruneModelMap drops entries whose provider is not configured, and keeps the rest', () => {
  const known = knownProviders([{ vendor: 'openrouter', name: 'OpenRouter' }]);
  const map = {
    'agent-host-copilotcli:openrouter/OpenRouter/deepseek/deepseek-v4.1-flash': {},
    'agent-host-copilotcli:customendpoint/OpenCode Go/iceman-contributor-free': {},
    'agent-host-copilotcli:auto': {},
    'copilot/auto': { tier: 'efficiency' },
  };
  const { value, dropped } = pruneModelMap(map, known);
  assert.deepEqual(dropped, ['agent-host-copilotcli:customendpoint/OpenCode Go/iceman-contributor-free']);
  assert.deepEqual(Object.keys(value).sort(), [
    'agent-host-copilotcli:auto',
    'agent-host-copilotcli:openrouter/OpenRouter/deepseek/deepseek-v4.1-flash',
    'copilot/auto',
  ]);
});

test('the current-model pointer is cleared when its provider is gone', () => {
  const known = knownProviders([{ vendor: 'openrouter', name: 'OpenRouter' }]);
  const gone = pruneModelMap('agent-host-copilotcli:customendpoint/Custom Endpoint/gpt-luna', known);
  assert.equal(gone.value, null);
  assert.equal(gone.dropped.length, 1);
  const fine = pruneModelMap('agent-host-copilotcli:openrouter/OpenRouter/deepseek/deepseek-v4.1-flash', known);
  assert.equal(fine.value, 'agent-host-copilotcli:openrouter/OpenRouter/deepseek/deepseek-v4.1-flash');
  assert.deepEqual(fine.dropped, []);
});
