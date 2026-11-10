import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  TOOLS,
  PROTOCOL_VERSION,
  handleMessage,
  callTool,
  renderAsk,
  renderFanout,
  renderAgents,
  renderRoute,
} from '../core.mjs';

// The fallback chain comes from the registry, which is local and git-ignored.
// Pin it, or the test silently changes meaning with the owner's config (the
// opencode -> codex fallback added on 2026-11-10 broke exactly that).
const REGISTRY_DIR = mkdtempSync(join(tmpdir(), 'mcp-registry-'));
const REGISTRY = join(REGISTRY_DIR, 'agents.json');
writeFileSync(REGISTRY, JSON.stringify({ agents: {
  opencode: { agentFallbacks: ['claude'] },
  claude: {},
  codex: {},
} }));

function withRegistry(fn) {
  const previous = process.env.AGENT_HUB_REGISTRY;
  process.env.AGENT_HUB_REGISTRY = REGISTRY;
  return Promise.resolve().then(fn).finally(() => {
    if (previous === undefined) delete process.env.AGENT_HUB_REGISTRY;
    else process.env.AGENT_HUB_REGISTRY = previous;
  });
}

const ok = (overrides = {}) => ({
  ok: true,
  status: 'ok',
  agent: 'opencode',
  sessionId: 'ses_1',
  stopReason: 'end_turn',
  durationMs: 1200,
  cost: { amount: 0.0008, currency: 'USD' },
  text: 'ANSWER',
  tools: [],
  error: null,
  ...overrides,
});

// Records what it was asked, answers with a fixed shape.
function fakeHandlers(overrides = {}) {
  const calls = [];
  const handlers = {
    ask: async (args) => {
      calls.push({ tool: 'ask', args });
      return ok({ agent: args.agent });
    },
    fanout: async (args) => {
      calls.push({ tool: 'fanout', args });
      return {
        ok: true,
        okCount: 2,
        durationMs: 3000,
        agents: [
          { agent: 'opencode', ok: true, status: 'ok', durationMs: 1200, cost: null, text: 'A', error: null },
          { agent: 'hermes', ok: true, status: 'ok', durationMs: 2000, cost: null, text: 'B', error: null },
        ],
        synthesis: null,
        worktrees: [],
      };
    },
    route: async () => ({ agent: 'opencode', reason: 'no escalation signal' }),
    agents: async () => [
      { name: 'claude', label: 'Claude', available: true, consent: { ok: true }, defaultModel: 'sonnet' },
      { name: 'hermes', label: 'Hermes', available: false, consent: { ok: false, reason: 'expired' }, defaultModel: null },
    ],
    status: async () => {
      calls.push({ tool: 'status', args: {} });
      return 'AGENTHUB 2026-11-01 00:00\n\nagents    claude ok (22d)\n';
    },
    brief: async (args) => {
      calls.push({ tool: 'brief', args });
      return args.json ? '{"doctor":{"ok":true}}' : 'BRIEF doctor: 14 ok';
    },
    search: async (args) => {
      calls.push({ tool: 'search', args });
      return `2026-11-10  journal  JOURNAL.md\n    «${args.query}» found`;
    },
    startJob: async (request) => {
      calls.push({ tool: 'startJob', args: request });
      return { id: 'job_ab12cd34', agent: request.agent, cwd: request.cwd ?? null };
    },
    jobStatus: async (id) => ({
      id,
      agent: 'opencode',
      cwd: '/repo',
      state: 'running',
      running: true,
      elapsedMs: 90_000,
      lastTool: 'patch: a.gd (in_progress)',
    }),
    jobResult: async (id) => ({
      id,
      agent: 'opencode',
      cwd: '/repo',
      state: 'ok',
      running: false,
      elapsedMs: 120_000,
      answer: { agent: 'opencode', ok: true, status: 'ok', durationMs: 120_000, text: 'finished' },
    }),
    jobCancel: async () => ({ ok: true, ack: true, detail: 'the callee stopped' }),
    ...overrides,
  };
  return { handlers, calls };
}

// ── protocol ────────────────────────────────────────────────────────────────

