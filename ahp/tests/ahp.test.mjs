/**
 * AHP integration tests: the consent proxy, the permission clamp and the gateway config
 * generator. No network and no real agents: a fake ACP agent stands in.
 *
 *   node --test agent-hub/ahp/tests/ahp.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkGate, createStats, lineSplitter, parseArgs, turnRecord } from '../consent-proxy.mjs';
import { createClamp } from '../permission-clamp.mjs';
import { GATEWAY_BUILTINS, buildConfig } from '../gen-config.mjs';
import { patchGateway } from '../gateway-patch.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROXY = join(HERE, '..', 'consent-proxy.mjs');
const FAKE = join(HERE, 'fixtures', 'fake-acp-agent.mjs');
const FUTURE = new Date(Date.now() + 30 * 86_400_000).toISOString();
const NOTHING_SPENT = { usd: 0, tokens: 0 };
const OPEN_TREE = 'D:/work';
const MODES = { restricted: { force: 'plan', allow: ['plan'] } };
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const grant = (extra = {}) => ({
  enabled: true,
  overseerAck: true,
  expires: FUTURE,
  limits: { maxPermission: 'allow-all', writeTrees: [OPEN_TREE] },
  ...extra,
});

function workspace(consent, { modes = MODES } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ahp-proxy-'));
  const registry = join(dir, 'agents.json');
  const consentFile = join(dir, 'consent.json');
  const log = join(dir, 'runs.jsonl');
  const fakeLog = join(dir, 'fake.log');
  const entry = {
    command: process.execPath,
    args: [FAKE],
    env: { FAKE_ACP_LOG: fakeLog, FAKE_ACP_MODE_OPTION: '1' },
  };
  if (modes) entry.permissionModes = modes;
  writeFileSync(registry, JSON.stringify({ agents: { fake: entry } }));
  writeFileSync(consentFile, JSON.stringify(consent));
  return { dir, registry, consentFile, log, fakeLog };
}

// Runs the proxy as a child and feeds it ACP lines one by one (a client waits for each
// reply before using its result), then closes stdin and collects everything.
async function runProxy(ws, lines, { settleMs = 400, gapMs = 150 } = {}) {
  const child = spawn(
    process.execPath,
    [PROXY, '--agent', 'fake', '--registry', ws.registry, '--consent', ws.consentFile],
    { env: { ...process.env, AGENT_HUB_LOG: ws.log }, stdio: ['pipe', 'pipe', 'pipe'] },
  );
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => (stdout += d));
  child.stderr.on('data', (d) => (stderr += d));
  child.stdin.on('error', () => {}); // a refused proxy exits before we finish writing
  const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
  for (const line of lines) {
    child.stdin.write(`${JSON.stringify(line)}\n`);
    await delay(gapMs);
  }
  await delay(settleMs);
  child.stdin.end();
  const code = await exited;
  return { code, stdout, stderr, replies: stdout.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) };
}

const newSession = (cwd, id = 2) => ({ jsonrpc: '2.0', id, method: 'session/new', params: { cwd, mcpServers: [] } });
const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1 } };
const prompt = (id = 3) => ({
  jsonrpc: '2.0',
  id,
  method: 'session/prompt',
  params: { sessionId: 'fake-session', prompt: [{ type: 'text', text: 'EXTRAS' }] },
});

test('parseArgs requires --agent and rejects unknown flags', () => {
  assert.equal(parseArgs(['--agent', 'claude']).agent, 'claude');
  assert.throws(() => parseArgs([]));
  assert.throws(() => parseArgs(['--agent', 'x', '--yolo']));
});

test('lineSplitter yields complete lines across chunk boundaries, tolerates CRLF and blank lines', () => {
  const seen = [];
  const split = lineSplitter((l) => seen.push(l));
  split(Buffer.from('{"a":1}\nnot json\r\n{"b"'));
  split(Buffer.from(':2}\n\n'));
  assert.deepEqual(seen, ['{"a":1}', 'not json', '{"b":2}']);
});

test('a turn ends when the agent answers its session/prompt, and adds only the cost since the last one', () => {
  const turns = [];
  const stats = createStats({ onTurn: (t) => turns.push(t) });
  const usage = (sessionId, amount) => ({
    method: 'session/update',
    params: { sessionId, update: { sessionUpdate: 'usage_update', cost: { amount, currency: 'USD' } } },
  });
  stats.fromClient({ method: 'session/new', id: 1, params: { cwd: 'D:/x' } });
  stats.fromClient({ method: 'session/prompt', id: 7, params: { sessionId: 's1' } });
  stats.fromAgent(usage('s1', 0.1));
  assert.equal(turns.length, 0, 'not over until the prompt is answered');
  stats.fromAgent({ id: 7, result: { stopReason: 'end_turn' } });
  stats.fromClient({ method: 'session/prompt', id: 8, params: { sessionId: 's1' } });
  stats.fromAgent(usage('s1', 0.35)); // cumulative: the second turn adds 0.25
  stats.fromAgent({ id: 8, result: { stopReason: 'end_turn' } });
  stats.fromClient({ method: 'session/prompt', id: 9, params: { sessionId: 's1' } });
  stats.fromAgent({ id: 9, error: { message: 'boom' } });
  assert.equal(stats.cwd, 'D:/x');
  assert.equal(stats.sessions, 1);
  assert.equal(stats.turns, 3);
  assert.deepEqual(turns.map((t) => t.cost?.amount ?? null), [0.1, 0.25, null]);
  assert.equal(turns[2].error, 'boom');
  const record = turnRecord({ agent: 'claude', turn: turns[1], stats, startedAt: Date.now() - 50 });
  assert.equal(record.transport, 'ahp');
  assert.equal(record.status, 'ok');
  assert.equal(record.cost.currency, 'USD');
});

test('checkGate follows the grant: enabled, acknowledged, not expired, under the daily cap', () => {
  const gate = (consent, spent = NOTHING_SPENT) => {
    const ws = workspace(consent);
    return checkGate({ agent: 'fake', consent: ws.consentFile, logPath: ws.log, spent });
  };
  assert.equal(gate({ fake: grant() }).ok, true);
  assert.equal(gate({ fake: grant({ enabled: false }) }).ok, false);
  assert.equal(gate({ fake: grant({ overseerAck: false }) }).ok, false);
  assert.match(gate({ fake: grant({ expires: '2020-01-01T00:00:00Z' }) }).reason, /expired/);
  assert.match(gate({ fake: grant({ limits: { maxDailyUsd: 1 } }) }, { usd: 1, tokens: 0 }).reason, /daily cap/);
});

// ---- the permission clamp, as a pure state machine ---------------------------------------

const modeOption = (current = 'auto') => ({
  id: 'mode', type: 'select', currentValue: current,
  options: ['default', 'plan', 'auto'].map((value) => ({ value })),
});
const opened = (id, sessionId = 's1') => ({ jsonrpc: '2.0', id, result: { sessionId, configOptions: [modeOption()] } });

test('clamp: a session under writeTrees is left alone', () => {
  const clamp = createClamp({ agent: 'a', limits: grant().limits, modes: MODES });
  assert.equal(clamp.fromClient(newSession('D:/work/tree', 5)).forward, true);
  const verdict = clamp.fromAgent(opened(5));
  assert.equal(verdict.msg, undefined, 'response not rewritten');
  assert.equal(verdict.inject, undefined);
  assert.equal(clamp.restrictedSessions(), 0);
});

test('clamp: outside writeTrees the mode is forced, the options are cut and a later switch is refused', () => {
  const clamp = createClamp({ agent: 'a', limits: grant().limits, modes: MODES });
  assert.equal(clamp.fromClient(newSession('D:/elsewhere', 5)).forward, true);
  const verdict = clamp.fromAgent(opened(5));
  const mode = verdict.msg.result.configOptions.find((o) => o.id === 'mode');
  assert.equal(mode.currentValue, 'plan');
  assert.deepEqual(mode.options.map((o) => o.value), ['plan']);
  assert.deepEqual(verdict.inject.map((m) => [m.method, m.params.configId, m.params.value]), [['session/set_config_option', 'mode', 'plan']]);
  // The proxy's own request is answered by the agent; that reply must not reach the client.
  assert.equal(clamp.fromAgent({ jsonrpc: '2.0', id: verdict.inject[0].id, result: { configOptions: [] } }).forward, false);

  const denied = clamp.fromClient({ jsonrpc: '2.0', id: 9, method: 'session/set_config_option', params: { sessionId: 's1', configId: 'mode', value: 'auto' } });
  assert.equal(denied.forward, false);
  assert.equal(denied.reply.error.code, -32602);
  assert.match(denied.reply.error.message, /not allowed/);
  assert.equal(clamp.fromClient({ jsonrpc: '2.0', id: 10, method: 'session/set_config_option', params: { sessionId: 's1', configId: 'mode', value: 'plan' } }).forward, true);
  assert.equal(clamp.fromClient({ jsonrpc: '2.0', id: 11, method: 'session/set_mode', params: { sessionId: 's1', modeId: 'auto' } }).forward, false);
  // Other options (model, effort) are not the clamp's business.
  assert.equal(clamp.fromClient({ jsonrpc: '2.0', id: 12, method: 'session/set_config_option', params: { sessionId: 's1', configId: 'model', value: 'x' } }).forward, true);
});

test('clamp: grouped mode options are filtered inside their groups', () => {
  const clamp = createClamp({ agent: 'a', limits: grant().limits, modes: MODES });
  clamp.fromClient(newSession('D:/elsewhere', 5));
  const grouped = { jsonrpc: '2.0', id: 5, result: { sessionId: 's1', configOptions: [{
    id: 'mode', type: 'select', currentValue: 'auto',
    options: [{ group: 'g', options: [{ value: 'plan' }, { value: 'auto' }] }],
  }] } };
  const mode = clamp.fromAgent(grouped).msg.result.configOptions[0];
  assert.deepEqual(mode.options[0].options.map((o) => o.value), ['plan']);
});

test('clamp: no registered restricted mode means a restricted session is refused, not left open', () => {
  const clamp = createClamp({ agent: 'hermes', limits: grant().limits, modes: undefined });
  const verdict = clamp.fromClient(newSession('D:/elsewhere', 5));
  assert.equal(verdict.forward, false);
  assert.match(verdict.reply.error.message, /no restricted mode registered/);
  // ...while a session under writeTrees still opens.
  assert.equal(clamp.fromClient(newSession('D:/work/x', 6)).forward, true);
});

test('clamp: a grant without writeTrees restricts everything outside the scratch folder', () => {
  const clamp = createClamp({ agent: 'a', limits: { maxPermission: 'allow-all', writeTrees: [] }, modes: MODES });
  clamp.fromClient(newSession('D:/work/tree', 5));
  assert.ok(clamp.fromAgent(opened(5)).inject, 'restricted');
  const scratch = join(tmpdir(), 'ahp-scratch');
  clamp.fromClient(newSession(scratch, 6));
  assert.equal(clamp.fromAgent(opened(6, 's2')).inject, undefined, 'the scratch folder stays open');
});

test('clamp: a session that does not say where it runs counts as restricted (fail closed)', () => {
  const clamp = createClamp({ agent: 'a', limits: { maxPermission: 'allow-all', writeTrees: ['D:/work/x'] }, modes: MODES });
  const verdict = clamp.fromClient({ jsonrpc: '2.0', id: 7, method: 'session/new', params: { cwd: '' } });
  assert.equal(verdict.forward, true);
  const forced = clamp.fromAgent(opened(7, 's1'));
  assert.ok(forced.inject, 'the restricted mode is imposed');
  assert.equal(forced.inject[0].params.value, 'plan');
  const missing = createClamp({ agent: 'a', limits: { maxPermission: 'allow-all', writeTrees: ['D:/work/x'] }, modes: MODES });
  missing.fromClient({ jsonrpc: '2.0', id: 8, method: 'session/new', params: {} });
  assert.ok(missing.fromAgent(opened(8, 's2')).inject, 'no cwd at all is not open either');
});

test('clamp: a restricted session cannot widen itself through a permission request (switch_mode, edit, execute...)', () => {
  const clamp = createClamp({ agent: 'a', limits: grant().limits, modes: MODES });
  clamp.fromClient(newSession('D:/elsewhere', 5));
  clamp.fromAgent(opened(5));
  const ask = (id, kind, sessionId = 's1') => ({
    jsonrpc: '2.0', id, method: 'session/request_permission',
    params: { sessionId, toolCall: { toolCallId: 't', kind }, options: [
      { optionId: 'yes', name: 'Approve', kind: 'allow_once' },
      { optionId: 'no', name: 'Reject', kind: 'reject_once' },
    ] },
  });
  const verdict = clamp.fromAgent(ask(30, 'switch_mode'));
  assert.equal(verdict.forward, false, 'the person is not even asked');
  assert.deepEqual(verdict.answer, { jsonrpc: '2.0', id: 30, result: { outcome: { outcome: 'selected', optionId: 'no' } } });
  for (const [i, kind] of ['edit', 'delete', 'move', 'execute'].entries()) {
    assert.equal(clamp.fromAgent(ask(40 + i, kind)).forward, false, `${kind} is refused here`);
  }
  // Read-only requests still go to the person, and so does another session's.
  assert.equal(clamp.fromAgent(ask(31, 'read')).forward, true);
  assert.equal(clamp.fromAgent(ask(32, 'switch_mode', 'other')).forward, true);
  // With no reject option the answer is a cancellation, never an approval.
  const bare = { ...ask(33, 'switch_mode'), params: { ...ask(33, 'switch_mode').params, options: [{ optionId: 'yes', kind: 'allow_once' }] } };
  assert.deepEqual(clamp.fromAgent(bare).answer.result.outcome, { outcome: 'cancelled' });
});

test('clamp: if the restricted mode cannot be set, the session is refused rather than left permissive', () => {
  const clamp = createClamp({ agent: 'a', limits: grant().limits, modes: MODES });
  clamp.fromClient(newSession('D:/elsewhere', 5));
  const sent = clamp.fromAgent(opened(5)).inject[0];
  const verdict = clamp.fromAgent({ jsonrpc: '2.0', id: sent.id, error: { code: -32602, message: 'unknown mode plan' } });
  assert.equal(verdict.forward, false);
  assert.match(verdict.failed, /unknown mode/);
  const prompt = clamp.fromClient({ jsonrpc: '2.0', id: 8, method: 'session/prompt', params: { sessionId: 's1', prompt: [] } });
  assert.equal(prompt.forward, false);
  assert.match(prompt.reply.error.message, /will not run/);
  // Another session is not affected.
  assert.equal(clamp.fromClient({ jsonrpc: '2.0', id: 9, method: 'session/prompt', params: { sessionId: 'other', prompt: [] } }).forward, true);
});

const ATTENDED = { force: 'acceptEdits', allow: ['default', 'acceptEdits', 'plan'] };
const ATTENDED_MODES = { restricted: MODES.restricted, attended: ATTENDED };
const ask = (id, kind, sessionId = 's1') => ({
  jsonrpc: '2.0', id, method: 'session/request_permission',
  params: { sessionId, toolCall: { toolCallId: 't', kind }, options: [
    { optionId: 'yes', name: 'Approve', kind: 'allow_once' },
    { optionId: 'no', name: 'Reject', kind: 'reject_once' },
  ] },
});

test('clamp: attendedWriteTrees, not writeTrees, decide which sessions are open for an attended client', () => {
  const limits = { maxPermission: 'allow-all', writeTrees: [], attendedWriteTrees: [OPEN_TREE] };
  const clamp = createClamp({ agent: 'a', limits, modes: ATTENDED_MODES });
  clamp.fromClient(newSession('D:/work/tree', 5));
  assert.equal(clamp.fromAgent(opened(5)).inject.length, 1, 'an attended session is still put in its attended mode');
  assert.equal(clamp.restrictedSessions(), 0, 'but it is not restricted');
  clamp.fromClient(newSession('D:/other', 6));
  clamp.fromAgent(opened(6, 's2'));
  assert.equal(clamp.restrictedSessions(), 1, 'outside the attended trees it is');
  // With no attendedWriteTrees the grant's writeTrees apply as before.
  const plain = createClamp({ agent: 'a', limits: { maxPermission: 'allow-all', writeTrees: [OPEN_TREE] }, modes: MODES });
  assert.equal(plain.fromClient(newSession('D:/work/x', 7)).forward, true);
  assert.equal(plain.fromAgent(opened(7)).inject, undefined);
});

test('clamp: an open session gets the attended mode, hides the modes outside its list and still lets edit/execute requests reach the person', () => {
  const clamp = createClamp({ agent: 'a', limits: grant().limits, modes: ATTENDED_MODES });
  clamp.fromClient(newSession('D:/work/tree', 5));
  const verdict = clamp.fromAgent(opened(5));
  const mode = verdict.msg.result.configOptions.find((o) => o.id === 'mode');
  assert.equal(mode.currentValue, 'acceptEdits');
  assert.deepEqual(mode.options.map((o) => o.value), ['default', 'plan']);
  assert.deepEqual(verdict.inject.map((m) => m.params.value), ['acceptEdits']);
  const set = (id, value) => ({ jsonrpc: '2.0', id, method: 'session/set_config_option', params: { sessionId: 's1', configId: 'mode', value } });
  assert.equal(clamp.fromClient(set(9, 'auto')).forward, false, 'cannot leave for a permissive mode');
  assert.equal(clamp.fromClient(set(10, 'bypassPermissions')).forward, false);
  assert.equal(clamp.fromClient(set(11, 'plan')).forward, true, 'a stricter mode is fine');
  // The person is the control here: edits and commands are put to them, not refused.
  assert.equal(clamp.fromAgent(ask(30, 'edit')).forward, true);
  assert.equal(clamp.fromAgent(ask(31, 'execute')).forward, true);
});

// ---- the proxy as a process --------------------------------------------------------------

test('the proxy passes ACP through untouched and writes one audit line per turn, with its cost', async () => {
  const ws = workspace({ fake: grant() });
  const { replies } = await runProxy(ws, [init, newSession('D:/work/tree'), prompt()]);
  assert.ok(replies.some((m) => m.id === 1 && m.result?.agentInfo?.name === 'fake-acp'), 'initialize answered');
  assert.ok(replies.some((m) => m.id === 3 && m.result?.stopReason === 'end_turn'), 'prompt answered');
  const text = replies
    .filter((m) => m.params?.update?.sessionUpdate === 'agent_message_chunk')
    .map((m) => m.params.update.content.text)
    .join('');
  assert.equal(text, 'Hello from fake');
  const opened = replies.find((m) => m.id === 2);
  assert.equal(opened.result.configOptions[0].currentValue, 'auto', 'not clamped under writeTrees');
  assert.ok(!readFileSync(ws.fakeLog, 'utf8').includes('set:mode'), 'no mode forced under writeTrees');
  const audit = readFileSync(ws.log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(audit.length, 1);
  assert.equal(audit[0].agent, 'fake');
  assert.equal(audit[0].transport, 'ahp');
  assert.equal(audit[0].status, 'ok');
  assert.equal(audit[0].stopReason, 'end_turn');
  assert.equal(audit[0].turn, 1);
  assert.equal(audit[0].cwd, 'D:/work/tree');
  assert.equal(audit[0].cost.amount, 0.5);
});

test('outside writeTrees the proxy forces the restricted mode, shows only the allowed modes and refuses a switch', async () => {
  const ws = workspace({ fake: grant() });
  const attempt = { jsonrpc: '2.0', id: 9, method: 'session/set_config_option', params: { sessionId: 'fake-session', configId: 'mode', value: 'auto' } };
  const { replies } = await runProxy(ws, [init, newSession('D:/elsewhere'), attempt]);
  const events = readFileSync(ws.fakeLog, 'utf8');
  assert.match(events, /set:mode=plan/, 'the agent was put in plan mode');
  assert.ok(!events.includes('set:mode=auto'), 'the switch never reached the agent');
  const mode = replies.find((m) => m.id === 2).result.configOptions[0];
  assert.equal(mode.currentValue, 'plan');
  assert.deepEqual(mode.options.map((o) => o.value), ['plan']);
  assert.equal(replies.find((m) => m.id === 9).error.code, -32602);
  assert.ok(!replies.some((m) => String(m.id).startsWith('hubproxy')), 'the proxy\'s own request stays internal');
});

test('through the proxy an attended session is put in the attended mode, a restricted one in the restricted mode', async () => {
  const modes = { restricted: MODES.restricted, attended: { force: 'default', allow: ['default', 'plan'] } };
  const ws = workspace({ fake: grant() }, { modes });
  const { replies } = await runProxy(ws, [init, newSession('D:/work/tree')]);
  assert.match(readFileSync(ws.fakeLog, 'utf8'), /set:mode=default/);
  const mode = replies.find((m) => m.id === 2).result.configOptions[0];
  assert.equal(mode.currentValue, 'default');
  assert.deepEqual(mode.options.map((o) => o.value), ['default', 'plan']);
});

test('attendedEnv reaches the agent the proxy starts, and only there', async () => {
  const ws = workspace({ fake: grant() });
  const registry = JSON.parse(readFileSync(ws.registry, 'utf8'));
  registry.agents.fake.attendedEnv = { FAKE_ATTENDED_ENV: 'ask-shell' };
  writeFileSync(ws.registry, JSON.stringify(registry));
  await runProxy(ws, [init]);
  assert.match(readFileSync(ws.fakeLog, 'utf8'), /attended-env:ask-shell/);
});

test('a restricted session with no restricted mode registered is refused before it reaches the agent', async () => {
  const ws = workspace({ fake: grant() }, { modes: null });
  const { replies } = await runProxy(ws, [init, newSession('D:/elsewhere')]);
  assert.match(replies.find((m) => m.id === 2).error.message, /no restricted mode registered/);
  assert.ok(!readFileSync(ws.fakeLog, 'utf8').includes('session'), 'session/new never reached the agent');
});

test('a refused grant never starts the agent and is audited with the reason', async () => {
  const ws = workspace({ fake: grant({ enabled: false }) });
  const { code, stderr } = await runProxy(ws, [init, newSession('D:/work/tree')], { settleMs: 50, gapMs: 20 });
  assert.equal(code, 3);
  assert.match(stderr, /refused by the hub gate/);
  assert.equal(existsSync(ws.fakeLog), false, 'the fake agent was never launched');
  const audit = JSON.parse(readFileSync(ws.log, 'utf8').trim());
  assert.equal(audit.status, 'refused');
  assert.match(audit.reason, /no consent recorded/);
});

// ---- the gateway configuration -----------------------------------------------------------

test('buildConfig makes providers only for granted agents, behind the proxy, and switches the other built-ins off', () => {
  const registry = { agents: { claude: { label: 'Claude' }, codex: { label: 'Codex' }, hermes: { label: 'Hermes' } } };
  const consent = { grants: { claude: { enabled: true }, codex: { enabled: true }, hermes: { enabled: false } } };
  const cfg = buildConfig({ registry, consent, port: 9000, proxy: '/p/consent-proxy.mjs', node: '/n/node' });
  assert.equal(cfg.listener.port, 9000);
  assert.equal(cfg.listener.allowAnyOrigin, false);
  assert.deepEqual(cfg.listener.allowedOrigins, ['vscode-file://vscode-app']);
  const ours = cfg.providers.filter((p) => p.enabled !== false);
  assert.deepEqual(ours.map((p) => p.id), ['claude', 'codex']);
  assert.deepEqual(ours[0].args, ['/p/consent-proxy.mjs', '--agent', 'claude']);
  assert.equal(ours[0].command, '/n/node');
  const off = cfg.providers.filter((p) => p.enabled === false).map((p) => p.id);
  assert.ok(off.includes('hermes') && off.includes('copilot') && off.includes('pi'));
  assert.ok(!off.includes('claude'));
  assert.equal(new Set(cfg.providers.map((p) => p.id)).size, cfg.providers.length, 'no duplicate ids');
  assert.ok(GATEWAY_BUILTINS.includes('opencode'));
  assert.deepEqual(ours.map((p) => p.displayName), ['Claude · AgentHub', 'Codex · AgentHub'],
    'the window shows which door the agent came through, without the adapter suffix');
});

test('buildConfig drops the "(ACP adapter)" suffix from the label before adding the door', () => {
  const registry = { agents: { claude: { label: 'Claude Agent (ACP adapter)' } } };
  const cfg = buildConfig({ registry, consent: { grants: { claude: { enabled: true } } }, proxy: '/p', node: '/n' });
  assert.equal(cfg.providers.find((p) => p.id === 'claude').displayName, 'Claude Agent · AgentHub');
});

test('--all adds agents without a grant, which then refuse at start-up', () => {
  const registry = { agents: { hermes: { label: 'Hermes' } } };
  const cfg = buildConfig({ registry, consent: { grants: { hermes: { enabled: false } } }, all: true });
  assert.deepEqual(cfg.providers.filter((p) => p.enabled !== false).map((p) => p.id), ['hermes']);
});

// ---- the gateway patch (idempotent createSession, request log) ----------------------------

function fakeServer() {
  class Server {
    constructor() { this.sessions = new Map(); this.created = 0; }
    get store() { return { getSession: (uri) => this.sessions.get(uri) ?? null }; }
    async createSession(_connection, params) {
      if (this.sessions.has(params.channel)) throw new Error('Session already exists');
      this.sessions.set(params.channel, { provider: params.provider, state: { lifecycle: 'creating' } });
      this.created++;
      await delay(40); // the agent starting
      this.sessions.get(params.channel).state.lifecycle = 'ready';
      return null;
    }
    async handle(_connection, request) {
      if (request.method === 'boom') throw new Error('nope');
      return request.method === 'createSession' ? this.createSession(null, request.params) : 'ok';
    }
  }
  return Server;
}

test('patched createSession: a repeat of a session that exists is answered as success once it is ready', async () => {
  const Server = fakeServer();
  const events = [];
  patchGateway(Server, { log: (e) => events.push(e), pollMs: 5 });
  const server = new Server();
  const params = { channel: 'ahp-session:/abcdef12', provider: 'opencode' };
  const first = server.createSession(null, params); // still creating when the repeat arrives
  await delay(5);
  assert.equal(await server.createSession(null, params), null, 'the repeat waits for the first and succeeds');
  assert.equal(await first, null);
  assert.equal(await server.createSession(null, params), null, 'and again once it is ready');
  assert.equal(server.created, 1, 'the agent was started once');
  assert.deepEqual(events.filter((e) => e.event === 'createSession-repeat').map((e) => e.lifecycle), ['creating', 'ready']);
});

test('patched createSession: a different provider on an existing URI still gets the gateway error, a new URI still creates', async () => {
  const Server = fakeServer();
  patchGateway(Server);
  const server = new Server();
  await server.createSession(null, { channel: 'ahp-session:/aaaaaaaa', provider: 'opencode' });
  await assert.rejects(server.createSession(null, { channel: 'ahp-session:/aaaaaaaa', provider: 'claude' }), /already exists/);
  await server.createSession(null, { channel: 'ahp-session:/bbbbbbbb', provider: 'claude' });
  assert.equal(server.created, 2);
});

test('patchGateway refuses a gateway whose methods were renamed', () => {
  class Renamed {
    async handle() { return null; }
  }
  assert.throws(() => patchGateway(Renamed), /createSession is gone from this gateway version/);
  class NoHandle {
    async createSession() { return null; }
  }
  assert.throws(() => patchGateway(NoHandle), /handle is gone from this gateway version/);
});

test('patched createSession retries once when the provider fails to start, and only once', async () => {
  const events = [];
  class Server {
    constructor(failures) { this.failures = failures; this.created = 0; this.store = { getSession: () => null }; }
    async handle() { return null; }
    async createSession() {
      this.created++;
      if (this.created <= this.failures) throw new Error('ACP provider OpenCode · AgentHub (opencode) failed (reference abc-123). Run npm install');
      return null;
    }
  }
  patchGateway(Server, { log: (e) => events.push(e), sleep: async () => {} });
  const ok = new Server(1);
  assert.equal(await ok.createSession(null, { channel: 'ahp-session:/aaaaaaaa', provider: 'opencode' }), null);
  assert.equal(ok.created, 2, 'one retry');
  assert.equal(events.filter((e) => e.event === 'createSession-retry').length, 1);
  assert.equal(events[0].provider, 'opencode');

  const broken = new Server(99);
  await assert.rejects(broken.createSession(null, { channel: 'ahp-session:/bbbbbbbb', provider: 'opencode' }), /failed \(reference/);
  assert.equal(broken.created, 2, 'no more than one retry');
  const other = new Server(0);
  await assert.rejects(
    (() => { class S extends Server { async createSession() { throw new Error('consent: opencode may not write in D:/x'); } } const s = new S(0); return s.createSession(null, { channel: 'ahp-session:/cccccccc' }); })(),
    /consent:/,
  );
});

test('patched subscribe declines a windowed-delivery offer instead of failing, and leaves other subscribes alone', async () => {
  const seen = [];
  class Server {
    async subscribe(_connection, params) {
      if (params.flowControl !== undefined) throw new Error('Windowed subscriptions are not implemented');
      seen.push(params);
      return { snapshot: { resource: params.channel } };
    }
    async handle() { return null; }
    async createSession() { return null; }
  }
  patchGateway(Server);
  const server = new Server();
  const offered = { channel: 'ahp-chat:/abc', flowControl: { receive: { windowBytes: 65536, maximumFrameBytes: 4096 } } };
  const result = await server.subscribe(null, offered);
  assert.deepEqual(result, { snapshot: { resource: 'ahp-chat:/abc' } });
  assert.equal(result.flowControl, undefined, 'the offer is declined: no flowControl in the result');
  assert.deepEqual(seen[0], { channel: 'ahp-chat:/abc' });
  assert.deepEqual(offered.flowControl.receive.windowBytes, 65536, 'the caller object is not mutated');
  await server.subscribe(null, { channel: 'ahp-root://' });
  assert.equal(seen.length, 2);
});

test('patched handle records a session config change, its result and the reason when the gateway rejects it', async () => {
  const events = [];
  class Server {
    constructor() {
      this.values = { mode: 'plan' };
      this.store = {
        reject: (_r, _a, _o, reason) => ({ rejected: reason }),
        getSession: () => ({ state: { config: { values: this.values } } }),
      };
    }
    async createSession() { return null; }
    async handle(_c, request) {
      const mode = request.params.action.config.mode;
      if (mode === 'bad') this.store.reject('s', {}, {}, 'Invalid value for session config mode');
      else this.values = { mode };
      return null;
    }
  }
  patchGateway(Server, { log: (e) => events.push(e) });
  const server = new Server();
  const send = (mode) => server.handle(null, { method: 'dispatchAction', params: { channel: 'ahp-session:/abcdef12', action: { type: 'session/configChanged', config: { mode } } } });
  await send('build');
  await new Promise((r) => setTimeout(r, 1100)); // another second, so the next line is not collapsed
  await send('bad');
  const [ok, bad] = events.filter((e) => e.event === 'rpc');
  assert.equal(ok.asked, '{"mode":"build"}');
  assert.equal(ok.after, '{"mode":"build"}');
  assert.equal(ok.rejected, undefined);
  assert.equal(bad.rejected, 'Invalid value for session config mode');
  assert.equal(bad.after, '{"mode":"build"}', 'the value did not change');
  assert.equal(typeof server.store.reject, 'function');
});

test('patched dispatchSessionConfig drops a field the agent does not declare instead of failing the whole update', async () => {
  const events = [];
  class Server {
    constructor() {
      this.values = { mode: 'plan' };
      this.store = {
        getSession: () => ({
          state: {
            config: {
              values: this.values,
              schema: { properties: { mode: { type: 'string', enum: ['plan', 'build'], sessionMutable: true } } },
            },
          },
        }),
        reject: (_r, _a, _o, reason) => { throw new Error(reason); },
        apply: (_r, action) => { this.values = { ...this.values, ...action.config }; return action; },
      };
    }
    async createSession() { return null; }
    async handle() { return null; }
    async dispatchSessionConfig(sessionResource, action) {
      const schema = this.store.getSession(sessionResource).state.config.schema.properties;
      // The gateway's own rule: one unknown key fails the whole update.
      for (const [configId, value] of Object.entries(action.config)) {
        if (!schema[configId]) throw new Error(`Unknown or immutable session config ${configId}`);
        if (!schema[configId].enum.includes(value)) throw new Error(`Invalid value for session config ${configId}`);
      }
      const envelope = this.store.apply(sessionResource, action);
      this.lastEnvelope = envelope;
      return envelope;
    }
  }
  patchGateway(Server, { log: (e) => events.push(e) });
  const server = new Server();
  const action = {
    type: 'session/configChanged',
    config: { mode: 'build', effort: 'default', sensitiveEditLocations: { paths: ['D:/Workspaces/x'] } },
  };
  const envelope = await server.dispatchSessionConfig('ahp-session:/abcdef12', action, 'client');
  assert.deepEqual(envelope.config, { mode: 'build' }, 'the mode is applied and the unknown fields are gone');
  assert.equal(server.values.mode, 'build');
  const drop = events.find((e) => e.event === 'config-drop');
  assert.deepEqual(drop.dropped.sort(), ['effort', 'sensitiveEditLocations']);
  assert.ok(!JSON.stringify(events).includes('D:/Workspaces/x'), 'no parameter values are logged');

  await assert.rejects(
    server.dispatchSessionConfig('ahp-session:/abcdef12', { type: 'session/configChanged', config: { mode: 'bad' } }, 'client'),
    /Invalid value for session config mode/,
    'a known field with a bad value still fails',
  );
  assert.deepEqual(action.config, { mode: 'build', effort: 'default', sensitiveEditLocations: { paths: ['D:/Workspaces/x'] } },
    'the caller object is not mutated');
}
);

test('patched handle keeps the action type and collapses a burst of identical requests into one line a second', async () => {
  const Server = fakeServer();
  const events = [];
  patchGateway(Server, { log: (e) => events.push(e) });
  const server = new Server();
  const request = { method: 'dispatchAction', params: { channel: 'ahp-chat:/12345678', action: { type: 'chat/turnStarted', text: 'private' } } };
  for (let i = 0; i < 50; i++) await server.handle(null, request);
  await server.handle(null, { ...request, params: { ...request.params, action: { type: 'chat/draftChanged' } } });
  const rpc = events.filter((e) => e.event === 'rpc');
  assert.ok(rpc.length <= 4, `one line per type and second, got ${rpc.length}`);
  assert.deepEqual([...new Set(rpc.map((e) => e.action))].sort(), ['chat/draftChanged', 'chat/turnStarted']);
  assert.ok(!JSON.stringify(events).includes('private'));
});

test('patched handle logs method, session suffix, parameter names and timing, never values, and rethrows errors', async () => {
  const Server = fakeServer();
  const events = [];
  patchGateway(Server, { log: (e) => events.push(e) });
  const server = new Server();
  await server.handle(null, { id: 7, method: 'dispatchAction', params: { channel: 'ahp-chat:/12345678', action: { text: 'secret words' } } });
  await assert.rejects(server.handle(null, { id: 8, method: 'boom', params: {} }), /nope/);
  const rpc = events.filter((e) => e.event === 'rpc');
  assert.deepEqual(rpc[0].keys, ['channel', 'action']);
  assert.equal(rpc[0].channel, '12345678');
  assert.ok(typeof rpc[0].ms === 'number');
  assert.equal(rpc[1].error, 'nope');
  assert.ok(!JSON.stringify(events).includes('secret words'), 'no parameter values are logged');
});

import { appendRotating } from '../gateway-patch.mjs';

test('a successful ping is not logged, a failing one still is', async () => {
  const Server = fakeServer();
  const events = [];
  patchGateway(Server, { log: (e) => events.push(e) });
  const server = new Server();
  await server.handle(null, { id: 1, method: 'ping', params: { channel: '-root://' } });
  assert.equal(events.length, 0);
  Server.prototype.handle = async () => { throw new Error('down'); };
  patchGateway(Server, { log: (e) => events.push(e) });
  await assert.rejects(server.handle(null, { id: 2, method: 'ping', params: {} }));
  assert.equal(events.filter((e) => e.error).length, 1);
});

test('the request log is rotated to .prev when it reaches its size, keeping one generation', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rpc-log-'));
  const path = join(dir, 'rpc.log');
  for (let i = 0; i < 5; i++) appendRotating(path, `line ${i} ${'x'.repeat(30)}\n`, { maxBytes: 100 });
  assert.ok(readFileSync(path, 'utf8').split('\n').filter(Boolean).length <= 3, 'the live log stays small');
  assert.ok(existsSync(`${path}.prev`), 'the full one was kept');
  assert.equal(readdirSync(dir).length, 2, 'only one older generation');
});

test('the per-request memory does not grow with every session the gateway ever served', async () => {
  const Server = fakeServer();
  const events = [];
  patchGateway(Server, { log: (e) => events.push(e) });
  const server = new Server();
  const realNow = Date.now;
  let t = realNow();
  Date.now = () => t;
  try {
    for (let i = 0; i < 600; i++) {
      t += 2000; // each session a couple of seconds apart: older keys fall out of the minute window
      await server.handle(null, { id: i, method: 'dispatchAction', params: { channel: `ahp-chat:/s${String(i).padStart(7, '0')}`, action: { type: 'chat/draftChanged' } } });
    }
  } finally { Date.now = realNow; }
  assert.equal(events.length, 600, 'every distinct session still gets its line');
  assert.ok(Server.prototype.handle.recentSize() < 300, `the map kept ${Server.prototype.handle.recentSize()} keys`);
});
