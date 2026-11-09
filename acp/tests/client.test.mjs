import test from 'node:test';
import assert from 'node:assert/strict';

import { windowsPathToWsl, makePermissionHandler, AcpClient } from '../acp-client.mjs';

test('translates a Windows drive path to the WSL mount', () => {
  assert.equal(windowsPathToWsl('D:\\Workspaces\\AgentHub'), '/mnt/d/Workspaces/AgentHub');
  assert.equal(windowsPathToWsl('C:\\Users\\user\\x'), '/mnt/c/Users/user/x');
});

test('accepts forward slashes on Windows paths', () => {
  assert.equal(windowsPathToWsl('D:/Workspaces/AgentHub/agent-hub'), '/mnt/d/Workspaces/AgentHub/agent-hub');
});

test('leaves POSIX paths alone', () => {
  assert.equal(windowsPathToWsl('/mnt/d/Workspaces/AgentHub'), '/mnt/d/Workspaces/AgentHub');
});

test('an unknown tool kind is rejected under allow-reads', async () => {
  const outcome = await makePermissionHandler('allow-reads')({
    toolCall: { toolCallId: 't', title: 'mystery', kind: 'other' },
    options: [{ optionId: 'a', kind: 'allow_once' }, { optionId: 'r', kind: 'reject_once' }],
  });
  assert.equal(outcome.outcome.optionId, 'r');
});

test('loadSession refuses without the agent capability', async () => {
  const client = new AcpClient({ command: 'node' });
  client.agentCapabilities = {};
  await assert.rejects(
    () => client.loadSession({ sessionId: 's', cwd: '/tmp' }),
    /loadSession capability/,
  );
});

test('resumeSession refuses without the agent capability', async () => {
  const client = new AcpClient({ command: 'node' });
  client.agentCapabilities = {};
  await assert.rejects(
    () => client.resumeSession({ sessionId: 's', cwd: '/tmp' }),
    /resume capability/,
  );
});

test('both session methods require an id', async () => {
  const client = new AcpClient({ command: 'node' });
  client.agentCapabilities = { loadSession: true, sessionCapabilities: { resume: {} } };
  await assert.rejects(() => client.loadSession({ cwd: '/tmp' }), /sessionId is required/);
  await assert.rejects(() => client.resumeSession({ cwd: '/tmp' }), /sessionId is required/);
});