test('initialize reports the protocol version and the tools capability', async () => {
  const { handlers } = fakeHandlers();
  const response = await handleMessage(
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: PROTOCOL_VERSION } },
    handlers,
  );
  assert.equal(response.result.protocolVersion, PROTOCOL_VERSION);
  assert.equal(response.result.capabilities.tools.listChanged, false);
  assert.equal(response.result.serverInfo.name, 'agent-hub');
});

test('notifications get no response', async () => {
  const { handlers } = fakeHandlers();
  assert.equal(await handleMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }, handlers), null);
});

test('tools/list exposes exactly the hub tools', async () => {
  const { handlers } = fakeHandlers();
  const response = await handleMessage({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, handlers);
  assert.deepEqual(
    response.result.tools.map((t) => t.name),
    ['ask_agent', 'fanout', 'route', 'agents', 'job_status', 'job_result', 'job_cancel', 'status', 'brief', 'search'],
  );
  for (const tool of response.result.tools) {
    assert.equal(tool.inputSchema.type, 'object');
    assert.ok(tool.description.length > 20, `${tool.name} needs a usable description`);
  }
});

test('every tool is described for a model that cannot see the registry', () => {
  const ask = TOOLS.find((t) => t.name === 'ask_agent');
  assert.match(ask.inputSchema.properties.agent.description, /claude/);
  assert.deepEqual(ask.inputSchema.required, ['agent', 'prompt']);
});

test('unknown methods are a protocol error, not a crash', async () => {
  const { handlers } = fakeHandlers();
  const response = await handleMessage({ jsonrpc: '2.0', id: 3, method: 'nope' }, handlers);
  assert.equal(response.error.code, -32601);
});

test('a tool that throws becomes isError, and the server keeps serving', async () => {
  const { handlers } = fakeHandlers({
    ask: async () => {
      throw new Error('agent exploded');
    },
  });
  const response = await handleMessage(
    { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'ask_agent', arguments: { agent: 'x', prompt: 'y' } } },
    handlers,
  );
  assert.equal(response.error.code, -32603);
  assert.match(response.error.message, /agent exploded/);

  const after = await handleMessage({ jsonrpc: '2.0', id: 5, method: 'ping' }, handlers);
  assert.deepEqual(after.result, {});
});

// ── argument validation ─────────────────────────────────────────────────────

test('ask_agent refuses an empty prompt', async () => {
  const { handlers, calls } = fakeHandlers();
  await assert.rejects(
    () => callTool('ask_agent', { agent: 'opencode', prompt: '   ' }, handlers),
    /non-empty string/,
  );
  assert.equal(calls.length, 0);
});

test('ask_agent refuses an unknown permission policy', async () => {
  const { handlers } = fakeHandlers();
  await assert.rejects(
    () => callTool('ask_agent', { agent: 'opencode', prompt: 'x', permission: 'yolo' }, handlers),
    /permission/,
  );
});

test('ask_agent defaults to deny and passes the model through', async () => {
  const { handlers, calls } = fakeHandlers();
  await callTool(
    'ask_agent',
    { agent: 'opencode', prompt: 'x', model: 'opencode/glm-5.3-flash-free' },
    handlers,
  );
  assert.equal(calls[0].args.permission, 'deny');
  assert.equal(calls[0].args.model, 'opencode/glm-5.3-flash-free');
});

test('fanout needs at least two agents', async () => {
  const { handlers } = fakeHandlers();
  await assert.rejects(() => callTool('fanout', { agents: ['opencode'], prompt: 'x' }, handlers), /two or more/);
});

test('fanout does not worktree unless asked', async () => {
  const { handlers, calls } = fakeHandlers();
  await callTool('fanout', { agents: ['opencode', 'hermes'], prompt: 'x' }, handlers);
  assert.equal(calls[0].args.worktree, false);
});

test('route without run makes no model call', async () => {
  const { handlers, calls } = fakeHandlers();
  const outcome = await callTool('route', { prompt: 'hello' }, handlers);
  assert.equal(calls.length, 0);
  assert.match(outcome.text, /routed to: opencode/);
});

test('route with run executes the routed agent', async () => {
  const { handlers, calls } = fakeHandlers();
  const outcome = await callTool('route', { prompt: 'debug this', run: true }, handlers);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].args.agent, 'opencode');
  assert.match(outcome.text, /ANSWER/);
});

// ── rendering ───────────────────────────────────────────────────────────────

