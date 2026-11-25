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

// close() races the agent's exit against a grace timer. The timer used to stay
// pending after the agent had gone, which kept the hub process alive for the
// whole grace period at the end of every turn (1.5 s by default).
test('close() does not keep the process alive once the agent has exited', async () => {
  const { spawnSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const client = fileURLToPath(new URL('../acp-client.mjs', import.meta.url));
  const agent = fileURLToPath(new URL('../../mcp/tests/fixtures/fake-acp-agent.mjs', import.meta.url));
  const script = `
    const { AcpClient } = await import(${JSON.stringify(new URL('../acp-client.mjs', import.meta.url).href)});
    const c = new AcpClient({ command: process.execPath, args: [${JSON.stringify(agent)}] });
    c.start(); await c.initialize();
    await c.close({ graceMs: 20000 });
  `;
  assert.ok(client);
  const started = Date.now();
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 30_000 });
  assert.equal(run.status, 0, run.stderr);
  assert.ok(Date.now() - started < 10_000, `exited in ${Date.now() - started} ms, not after the 20 s grace`);
});
