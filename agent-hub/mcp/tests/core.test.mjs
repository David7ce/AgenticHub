import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  TOOLS,
  PROTOCOL_VERSION,
  handleMessage,
  callTool,
  renderAsk,
  renderJobStatus,
  renderFanout,
  renderAgents,
  renderRoute,
  renderSessionLog,
} from '../core.mjs';
import { appendTranscript, readTranscript } from '../../acp/transcript.mjs';

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

test('cancellation results distinguish acknowledged from unconfirmed', () => {
  const failure = { ok: false, agent: 'opencode', status: 'cancelled' };
  assert.match(renderAsk({ ...failure, cancelAck: true }), /agent acknowledged.*not proof/);
  assert.match(renderAsk({ ...failure, cancelAck: false }), /not confirmed or unknown.*may still be working/);
  assert.match(renderAsk(failure), /not confirmed or unknown/);
  assert.match(renderAsk({ ...failure, status: 'failed', cancelAck: false }), /not confirmed or unknown/);
  assert.doesNotMatch(renderAsk({ ...failure, status: 'denied' }), /cancellation:/);
  assert.match(renderJobStatus({ id: 'job_a', agent: 'a', state: 'cancelled', running: false }), /not confirmed or unknown/);
  assert.match(renderJobStatus({ id: 'job_a', agent: 'a', state: 'cancelled', running: false, cancelAck: true }), /agent acknowledged/);
});

test('ask_agent forwards native mode for foreground and background calls', async () => {
  const { handlers, calls } = fakeHandlers();
  await callTool('ask_agent', { agent: 'codex', prompt: 'x', mode: 'read-only' }, handlers);
  await callTool('ask_agent', { agent: 'codex', prompt: 'x', mode: 'read-only', background: true }, handlers);
  assert.equal(calls[0].args.mode, 'read-only');
  assert.equal(calls[1].args.mode, 'read-only');
  await assert.rejects(() => callTool('ask_agent', { agent: 'codex', prompt: 'x', mode: '  ' }, handlers), /non-empty/);
  assert.match(renderAsk(ok({ requestedMode: 'plan', reportedMode: 'plan' })), /mode requested: plan · agent reported: plan/);
  assert.match(renderAsk(ok()), /mode requested: none · agent reported: unknown/);
});

test('permission "ask" is only available to a background ask_agent call', async () => {
  const { handlers } = fakeHandlers();
  await assert.rejects(
    () => callTool('ask_agent', { agent: 'claude', prompt: 'x', permission: 'ask' }, handlers),
    /permission "ask" needs background: true/,
  );
  await assert.rejects(
    () => callTool('fanout', { agents: ['claude', 'codex'], prompt: 'x', permission: 'ask' }, handlers),
    /only for ask_agent/,
  );
  const started = await callTool(
    'ask_agent',
    { agent: 'claude', prompt: 'x', permission: 'ask', background: true },
    handlers,
  );
  assert.equal(started.isError, false);
  assert.match(started.text, /job_/);
});