test('an answer shows status, duration, cost and the text', () => {
  const text = renderAsk(ok());
  assert.match(text, /agent: opencode · status: ok · 1\.2s · cost: \$0\.0008/);
  assert.match(text, /ANSWER/);
});

test('a failed answer is rendered as an error, not as an empty success', () => {
  const text = renderAsk(ok({ ok: false, status: 'denied', text: '', error: 'no consent recorded' }));
  assert.match(text, /status: denied/);
  assert.match(text, /error: no consent recorded/);
});

test('an empty successful answer still says so', () => {
  assert.match(renderAsk(ok({ text: '   ' })), /\(empty answer\)/);
});

test('fanout renders one section per agent and the synthesis first', () => {
  const text = renderFanout({
    ok: true,
    okCount: 2,
    durationMs: 3000,
    agents: [
      { agent: 'opencode', ok: true, status: 'ok', durationMs: 1200, cost: null, text: 'A', error: null },
      { agent: 'hermes', ok: false, status: 'timeout', durationMs: 2000, cost: null, text: '', error: 'timed out' },
    ],
    synthesis: { agent: 'claude', ok: true, text: 'MERGED' },
    worktrees: [{ path: '/tmp/wt' }],
  });
  assert.match(text, /2\/2 answered/);
  assert.ok(text.indexOf('MERGED') < text.indexOf('## opencode'));
  assert.match(text, /## hermes — timeout/);
  assert.match(text, /error: timed out/);
  assert.match(text, /worktrees kept: \/tmp\/wt/);
});

test('the agents table shows consent denial and availability', () => {
  const text = renderAgents([
    { name: 'claude', available: true, consent: { ok: true }, defaultModel: 'sonnet' },
    { name: 'hermes', available: false, consent: { ok: false, reason: 'expired' }, defaultModel: null },
  ]);
  assert.match(text, /claude\s+yes\s+granted\s+sonnet/);
  assert.match(text, /hermes\s+no\s+denied \(expired\)/);
});

test('route renders the decision alone when nothing ran', () => {
  assert.equal(renderRoute({ agent: 'claude', reason: 'debug' }), 'routed to: claude — debug');
});

test('route retries on the other pool when the first is out of quota', async () => {
  const calls = [];
  const handlers = {
    route: async () => ({ agent: 'opencode', reason: 'cheap default' }),
    ask: async (args) => {
      calls.push(args.agent);
      return args.agent === 'opencode'
        ? { ok: false, status: 'failed', agent: 'opencode', error: '429 Too Many Requests', text: '', tools: [] }
        : { ok: true, status: 'ok', agent: 'claude', text: 'ANSWER', durationMs: 1200, cost: null, tools: [] };
    },
  };

  const outcome = await withRegistry(() => callTool('route', { prompt: 'x', run: true }, handlers));
  assert.deepEqual(calls, ['opencode', 'claude']);
  assert.match(outcome.text, /out of quota; retried on claude/);
  assert.match(outcome.text, /ANSWER/);
  assert.equal(outcome.isError, false);
});

test('route with a cwd hands the fallback agent the tree context and the task', async () => {
  const prompts = {};
  const handlers = {
    route: async () => ({ agent: 'opencode', reason: 'cheap default' }),
    ask: async (args) => {
      prompts[args.agent] = args.prompt;
      return args.agent === 'opencode'
        ? { ok: false, status: 'failed', agent: 'opencode', error: 'weekly limit reached', text: '', tools: [] }
        : { ok: true, status: 'ok', agent: 'claude', text: 'ANSWER', durationMs: 1, cost: null, tools: [] };
    },
  };
  await withRegistry(() =>
    callTool('route', { prompt: 'fix the parser', run: true, cwd: process.cwd() }, handlers));
  assert.equal(prompts.opencode, 'fix the parser', 'the first agent gets the bare prompt');
  assert.match(prompts.claude, /You are claude/);
  assert.match(prompts.claude, /fix the parser/);
});

test('status calls the handler and returns its text verbatim', async () => {
  const { handlers, calls } = fakeHandlers();
  const response = await handleMessage(
    { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'status', arguments: {} } },
    handlers,
  );
  assert.equal(calls[0].tool, 'status');
  assert.match(response.result.content[0].text, /AGENTHUB/);
  assert.equal(response.result.isError, false);
});

