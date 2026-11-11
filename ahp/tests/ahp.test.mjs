/**
 * AHP integration tests: the consent proxy and the gateway config generator.
 * No network and no real agents: a fake ACP agent stands in.
 *
 *   node --test agent-hub/ahp/tests/ahp.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkGate, createStats, lineTap, parseArgs, turnRecord } from '../consent-proxy.mjs';
import { GATEWAY_BUILTINS, buildConfig } from '../gen-config.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROXY = join(HERE, '..', 'consent-proxy.mjs');
const FAKE = join(HERE, '..', '..', 'bridge', 'tests', 'fixtures', 'fake-acp-agent.mjs');
const FUTURE = new Date(Date.now() + 30 * 86_400_000).toISOString();
const NOTHING_SPENT = { usd: 0, tokens: 0 };

const grant = (extra = {}) => ({
  enabled: true,
  overseerAck: true,
  expires: FUTURE,
  limits: { maxPermission: 'allow-reads' },
  ...extra,
});

function workspace(consent) {
  const dir = mkdtempSync(join(tmpdir(), 'ahp-proxy-'));
  const registry = join(dir, 'agents.json');
  const consentFile = join(dir, 'consent.json');
  const log = join(dir, 'runs.jsonl');
  const fakeLog = join(dir, 'fake.log');
  writeFileSync(
    registry,
    JSON.stringify({ agents: { fake: { command: process.execPath, args: [FAKE], env: { FAKE_ACP_LOG: fakeLog } } } }),
  );
  writeFileSync(consentFile, JSON.stringify(consent));
  return { dir, registry, consentFile, log, fakeLog };
}

// Runs the proxy as a child, feeds it ACP lines, closes stdin and collects everything.
function runProxy(ws, lines, { waitMs = 600 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [PROXY, '--agent', 'fake', '--registry', ws.registry, '--consent', ws.consentFile],
      { env: { ...process.env, AGENT_HUB_LOG: ws.log }, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('exit', (code) => resolve({ code, stdout, stderr }));
    child.stdin.on('error', () => {}); // a refused proxy exits before we finish writing
    for (const line of lines) child.stdin.write(`${JSON.stringify(line)}\n`);
    setTimeout(() => child.stdin.end(), waitMs);
  });
}

const acpTurn = [
  { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1 } },
  { jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd: 'D:/work/tree', mcpServers: [] } },
  {
    jsonrpc: '2.0',
    id: 3,
    method: 'session/prompt',
    params: { sessionId: 'fake-session', prompt: [{ type: 'text', text: 'EXTRAS' }] },
  },
];

test('parseArgs requires --agent and rejects unknown flags', () => {
  assert.equal(parseArgs(['--agent', 'claude']).agent, 'claude');
  assert.throws(() => parseArgs([]));
  assert.throws(() => parseArgs(['--agent', 'x', '--yolo']));
});

test('lineTap reads JSON lines across chunk boundaries and ignores noise', () => {
  const seen = [];
  const tap = lineTap((m) => seen.push(m));
  tap(Buffer.from('{"a":1}\nnot json\n{"b"'));
  tap(Buffer.from(':2}\n\n'));
  assert.deepEqual(seen, [{ a: 1 }, { b: 2 }]);
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

test('the proxy passes ACP through untouched and writes one audit line per turn, with its cost', async () => {
  const ws = workspace({ fake: grant() });
  const { stdout } = await runProxy(ws, acpTurn);
  const replies = stdout.trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(replies.some((m) => m.id === 1 && m.result?.agentInfo?.name === 'fake-acp'), 'initialize answered');
  assert.ok(replies.some((m) => m.id === 3 && m.result?.stopReason === 'end_turn'), 'prompt answered');
  const text = replies
    .filter((m) => m.params?.update?.sessionUpdate === 'agent_message_chunk')
    .map((m) => m.params.update.content.text)
    .join('');
  assert.equal(text, 'Hello from fake');
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

test('a refused grant never starts the agent and is audited with the reason', async () => {
  const ws = workspace({ fake: grant({ enabled: false }) });
  const { code, stderr } = await runProxy(ws, acpTurn, { waitMs: 100 });
  assert.equal(code, 3);
  assert.match(stderr, /refused by the hub gate/);
  assert.equal(existsSync(ws.fakeLog), false, 'the fake agent was never launched');
  const audit = JSON.parse(readFileSync(ws.log, 'utf8').trim());
  assert.equal(audit.status, 'refused');
  assert.match(audit.reason, /no consent recorded/);
});

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
});

test('--all adds agents without a grant, which then refuse at start-up', () => {
  const registry = { agents: { hermes: { label: 'Hermes' } } };
  const cfg = buildConfig({ registry, consent: { grants: { hermes: { enabled: false } } }, all: true });
  assert.deepEqual(cfg.providers.filter((p) => p.enabled !== false).map((p) => p.id), ['hermes']);
});