test('permission_answer reports a job with nothing pending, and sends a real answer', async () => {
  const { handlers } = fakeHandlers();
  const none = await callTool(
    'permission_answer',
    { jobId: 'job_1', requestId: 'perm-1', decision: 'reject' },
    handlers,
  );
  assert.equal(none.isError, true);
  assert.match(none.text, /no pending permission request for job_1/);

  const { handlers: answering } = fakeHandlers({
    permissionAnswer: async (id, decision, requestId) => ({ ok: true, requestId: requestId ?? 'perm-9', decision }),
  });
  const sent = await callTool(
    'permission_answer',
    { jobId: 'job_2', decision: 'allow_once', requestId: 'perm-9' },
    answering,
  );
  assert.equal(sent.isError, false);
  assert.match(sent.text, /perm-9/);

  // An answer the child no longer holds must not read as applied.
  const { handlers: missed } = fakeHandlers({
    permissionAnswer: async () => ({ ok: true, requestId: 'perm-9', decision: 'reject', acknowledged: false }),
  });
  const missedAnswer = await callTool(
    'permission_answer',
    { jobId: 'job_2', requestId: 'perm-9', decision: 'reject' },
    missed,
  );
  assert.equal(missedAnswer.isError, true);
  assert.match(missedAnswer.text, /no longer holding/);

  await assert.rejects(
    () => callTool('permission_answer', { jobId: 'job_2', requestId: 'perm-9', decision: 'maybe' }, handlers),
    /allow_once/,
  );
  await assert.rejects(
    () => callTool('permission_answer', { jobId: 'job_2', decision: 'reject' }, handlers),
    /requestId/,
  );
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
    permissionAnswer: async (id, decision) => {
      calls.push({ tool: 'permissionAnswer', args: { id, decision } });
      return { ok: false, reason: `no pending permission request for ${id}` };
    },
    handoffSource: async (label, turns) => {
      calls.push({ tool: 'handoffSource', args: { label, turns } });
      if (label === 'nowhere') return null;
      if (label === 'empty-session') return { noTranscript: true };
      if (label === 'long') {
        return { agent: 'claude', text: `OLDEST${'x'.repeat(9986)}NEWEST`, path: '/transcripts/long.jsonl', turns: 1 };
      }
      return { agent: 'claude', text: `SOURCE TEXT from ${label}`, path: `/transcripts/${label}.jsonl`, turns };
    },
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
    ['ask_agent', 'fanout', 'route', 'agents', 'job_status', 'job_result', 'job_cancel', 'permission_answer', 'status', 'brief', 'search', 'sessions', 'session_close', 'session_log', 'session_config'],
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

test('write-capable fanout requires worktrees before dispatch', async () => {
  const { handlers, calls } = fakeHandlers();
  await assert.rejects(
    () => callTool('fanout', { agents: ['opencode', 'codex'], prompt: 'x', permission: 'allow-all' }, handlers),
    /requires worktree: true/,
  );
  assert.equal(calls.length, 0);
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

test('an answer shows the turn tokens, and says so when the store could not be read', () => {
  const text = renderAsk(ok({
    tokens: { input_tokens: 1_200, cache_read_tokens: 919_600, output_tokens: 890, confidence: 'delta' },
  }));
  assert.match(text, /tokens: 1\.2k in · 919\.6k cached · 890 out/);
  assert.match(renderAsk(ok({ tokens: { confidence: 'unavailable', reason: 'x' } })), /tokens: —/);
  assert.match(renderAsk(ok()), /tokens: —/, 'an older result without the field is not a crash');
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

// The person talks to the client's model and never names a tool, so every tool
// has to be reachable from the manual the model is given at connect time.
test('the instructions name every tool, and initialize sends them', async () => {
  const { INSTRUCTIONS, TOOLS, handleMessage } = await import('../core.mjs');
  for (const tool of TOOLS) assert.ok(INSTRUCTIONS.includes(`\`${tool.name}\``), `instructions mention ${tool.name}`);
  const init = await handleMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }, {});
  assert.equal(init.result.instructions, INSTRUCTIONS);
  assert.ok(INSTRUCTIONS.length < 2500, 'short enough to be read on every connect');
});



test('cancellation during routing cannot launch a detached job afterward', async () => {
  const controller = new AbortController();
  let launched = 0;
  const handlers = {
    route: async () => { controller.abort(); return { agent:'opencode', reason:'test' }; },
    startJob: async () => { launched += 1; return { id:'job_unexpected' }; },
  };
  const outcome = await callTool('route', {prompt:'test',run:true,background:true}, handlers, {signal:controller.signal});
  assert.equal(launched, 0);
  assert.equal(outcome.isError, true);
});

// ── named sessions ──────────────────────────────────────────────────────────

test('label and sessionId together are rejected', async () => {
  await assert.rejects(
    callTool('ask_agent', { agent: 'claude', prompt: 'x', label: 'a-1', sessionId: 's' }, {}),
    /label.*sessionId|sessionId.*label/,
  );
});

test('a label is validated', async () => {
  await assert.rejects(callTool('ask_agent', { agent: 'claude', prompt: 'x', label: 'Bad Label' }, {}), /label/);
});

test('a known label with another agent or tree is rejected, with who owns it', async () => {
  const handlers = {
    session: async () => ({ label: 'a-1', agent: 'claude', cwd: '/work/one', state: 'idle', acpSessionId: 's1' }),
    ask: async () => assert.fail('must not run'),
  };
  await assert.rejects(
    callTool('ask_agent', { agent: 'codex', prompt: 'x', label: 'a-1' }, handlers),
    /label a-1 belongs to claude in \/work\/one/,
  );
  await assert.rejects(
    callTool('ask_agent', { agent: 'claude', prompt: 'x', label: 'a-1', cwd: '/work/two' }, handlers),
    /label a-1 belongs to claude in \/work\/one/,
  );
});

test('ask_agent carries worktree for an unlabelled call, foreground and background', async () => {
  const { handlers, calls } = fakeHandlers();
  await callTool('ask_agent', { agent: 'opencode', prompt: 'x', worktree: true }, handlers);
  await callTool('ask_agent', { agent: 'opencode', prompt: 'x', worktree: true, background: true }, handlers);
  await callTool('ask_agent', { agent: 'opencode', prompt: 'x' }, handlers);
  assert.equal(calls[0].args.worktree, true);
  assert.equal(calls[1].args.worktree, true);
  assert.equal(calls[2].args.worktree, false);
});

test('a known label continues its session with its stored cwd and model', async () => {
  let seen;
  const handlers = {
    session: async () => ({
      label: 'a-1', agent: 'claude', cwd: '/work/one', state: 'idle', acpSessionId: 's1', model: 'm1', effort: 'low',
    }),
    sessionQueue: async () => null,
    ask: async (req) => { seen = req; return ok(); },
  };
  await callTool('ask_agent', { agent: 'claude', prompt: 'x', label: 'a-1' }, handlers);
  assert.equal(seen.sessionId, 's1');
  assert.equal(seen.cwd, '/work/one');
  assert.equal(seen.model, 'm1');
  assert.equal(seen.effort, 'low');
  assert.equal(seen.label, 'a-1');
});

// Windows is case-insensitive: `d:\x` and `D:\x` are one tree, and the tree
// lock already folds them. A follow-up spelled the other way is the same
// session, not another one's, so it must not be refused.
test('a cwd differing only in case belongs to a known label on Windows', { skip: process.platform !== 'win32' }, async () => {
  const tree = mkdtempSync(join(tmpdir(), 'hub-case-tree-'));
  const seen = [];
  const handlers = {
    session: async () => ({ label: 'a-1', agent: 'claude', cwd: tree, state: 'idle', acpSessionId: 's1' }),
    sessionQueue: async () => null,
    ask: async (req) => { seen.push(req); return ok(); },
  };
  await callTool('ask_agent', { agent: 'claude', prompt: 'x', label: 'a-1', cwd: tree.toUpperCase() }, handlers);
  assert.equal(seen.length, 1, 'the differently-cased tree is accepted');
  assert.equal(seen[0].cwd, tree, 'the stored tree is used as written');
});

test('a turn on a running session is queued, not started', async () => {
  const handlers = {
    session: async () => ({ label: 'a-1', agent: 'claude', cwd: '/w', state: 'running', live: true }),
    sessionQueue: async () => 2,
    ask: async () => assert.fail('must not run'),
    startJob: async () => assert.fail('must not start'),
  };
  const out = await callTool('ask_agent', { agent: 'claude', prompt: 'x', label: 'a-1' }, handlers);
  assert.match(out.text, /queued \(2 waiting\)/);
  assert.equal(out.isError, false);
});

test('a running session with no live job is taken over, not queued behind', async () => {
  const seen = [];
  const handlers = {
    session: async () => ({ label: 'a-1', agent: 'claude', cwd: '/w', state: 'running', live: false }),
    sessionQueue: async () => assert.fail('a stale session must not queue'),
    ask: async (req) => { seen.push(req); return ok(); },
  };
  const out = await callTool('ask_agent', { agent: 'claude', prompt: 'x', label: 'a-1' }, handlers);
  assert.equal(out.isError, false);
  assert.equal(seen.length, 1, 'the turn runs as if the session were idle');
  assert.equal(seen[0].label, 'a-1');
  assert.equal(seen[0].cwd, '/w');
});

test('sessions renders label, agent, state, tree, model, last activity and spend', async () => {
  const handlers = {
    sessions: async () => [{
      label: 'a-1', agent: 'claude', state: 'idle', cwd: '/work/one', model: 'opus', lastActivity: Date.now() - 120_000, spendUsd: 0.5,
    }],
  };
  const out = await callTool('sessions', {}, handlers);
  for (const word of ['label', 'agent', 'state', 'tree', 'model', 'last activity', 'spend']) assert.match(out.text, new RegExp(word));
  assert.match(out.text, /a-1\s+claude\s+idle\s+\/work\/one\s+opus\s+2m ago\s+\$0\.50/);
});

test('session_close on an unknown label is an error', async () => {
  const out = await callTool('session_close', { label: 'nope' }, { sessionClose: async () => null });
  assert.equal(out.isError, true);
  assert.match(out.text, /nope/);
});

test('session_config passes the patch and validates effort', async () => {
  let seen;
  const handlers = { sessionConfig: async (label, patch) => { seen = [label, patch]; return { label }; } };
  const out = await callTool('session_config', { label: 'a-1', model: 'm', effort: 'high' }, handlers);
  assert.deepEqual(seen, ['a-1', { model: 'm', effort: 'high' }]);
  assert.equal(out.isError, false);
  await assert.rejects(callTool('session_config', { label: 'a-1', effort: 'wild' }, handlers), /effort/);
});

function fixtureTranscript(t) {
  const dir = mkdtempSync(join(tmpdir(), 'hub-log-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  appendTranscript(dir, 'acp-1', { t: '2026-01-01T00:00:00Z', kind: 'prompt', text: 'fix the bug' });
  appendTranscript(dir, 'acp-1', { t: '2026-01-01T00:00:01Z', kind: 'tool', id: 'c1', title: 'Read x', toolKind: 'read', status: 'completed' });
  appendTranscript(dir, 'acp-1', { t: '2026-01-01T00:00:02Z', kind: 'text', text: 'done' });
  return dir;
}

test('session_log renders a fixture transcript newest first', async (t) => {
  const dir = fixtureTranscript(t);
  const handlers = {
    sessionLog: async (label, opts) => (label === 'a-1' ? readTranscript(dir, 'acp-1', opts) : null),
  };
  const out = await callTool('session_log', { label: 'a-1' }, handlers);
  assert.equal(out.isError, false);
  const lines = out.text.split('\n');
  assert.match(lines[0], /a-1 .*3 of 3/);
  assert.match(lines[1], /agent: done/);
  assert.match(lines[2], /tool: Read x \(read, completed\)/);
  assert.match(lines[3], /prompt: fix the bug/);
  assert.doesNotMatch(out.text, /older:/);

  const paged = await callTool('session_log', { label: 'a-1', limit: 1 }, handlers);
  assert.match(paged.text, /older: before=2/);
  const textOnly = await callTool('session_log', { label: 'a-1', textOnly: true }, handlers);
  assert.doesNotMatch(textOnly.text, /tool:/);
});

test('session_log: unknown label is an error, no transcript yet is not', async () => {
  const unknown = await callTool('session_log', { label: 'nope' }, { sessionLog: async () => null });
  assert.equal(unknown.isError, true);
  assert.match(unknown.text, /nope/);
  const fresh = await callTool('session_log', { label: 'a-1' }, { sessionLog: async () => ({ noTranscript: true }) });
  assert.equal(fresh.isError, false);
  assert.match(fresh.text, /no transcript yet/);
});

test('session_log rejects an out-of-range limit', async () => {
  const handlers = { sessionLog: async () => assert.fail('must not reach the handler') };
  await assert.rejects(callTool('session_log', { label: 'a', limit: 201 }, handlers), /limit/);
  await assert.rejects(callTool('session_log', { label: 'a', limit: 0 }, handlers), /limit/);
});

// ── handoff by reference ────────────────────────────────────────────────────

test('ask_agent from prepends the source session text and its transcript path', async () => {
  const { handlers, calls } = fakeHandlers();
  const out = await callTool(
    'ask_agent',
    { agent: 'codex', prompt: 'review this', from: { label: 'claude-fix' } },
    handlers,
  );
  assert.equal(out.isError, false);
  const prompt = calls.find((c) => c.tool === 'ask').args.prompt;
  assert.match(prompt, /^review this\n\n--- from session claude-fix \(claude\), last 1 turn\(s\) ---\n/);
  assert.match(prompt, /SOURCE TEXT from claude-fix/);
  assert.match(prompt, /\n--- full transcript: \/transcripts\/claude-fix\.jsonl ---$/);
  assert.deepEqual(calls.find((c) => c.tool === 'handoffSource').args, { label: 'claude-fix', turns: 1 });
  const schema = TOOLS.find((tool) => tool.name === 'ask_agent').inputSchema.properties.from;
  assert.deepEqual(schema.required, ['label']);
  assert.equal(schema.additionalProperties, false);
});

test('a 10000-character source is trimmed from the oldest side to fit the prompt limit', async () => {
  const { handlers, calls } = fakeHandlers();
  const out = await callTool(
    'ask_agent',
    { agent: 'codex', prompt: 'review this', from: { label: 'long' } },
    handlers,
  );
  assert.equal(out.isError, false);
  const prompt = calls.find((c) => c.tool === 'ask').args.prompt;
  assert.ok(prompt.length <= 4000, `prompt was ${prompt.length} characters`);
  assert.ok(prompt.includes('…'), 'a trimmed source is marked with an ellipsis');
  assert.match(prompt, /NEWEST/);
  assert.doesNotMatch(prompt, /OLDEST/);
  assert.match(prompt, /--- full transcript: \/transcripts\/long\.jsonl ---$/);
});

test('the heading reports the turns the source really carried, not the request', async () => {
  const { handlers, calls } = fakeHandlers({
    handoffSource: async (label, turns) => {
      calls.push({ tool: 'handoffSource', args: { label, turns } });
      return { agent: 'claude', text: 'ONLY TURN', path: '/transcripts/short.jsonl', turns: 1 };
    },
  });
  const out = await callTool(
    'ask_agent',
    { agent: 'codex', prompt: 'review this', from: { label: 'short', turns: 3 } },
    handlers,
  );
  assert.equal(out.isError, false);
  const prompt = calls.find((c) => c.tool === 'ask').args.prompt;
  assert.match(prompt, /--- from session short \(claude\), last 1 turn\(s\) ---/);
  assert.doesNotMatch(prompt, /last 3 turn/);
});

function loneSurrogateAt(text) {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (next < 0xdc00 || next > 0xdfff) return i;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      const prev = text.charCodeAt(i - 1);
      if (i === 0 || prev < 0xd800 || prev > 0xdbff) return i;
    }
  }
  return -1;
}

test('a trim never leaves half a surrogate pair, and still fits the budget', async () => {
  // Two suffix lengths of opposite parity: the suffix moves the cut by one
  // unit without moving the emoji alignment, so one cut lands on the low half
  // of a pair however the fixed heading length falls. The buggy slice would
  // start on that low surrogate; both variants must come out as valid text.
  for (const tail of ['', 'x']) {
    const text = '😀'.repeat(6000) + tail;
    const { handlers, calls } = fakeHandlers({
      handoffSource: async () => ({ agent: 'claude', text, path: '/transcripts/emoji.jsonl', turns: 1 }),
    });
    const out = await callTool(
      'ask_agent',
      { agent: 'codex', prompt: 'review this', from: { label: 'emoji' } },
      handlers,
    );
    assert.equal(out.isError, false);
    const prompt = calls.find((c) => c.tool === 'ask').args.prompt;
    assert.ok(prompt.length <= 4000, `${prompt.length} characters with suffix ${JSON.stringify(tail)}`);
    assert.ok(prompt.includes('…'), 'a trimmed source is marked with an ellipsis');
    assert.equal(loneSurrogateAt(prompt), -1, `lone surrogate with suffix ${JSON.stringify(tail)}`);
  }
});

test('a handoff from a session with no finished turn is an error, not an empty prompt', async () => {
  const { handlers, calls } = fakeHandlers({
    handoffSource: async () => ({ agent: 'claude', text: '   ', path: '/tmp/x.jsonl', turns: 1 }),
  });
  const out = await callTool(
    'ask_agent',
    { agent: 'codex', prompt: 'review this', from: { label: 'running-one' } },
    handlers,
  );
  assert.equal(out.isError, true);
  assert.match(out.text, /session running-one has no finished turn to hand over yet/);
  assert.equal(calls.filter((c) => c.tool === 'ask').length, 0);
});

test('ask_agent from refuses a prompt whose fixed parts leave no room for the source', async () => {
  const { handlers, calls } = fakeHandlers();
  await assert.rejects(
    () => callTool('ask_agent', { agent: 'codex', prompt: 'x'.repeat(4000), from: { label: 'claude-fix' } }, handlers),
    /too long for a handoff.*\d+.*4000/,
  );
  assert.equal(calls.filter((c) => c.tool === 'ask').length, 0);
});

test('an unknown from label or a missing transcript is an error result', async () => {
  const { handlers, calls } = fakeHandlers();
  const unknown = await callTool('ask_agent', { agent: 'codex', prompt: 'x', from: { label: 'nowhere' } }, handlers);
  assert.equal(unknown.isError, true);
  assert.match(unknown.text, /no session labelled nowhere/);
  const fresh = await callTool('ask_agent', { agent: 'codex', prompt: 'x', from: { label: 'empty-session' } }, handlers);
  assert.equal(fresh.isError, true);
  assert.match(fresh.text, /session empty-session has no transcript yet/);
  assert.equal(calls.filter((c) => c.tool === 'ask').length, 0);
});

test('ask_agent from validates its shape and turns range', async () => {
  const { handlers, calls } = fakeHandlers();
  const bad = [
    { label: 'claude-fix', turns: 0 },
    { label: 'claude-fix', turns: 4 },
    { label: 'claude-fix', turns: 1.5 },
    { label: '  ' },
    { turns: 2 },
    { label: 'claude-fix', extra: true },
  ];
  for (const from of bad) {
    await assert.rejects(
      () => callTool('ask_agent', { agent: 'codex', prompt: 'x', from }, handlers),
      /"from|"label|"turns/,
      JSON.stringify(from),
    );
  }
  await assert.rejects(
    () => callTool('ask_agent', { agent: 'codex', prompt: 'x', from: 'claude-fix' }, handlers),
    /"from"/,
  );
  assert.equal(calls.length, 0);
});

test('ask_agent from works together with a target label and passes turns through', async () => {
  const { handlers, calls } = fakeHandlers();
  const out = await callTool(
    'ask_agent',
    { agent: 'codex', prompt: 'review this', label: 'reviewer-1', from: { label: 'claude-fix', turns: 2 } },
    handlers,
  );
  assert.equal(out.isError, false);
  assert.deepEqual(calls.find((c) => c.tool === 'handoffSource').args, { label: 'claude-fix', turns: 2 });
  const request = calls.find((c) => c.tool === 'ask').args;
  assert.equal(request.label, 'reviewer-1');
  assert.match(request.prompt, /--- from session claude-fix \(claude\), last 2 turn\(s\) ---/);
});

test('renderJobStatus shows recent text, label and a pending permission', () => {
  const text = renderJobStatus({
    id: 'j1', state: 'running', running: true, elapsedMs: 1000, agent: 'claude',
    recentText: 'working on\nthe parser', sessionLabel: 'a-1',
    pendingPermission: { requestId: 'r1', title: 'Run rm', toolKind: 'execute', heldMs: 4000 },
  });
  assert.match(text, /session: a-1/);
  assert.match(text, /recent text: working on the parser/);
  assert.match(text, /WAITING FOR PERMISSION: Run rm \(execute\) · held 4\.0s · request r1/);
});