test('route does not retry on an ordinary failure', async () => {
  const calls = [];
  const handlers = {
    route: async () => ({ agent: 'opencode', reason: 'cheap default' }),
    ask: async (args) => {
      calls.push(args.agent);
      return {
        ok: false,
        status: 'failed',
        agent: args.agent,
        error: 'SyntaxError: unexpected token',
        text: '',
        tools: [],
      };
    },
  };

  const outcome = await callTool('route', { prompt: 'x', run: true }, handlers);
  assert.deepEqual(calls, ['opencode']);
  assert.equal(outcome.isError, true);
});

test('ask_agent with background returns a job id instead of waiting', async () => {
  const { handlers, calls } = fakeHandlers();
  const response = await handleMessage(
    {
      jsonrpc: '2.0',
      id: 9,
      method: 'tools/call',
      params: {
        name: 'ask_agent',
        arguments: { agent: 'opencode', prompt: 'long job', cwd: '/repo', background: true },
      },
    },
    handlers,
  );
  assert.equal(response.result.isError, false);
  assert.match(response.result.content[0].text, /job job_ab12cd34 started/);
  assert.equal(calls[0].tool, 'startJob', 'background never goes through ask');
  assert.equal(calls[0].args.prompt, 'long job');
});

test('job_status and job_result render what a caller needs to decide', async () => {
  const { handlers } = fakeHandlers();
  const status = await handleMessage(
    { jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'job_status', arguments: { jobId: 'job_ab12cd34' } } },
    handlers,
  );
  const statusText = status.result.content[0].text;
  assert.match(statusText, /job_ab12cd34 · running · 90\.0s/);
  assert.match(statusText, /last tool: patch: a\.gd/);
  assert.match(statusText, /poll job_status/);

  const result = await handleMessage(
    { jsonrpc: '2.0', id: 11, method: 'tools/call', params: { name: 'job_result', arguments: { jobId: 'job_ab12cd34' } } },
    handlers,
  );
  assert.equal(result.result.isError, false);
  assert.match(result.result.content[0].text, /status: ok/);
  assert.match(result.result.content[0].text, /finished/);
});

test('an unknown job is an error, not an empty success', async () => {
  const { handlers } = fakeHandlers({ jobStatus: async () => null, jobResult: async () => null });
  const status = await handleMessage(
    { jsonrpc: '2.0', id: 12, method: 'tools/call', params: { name: 'job_status', arguments: { jobId: 'job_nope' } } },
    handlers,
  );
  assert.equal(status.result.isError, true);
  assert.match(status.result.content[0].text, /unknown job/);
});

test('job_cancel reports a job that already ended instead of pretending', async () => {
  const { handlers } = fakeHandlers({ jobCancel: async () => ({ ok: false, reason: 'already ok' }) });
  const response = await handleMessage(
    { jsonrpc: '2.0', id: 13, method: 'tools/call', params: { name: 'job_cancel', arguments: { jobId: 'job_x' } } },
    handlers,
  );
  assert.equal(response.result.isError, true);
  assert.match(response.result.content[0].text, /cannot cancel job_x: already ok/);
});

test('a saved answer says where it was saved', () => {
  const text = renderAsk({
    agent: 'opencode',
    ok: true,
    status: 'ok',
    durationMs: 4000,
    text: 'done',
    savedTo: '/hub/results/20261104-0100-opencode-acp.md',
  });
  assert.match(text, /saved: \/hub\/results\/20261104-0100-opencode-acp\.md/);
});

test('a cancel that was not acknowledged says the tree may still change', async () => {
  const { handlers } = fakeHandlers({
    jobCancel: async () => ({
      ok: true,
      ack: false,
      detail: 'cancel sent, but the process has not exited',
    }),
  });
  const response = await handleMessage(
    { jsonrpc: '2.0', id: 14, method: 'tools/call', params: { name: 'job_cancel', arguments: { jobId: 'job_x' } } },
    handlers,
  );
  assert.match(response.result.content[0].text, /not exited/);
  assert.match(response.result.content[0].text, /git status/);
});

test('route with run+background hands the routed agent a job', async () => {
  const { handlers, calls } = fakeHandlers();
  const response = await handleMessage(
    {
      jsonrpc: '2.0',
      id: 15,
      method: 'tools/call',
      params: {
        name: 'route',
        arguments: { prompt: 'refactor the module', run: true, background: true, permission: 'allow-all' },
      },
    },
    handlers,
  );
  assert.equal(response.result.isError, false);
  assert.match(response.result.content[0].text, /routed to: opencode/);
  assert.match(response.result.content[0].text, /job job_ab12cd34 started/);
  assert.equal(calls[0].tool, 'startJob');
  assert.equal(calls[0].args.agent, 'opencode');
  assert.equal(calls[0].args.permission, 'allow-all');
});

test('ask_agent and fanout pass effort through and reject unknown levels', async () => {
  const { handlers, calls } = fakeHandlers();
  await callTool('ask_agent', { agent: 'opencode', prompt: 'x', effort: 'low' }, handlers);
  assert.equal(calls[0].args.effort, 'low');
  await callTool('ask_agent', { agent: 'opencode', prompt: 'x' }, handlers);
  assert.equal(calls[1].args.effort, undefined);
  await callTool('fanout', { agents: ['opencode', 'codex'], prompt: 'x', effort: 'high' }, handlers);
  assert.equal(calls[2].args.effort, 'high');
  await assert.rejects(
    () => callTool('ask_agent', { agent: 'opencode', prompt: 'x', effort: 'turbo' }, handlers),
    /"effort" must be one of low, medium, high, max/,
  );
});

const call = (handlers, name, args) =>
  handleMessage({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name, arguments: args } }, handlers);

test('brief returns the handler text, and asks for json only when told to', async () => {
  const { handlers, calls } = fakeHandlers();
  const text = await call(handlers, 'brief', {});
  assert.equal(text.result.isError, false);
  assert.match(text.result.content[0].text, /BRIEF/);
  assert.deepEqual(calls.at(-1).args, { json: false });
  const json = await call(handlers, 'brief', { json: true });
  assert.deepEqual(calls.at(-1).args, { json: true });
  assert.match(json.result.content[0].text, /"doctor"/);
});

test('brief refuses a non-boolean json', async () => {
  const { handlers, calls } = fakeHandlers();
  await assert.rejects(() => callTool('brief', { json: 'yes' }, handlers), /"json" must be a boolean/);
  assert.equal(calls.length, 0);
});

test('search passes the query through with its defaults', async () => {
  const { handlers, calls } = fakeHandlers();
  const response = await call(handlers, 'search', { query: 'seclogon' });
  assert.equal(response.result.isError, false);
  assert.deepEqual(calls.at(-1).args, { query: 'seclogon', since: undefined, source: undefined, limit: 20 });
  assert.match(response.result.content[0].text, /seclogon/);
});

test('search forwards since, source and limit', async () => {
  const { handlers, calls } = fakeHandlers();
  await call(handlers, 'search', { query: 'codex', since: '2026-11-01', source: 'git', limit: 5 });
  assert.deepEqual(calls.at(-1).args, { query: 'codex', since: '2026-11-01', source: 'git', limit: 5 });
});

test('search rejects bad input as a tool error and never reaches the handler', async () => {
  const { handlers, calls } = fakeHandlers();
  const bad = [
    {},                                              // no query
    { query: '' },                                   // empty query
    { query: 'x', since: '2026-13-45' },             // not a real date
    { query: 'x', since: '10/11/2026' },             // wrong shape
    { query: 'x', source: 'logs' },                  // unknown source
    { query: 'x', limit: 0 },                        // below range
    { query: 'x', limit: 51 },                       // above range
    { query: 'x', limit: 2.5 },                      // not an integer
  ];
  for (const args of bad) {
    await assert.rejects(() => callTool('search', args, handlers), /must be|non-empty|required/, JSON.stringify(args));
  }
  assert.equal(calls.length, 0);
});

test('brief and search are described well enough for a model to choose them', () => {
  for (const name of ['brief', 'search']) {
    const tool = TOOLS.find((t) => t.name === name);
    assert.ok(tool.description.length > 120, `${name} needs a real description`);
    assert.match(tool.description, /Read-only/);
  }
  assert.deepEqual(TOOLS.find((t) => t.name === 'search').inputSchema.required, ['query']);
});
