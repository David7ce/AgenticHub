import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';

// End-to-end: a real MCP client, the real server, the real hub-acp.mjs, and a
// fake ACP agent at the bottom. Nothing here talks to a model, a login or the
// network -- it proves the wiring (protocol, consent, audit line, answer)
// that unit tests cannot.

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = resolve(HERE, '..', 'server.mjs');
const FIXTURE = join(HERE, 'fixtures', 'fake-acp-agent.mjs');

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'hub-mcp-'));
  const registry = join(dir, 'agents.json');
  const consent = join(dir, 'consent.json');
  const log = join(dir, 'runs.jsonl');

  writeFileSync(
    registry,
    JSON.stringify({
      agents: {
        fake: {
          label: 'Fake agent',
          command: process.execPath,
          args: [FIXTURE],
          defaultConfig: { model: 'fake/model-1' },
          modelFallbacks: ['fake/paid-model'],
        },
        // The same fixture, able to continue a session each of the two ACP ways.
        resumer: { label: 'Resumes', command: process.execPath, args: [FIXTURE], env: { FAKE_ACP_CAPS: 'resume' }, defaultConfig: { model: 'fake/default' } },
        loader: { label: 'Loads', command: process.execPath, args: [FIXTURE], env: { FAKE_ACP_CAPS: 'load' } },
        // Asks the person for permission before answering, like a real agent
        // does before running a command.
        asker: { label: 'Asks the owner', command: process.execPath, args: [FIXTURE], env: { FAKE_PERMISSION: 'execute' }, defaultConfig: { model: 'fake/ask' } },
        modeagent: { label: 'Mode agent', command: process.execPath, args: [FIXTURE], env: { FAKE_MODE: 'ok', FAKE_ACP_CAPS: 'resume' } },
        // Streams its answer as two chunks with a key shape split across them.
        splitter: { label: 'Splits a key', command: process.execPath, args: [FIXTURE], env: { FAKE_SPLIT_TOKEN: '1' } },
        denied: {
          label: 'Never granted',
          command: process.execPath,
          args: [FIXTURE],
        },
      },
    }),
    'utf8',
  );
  writeFileSync(
    consent,
    JSON.stringify(
      Object.fromEntries(
        ['fake', 'resumer', 'loader', 'modeagent', 'asker', 'splitter'].map((name) => [
          name,
          { enabled: true, overseerAck: true, expires: '2099-01-01T00:00:00Z' },
        ]),
      ),
    ),
    'utf8',
  );
  return { dir, registry, consent, log };
}

function startServer(paths) {
  const child = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      AGENT_HUB_REGISTRY: paths.registry,
      AGENT_HUB_CONSENT: paths.consent,
      AGENT_HUB_LOG: paths.log,
      AGENT_HUB_INFLIGHT: join(paths.dir, 'inflight'),
      AGENT_HUB_LOCKS: join(paths.dir, 'locks'),
      AGENT_HUB_RESULTS: join(paths.dir, 'results'),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const pending = new Map();
  let nextId = 1;
  let stderr = '';
  let exitCode = null;
  let onExit = null;

  const reader = createInterface({ input: child.stdout });
  reader.on('line', (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return; // not protocol; the server must never do this, but don't hide it
    }
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    waiter.resolve(message);
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  child.on('close', (code) => {
    exitCode = code;
    reader.close();
    if (onExit) onExit(code);
  });

  // Fake agents need explicit write-capable permission after restricted
  // dispatches became fail-closed. Individual tests may override it.
  const fixtureParams = (method, params) => {
    if (method !== 'tools/call' || !['ask_agent', 'fanout', 'route'].includes(params?.name)) return params;
    return { ...params, arguments: { permission: 'allow-all', ...params.arguments } };
  };
  const request = (method, params) =>
    new Promise((resolvePromise, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${method} timed out; stderr:\n${stderr}`));
      }, 90_000); // generous: a loaded machine (agents running) once hit 45 s
      pending.set(id, {
        resolve: (message) => {
          clearTimeout(timer);
          resolvePromise(message);
        },
      });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params: fixtureParams(method, params) }) + '\n');
    });

  // Idempotent: t.after() calls this again after a test already stopped the
  // server, and a second wait for a 'close' that already fired would hang.
  const stop = () => {
    if (exitCode !== null) return Promise.resolve(exitCode);
    return new Promise((resolvePromise) => {
      onExit = resolvePromise;
      child.stdin.end();
    });
  };

  return { request, stop, raw: (line) => {
    let message;
    try { message = JSON.parse(line); } catch { child.stdin.write(line + '\n'); return; }
    message.params = fixtureParams(message.method, message.params);
    child.stdin.write(JSON.stringify(message) + '\n');
  }, stderr: () => stderr };
}

async function session(t) {
  const paths = sandbox();
  const server = startServer(paths);
  t.after(() => server.stop());
  const init = await server.request('initialize', {
    protocolVersion: '2025-06-18',
    clientInfo: { name: 'hub-mcp-test', version: '0.0.0' },
  });
  assert.equal(init.result.serverInfo.name, 'agent-hub');
  return { ...server, paths };
}

test('the server speaks MCP over stdio and lists its tools', async (t) => {
  const server = await session(t);
  const list = await server.request('tools/list', {});
  assert.deepEqual(
    list.result.tools.map((tool) => tool.name),
    ['ask_agent', 'fanout', 'route', 'agents', 'job_status', 'job_result', 'job_cancel', 'permission_answer', 'status', 'brief', 'search', 'sessions', 'session_close', 'session_log', 'session_config'],
  );
});

test('ask_agent runs a real turn through hub-acp and returns the answer', async (t) => {
  const server = await session(t);
  const response = await server.request('tools/call', {
    name: 'ask_agent',
    arguments: { agent: 'fake', prompt: 'ping' },
  });

  assert.equal(response.result.isError, false);
  const text = response.result.content[0].text;
  assert.match(text, /agent: fake · status: ok/);
  assert.match(text, /ECHO:ping/);

  const lines = readFileSync(server.paths.log, 'utf8').trim().split('\n');
  assert.equal(lines.length, 1, 'exactly one audit line for one turn');
  const record = JSON.parse(lines[0]);
  assert.equal(record.agent, 'fake');
  assert.equal(record.status, 'ok');
  assert.equal(record.transport, 'acp');
  assert.match(record.prompt, /ping/);

  // The turn is also kept as a transcript under the sandboxed results dir.
  const dir = join(server.paths.dir, 'results', 'transcripts');
  const files = readdirSync(dir);
  assert.equal(files.length, 1);
  assert.equal(files[0], `${record.sessionId}.jsonl`);
  const kinds = readFileSync(join(dir, files[0]), 'utf8').trim().split(/\r?\n/).map((l) => JSON.parse(l).kind);
  assert.equal(kinds[0], 'prompt');
  assert.ok(kinds.includes('text'));
  assert.equal(kinds.at(-1), 'stop');
});

test('a transcript redacts a key split across streamed chunks', async (t) => {
  const server = await session(t);
  const response = await server.request('tools/call', {
    name: 'ask_agent', arguments: { agent: 'splitter', prompt: 'stream it' },
  });
  assert.equal(response.result.isError, false);

  const record = JSON.parse(readFileSync(server.paths.log, 'utf8').trim().split('\n').pop());
  const file = join(server.paths.dir, 'results', 'transcripts', `${record.sessionId}.jsonl`);
  const body = readFileSync(file, 'utf8');
  assert.match(body, /\[redacted\]/);
  assert.doesNotMatch(body, /sk-/);
  // The fixture's key body is twenty Qs followed by twenty Rs: any run of ten
  // is a fragment that survived redaction.
  assert.doesNotMatch(body, /Q{10}|R{10}/);
});

test('ask_agent selects and displays an adapter mode end to end', async (t) => {
  const server = await session(t);
  const response = await server.request('tools/call', {
    name: 'ask_agent', arguments: { agent: 'modeagent', prompt: 'ping', mode: 'plan' },
  });
  assert.equal(response.result.isError, false);
  assert.match(response.result.content[0].text, /mode requested: plan · agent reported: plan/);
  assert.match(response.result.content[0].text, /source: explicit/);
  const record = JSON.parse(readFileSync(server.paths.log, 'utf8').trim());
  assert.equal(record.requestedMode, 'plan');
  assert.equal(record.reportedMode, 'plan');
});

test('ask_agent follow-up restores native mode and allows explicit override', async (t) => {
  const server = await session(t);
  const ask = (args) => server.request('tools/call', {
    name: 'ask_agent', arguments: { agent: 'modeagent', ...args },
  });
  const first = await ask({ prompt: 'first', mode: 'plan' });
  assert.equal(first.result.isError, false);
  const resumed = await ask({ prompt: 'follow up', sessionId: 'fake-session-1' });
  assert.equal(resumed.result.isError, false);
  assert.match(resumed.result.content[0].text, /mode requested: plan · agent reported: plan/);
  assert.match(resumed.result.content[0].text, /source: restored/);
  const override = await ask({ prompt: 'change', sessionId: 'fake-session-1', mode: 'build' });
  assert.equal(override.result.isError, false);
  assert.match(override.result.content[0].text, /mode requested: build · agent reported: build/);
  assert.match(override.result.content[0].text, /source: explicit/);
});

test('a background job preserves its requested adapter mode', async (t) => {
  const server = await session(t);
  const started = await server.request('tools/call', {
    name: 'ask_agent', arguments: { agent: 'modeagent', prompt: 'ping', mode: 'plan', background: true },
  });
  assert.equal(started.result.isError, false);
  const jobId = /job_[0-9a-f]+/.exec(started.result.content[0].text)[0];
  let text = '';
  for (let i = 0; i < 60; i += 1) {
    const response = await server.request('tools/call', { name: 'job_result', arguments: { jobId } });
    text = response.result.content[0].text;
    if (!/still running|not ready/.test(text)) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.match(text, /status: ok/);
  assert.match(text, /mode requested: plan · agent reported: plan/);
});

test('background status and pending result show the live reported mode', async (t) => {
  const server = await session(t);
  const started = await server.request('tools/call', {
    name: 'ask_agent', arguments: { agent: 'modeagent', prompt: 'SLEEP:2500 ping', mode: 'plan', background: true },
  });
  const jobId = /job_[0-9a-f]+/.exec(started.result.content[0].text)[0];
  let status = '';
  for (let i = 0; i < 30; i += 1) {
    const response = await server.request('tools/call', { name: 'job_status', arguments: { jobId } });
    status = response.result.content[0].text;
    if (/agent reported: plan/.test(status)) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.match(status, /running/);
  assert.match(status, /mode requested: plan · agent reported: plan · source: explicit/);
  const result = await server.request('tools/call', { name: 'job_result', arguments: { jobId } });
  assert.match(result.result.content[0].text, /mode requested: plan · agent reported: plan/);
});

test('ask_agent from hands one session\'s answer to another prompt', async (t) => {
  const server = await session(t);
  const first = await server.request('tools/call', {
    name: 'ask_agent',
    arguments: { agent: 'resumer', prompt: 'the fix landed', label: 'fix-one' },
  });
  assert.equal(first.result.isError, false);

  const second = await server.request('tools/call', {
    name: 'ask_agent',
    arguments: { agent: 'resumer', prompt: 'review this', from: { label: 'fix-one', turns: 3 } },
  });
  assert.equal(second.result.isError, false);
  const text = second.result.content[0].text;
  // One prompt in the transcript: three requested turns cannot be carried.
  assert.match(text, /--- from session fix-one \(resumer\), last 1 turn\(s\) ---/);
  assert.match(text, /ECHO:the fix landed/);
  assert.match(text, /--- full transcript: .*fake-session-1\.jsonl ---/);
});

test('a restricted MCP dispatch is rejected before the fake agent starts', async (t) => {
  const server = await session(t);
  const response = await server.request('tools/call', {
    name: 'ask_agent', arguments: { agent: 'fake', prompt: 'ping', permission: 'allow-reads' },
  });
  assert.equal(response.result.isError, true);
  assert.match(response.result.content[0].text, /Restricted permissions cannot be enforced/);
  assert.doesNotMatch(response.result.content[0].text, /ECHO:ping/);
});

test('an agent with no consent grant is refused and still audited', async (t) => {
  const server = await session(t);
  const response = await server.request('tools/call', {
    name: 'ask_agent',
    arguments: { agent: 'denied', prompt: 'should not run' },
  });

  assert.equal(response.result.isError, true);
  assert.match(response.result.content[0].text, /denied/);

  const record = JSON.parse(readFileSync(server.paths.log, 'utf8').trim().split('\n').pop());
  assert.equal(record.agent, 'denied');
  assert.equal(record.status, 'denied');
  assert.match(record.reason, /no consent recorded/);
});

test('the agents tool reports consent and the registry default model', async (t) => {
  const server = await session(t);
  const response = await server.request('tools/call', { name: 'agents', arguments: {} });
  const text = response.result.content[0].text;

  assert.match(text, /fake\s+yes\s+granted\s+fake\/model-1/);
  assert.match(text, /denied\s+yes\s+denied \(no consent recorded/);
});

test('route answers without spending a model call', async (t) => {
  const server = await session(t);
  const response = await server.request('tools/call', {
    name: 'route',
    arguments: { prompt: 'summarize this file' },
  });
  assert.match(response.result.content[0].text, /^routed to: (opencode|claude)/);
});

// gatherStatus() reads the real consent.json/bench/worktrees (it has no env
// override, unlike the other handlers) -- this proves the wiring works at
// all, not the exact numbers, which depend on this machine's live state.
test('the status tool reports the hub\'s own health', async (t) => {
  const server = await session(t);
  const response = await server.request('tools/call', { name: 'status', arguments: {} });
  assert.equal(response.result.isError, false);
  assert.match(response.result.content[0].text, /AGENTHUB/);
});

test('the server exits cleanly when the client closes stdin', async (t) => {
  const server = await session(t);
  const code = await server.stop();
  assert.equal(code, 0);
});

test('a malformed line does not kill the session', async (t) => {
  const server = await session(t);
  server.raw('{not json at all');
  const list = await server.request('tools/list', {});
  assert.equal(list.result.tools.length, 15);
});

// ── per-tree concurrency ────────────────────────────────────────────────────
//
// The MCP server used to serialize every tool call on one promise chain. That
// turned four independent delegations into a queue four deep, each burning its
// own timeout while the rest waited (2026-11-03). Only calls that can edit the
// same working tree have a reason to wait for each other.

test('calls on different trees overlap; calls on the same tree do not', async (t) => {
  const server = await session(t);
  const treeA = join(server.paths.dir, 'tree-a');
  const treeB = join(server.paths.dir, 'tree-b');
  mkdirSync(treeA, { recursive: true });
  mkdirSync(treeB, { recursive: true });

  // The fake agent records "start|end <pid> <ms>" around each turn, so overlap
  // is decided by the intervals themselves rather than by wall-clock margins.
  const marks = join(server.paths.dir, 'marks.log');
  const intervals = () => {
    const byPid = new Map();
    for (const line of readFileSync(marks, 'utf8').trim().split('\n')) {
      const [tag, pid, ms] = line.split(' ');
      const row = byPid.get(pid) ?? {};
      row[tag] = Number(ms);
      byPid.set(pid, row);
    }
    return [...byPid.values()].filter((row) => row.start && row.end);
  };

  const call = (cwd, ms) =>
    server.request('tools/call', {
      name: 'ask_agent',
      arguments: { agent: 'fake', prompt: `SLEEP:${ms} MARK:${marks}`, cwd, timeoutMs: 30_000 },
    });

  await Promise.all([call(treeA, 900), call(treeB, 900)]);
  const parallel = intervals();
  assert.equal(parallel.length, 2, 'both turns reported start and end');
  const [first, second] = parallel;
  assert.ok(
    first.start < second.end && second.start < first.end,
    `different trees must overlap: ${JSON.stringify(parallel)}`,
  );

  writeFileSync(marks, '');
  await Promise.all([call(treeA, 500), call(treeA, 500)]);
  const serial = intervals();
  assert.equal(serial.length, 2);
  const [one, two] = serial.sort((a, b) => a.start - b.start);
  assert.ok(
    one.end <= two.start,
    `the same tree must serialize: ${JSON.stringify(serial)}`,
  );
});

test('status answers while a long turn is still running', async (t) => {
  const server = await session(t);
  const tree = join(server.paths.dir, 'tree-status');
  mkdirSync(tree, { recursive: true });

  const long = server.request('tools/call', {
    name: 'ask_agent',
    arguments: { agent: 'fake', prompt: 'SLEEP:2500', cwd: tree, timeoutMs: 30_000 },
  });
  const started = Date.now();
  const status = await server.request('tools/call', { name: 'status', arguments: {} });
  const statusMs = Date.now() - started;

  assert.equal(status.result.isError, false);
  assert.match(status.result.content[0].text, /AGENTHUB/);
  assert.ok(statusMs < 2000, `a read must not queue behind a turn (took ${statusMs}ms)`);
  await long;
});

// ── model fallback ──────────────────────────────────────────────────────────
//
// The free pool is the default on purpose, and it empties before the paid one.
// That error has to mean "next model in the registry chain", not "task failed"
// -- otherwise every afternoon on a free pool looks like a broken hub.

test('an exhausted model hands the task to the next one in the chain', async (t) => {
  const server = await session(t);
  const response = await server.request('tools/call', {
    name: 'ask_agent',
    arguments: { agent: 'fake', prompt: 'QUOTA:model-1 do the thing' },
  });

  assert.equal(response.result.isError, false);
  const text = response.result.content[0].text;
  assert.match(text, /model: fake\/paid-model/);
  assert.match(text, /models tried: fake\/model-1: failed → fake\/paid-model: ok/);
  assert.match(text, /ECHO:QUOTA:model-1 do the thing \[model=fake\/paid-model\]/);

  // Two audit lines, one per attempt: the failed model is as much a fact as
  // the model that answered.
  const records = readFileSync(server.paths.log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(
    records.map((record) => [record.model, record.status]),
    [
      ['fake/model-1', 'failed'],
      ['fake/paid-model', 'ok'],
    ],
  );
});

// A budget cap is enforced by cancelling the turn, not by throwing: the turn
// still ends normally (see the fake agent's COST: trigger and hub-acp's own
// budget watcher). The caller needs the same "what did it touch" answer a
// timeout gets -- this is the status real dispatches hit on 2026-11-04, with
// no way from the rendered text alone to tell a real failure from a run that
// simply cost more than the default $0.50 cap.

test('a budget-exceeded run still names what it left in the tree', async (t) => {
  const server = await session(t);
  const cwd = join(server.paths.dir, 'tree-budget');
  mkdirSync(cwd, { recursive: true });
  const git = (args) =>
    spawnSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.com', ...args], {
      cwd,
      encoding: 'utf8',
    });
  assert.equal(git(['init', '-q']).status, 0);
  writeFileSync(join(cwd, 'kept.txt'), 'before\n');
  assert.equal(git(['add', '.']).status, 0);
  assert.equal(git(['commit', '-qm', 'base']).status, 0);
  writeFileSync(join(cwd, 'kept.txt'), 'edit a budget-capped agent made\n');

  const response = await server.request('tools/call', {
    name: 'ask_agent',
    arguments: { agent: 'fake', prompt: 'COST:5 do a lot of work', cwd, permission: 'allow-all' },
  });

  assert.equal(response.result.isError, true);
  const text = response.result.content[0].text;
  assert.match(text, /status: budget/);
  assert.match(text, /what it left behind: .*salvage\.json \(git status, HEAD, diffstat\)/);

  const record = JSON.parse(readFileSync(server.paths.log, 'utf8').trim().split('\n').pop());
  assert.equal(record.status, 'budget');
  assert.ok(record.salvage, 'the audit line names a salvage file');
  const salvage = JSON.parse(readFileSync(record.salvage, 'utf8'));
  assert.equal(salvage.dirtyCount, 1);
  assert.ok(salvage.dirty.some((line) => line.includes('kept.txt')));
});

// The default (3) is enough for the $0.51-$1.48 real dispatches that is
// sized for, but a caller doing something bigger -- or smaller -- needs to
// move it, not inherit hub-acp's own $0.5 CLI default by omission.
test('budgetUsd raises or lowers the cap a caller actually gets', async (t) => {
  const server = await session(t);

  const raised = await server.request('tools/call', {
    name: 'ask_agent',
    arguments: { agent: 'fake', prompt: 'COST:5 big task', budgetUsd: 10 },
  });
  assert.equal(raised.result.isError, false, '$5 reported cost stays ok under a $10 cap');
  assert.match(raised.result.content[0].text, /status: ok/);

  const lowered = await server.request('tools/call', {
    name: 'ask_agent',
    arguments: { agent: 'fake', prompt: 'COST:1 small task', budgetUsd: 0.5 },
  });
  assert.equal(lowered.result.isError, true, '$1 reported cost trips a $0.5 cap');
  assert.match(lowered.result.content[0].text, /status: budget/);
});

test('a model named explicitly is never substituted', async (t) => {
  const server = await session(t);
  const response = await server.request('tools/call', {
    name: 'ask_agent',
    arguments: { agent: 'fake', prompt: 'QUOTA:model-1 do the thing', model: 'fake/model-1' },
  });

  assert.equal(response.result.isError, true);
  assert.match(response.result.content[0].text, /Free usage limit reached/);
  const records = readFileSync(server.paths.log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(records.length, 1, 'an explicit model means exactly one attempt');
  assert.equal(records[0].model, 'fake/model-1');
});

// ── background jobs ─────────────────────────────────────────────────────────
//
// A 40-minute delegation must not be a 40-minute tool call: clients time out,
// chats block, and a question asked in the same turn becomes unanswerable.
// `background: true` returns an id at once and the work continues.

test('a background delegation returns an id, is pollable, and keeps its answer', async (t) => {
  const server = await session(t);
  const tree = join(server.paths.dir, 'tree-job');
  mkdirSync(tree, { recursive: true });

  const started = await server.request('tools/call', {
    name: 'ask_agent',
    arguments: { agent: 'fake', prompt: 'SLEEP:700 background work', cwd: tree, background: true },
  });
  assert.equal(started.result.isError, false);
  assert.match(started.result.content[0].text, /job (job_[0-9a-f]+) started/);
  const jobId = /job_[0-9a-f]+/.exec(started.result.content[0].text)[0];

  const early = await server.request('tools/call', { name: 'job_status', arguments: { jobId } });
  assert.match(early.result.content[0].text, /running/);

  // The model comes from the run's inflight file, so it appears while the turn
  // is still going -- that is the difference between "running" and "running on
  // the free model". It is also listed by the status tool, which is how a
  // caller sees jobs it did not start in this turn.
  let live = early.result.content[0].text;
  let listed = '';
  for (let i = 0; i < 30; i += 1) {
    const response = await server.request('tools/call', { name: 'job_status', arguments: { jobId } });
    live = response.result.content[0].text;
    const snapshot = await server.request('tools/call', { name: 'status', arguments: {} });
    listed = snapshot.result.content[0].text;
    if (/model: fake\/model-1/.test(live) && new RegExp(jobId).test(listed)) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.match(live, /model: fake\/model-1/);
  assert.match(listed, /jobs\s+1 in this process/);
  assert.match(listed, new RegExp(jobId));

  // The run carries its job id into results/inflight, so `hubctl status` can
  // name the same job the chat is polling instead of an anonymous run.
  const inflated = readdirSync(join(server.paths.dir, 'inflight')).filter((n) => n.endsWith('.json'));
  assert.equal(inflated.length, 1);
  const record = JSON.parse(readFileSync(join(server.paths.dir, 'inflight', inflated[0]), 'utf8'));
  assert.equal(record.jobId, jobId);

  // Wait for it the way a caller would: poll, don't sleep blindly.
  let text = '';
  for (let i = 0; i < 60; i += 1) {
    const response = await server.request('tools/call', { name: 'job_result', arguments: { jobId } });
    text = response.result.content[0].text;
    if (!/still running|not ready/.test(text)) break;
    await new Promise((resolve) => setTimeout(resolve, 150));
    }

  assert.match(text, /status: ok/);
  assert.match(text, /ECHO:SLEEP:700 background work/);

  // A job saves its answer to results/: if this server dies before the caller
  // collects it, the file is the only copy.
  const saved = readdirSync(join(server.paths.dir, 'results')).filter((name) => name.endsWith('.md'));
  assert.equal(saved.length, 1, 'the job wrote its answer to disk');
});

test('a second job on a busy tree is refused, not raced', async (t) => {
  const server = await session(t);
  const tree = join(server.paths.dir, 'tree-busy');
  mkdirSync(tree, { recursive: true });

  const first = await server.request('tools/call', {
    name: 'ask_agent',
    arguments: { agent: 'fake', prompt: 'SLEEP:1200 first', cwd: tree, background: true },
  });
  const jobId = /job_[0-9a-f]+/.exec(first.result.content[0].text)[0];

  const second = await server.request('tools/call', {
    name: 'ask_agent',
    arguments: { agent: 'fake', prompt: 'SLEEP:200 second', cwd: tree, background: true },
  });
  // Still a refusal, because a non-repository tree cannot hold a worktree;
  // the reason now says so instead of leaving the caller to guess.
  assert.equal(second.result.isError, true);
  const refused = second.result.content[0].text;
  assert.match(refused, /already writing to/);
  assert.match(refused, /\(no worktree: .*not inside a git repository\)/);

  const cancelled = await server.request('tools/call', { name: 'job_cancel', arguments: { jobId } });
  assert.equal(cancelled.result.isError, false);
  assert.match(cancelled.result.content[0].text, /stopped|not exited|did not confirm/);
});

test('a background job climbs the model ladder too', async (t) => {
  const server = await session(t);
  const tree = join(server.paths.dir, 'tree-job-chain');
  mkdirSync(tree, { recursive: true });

  const started = await server.request('tools/call', {
    name: 'ask_agent',
    arguments: {
      agent: 'fake',
      prompt: 'QUOTA:model-1 background work',
      cwd: tree,
      background: true,
    },
  });
  const jobId = /job_[0-9a-f]+/.exec(started.result.content[0].text)[0];

  let text = '';
  for (let i = 0; i < 80; i += 1) {
    const response = await server.request('tools/call', { name: 'job_result', arguments: { jobId } });
    text = response.result.content[0].text;
    if (!/still running|not ready/.test(text)) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  assert.match(text, /model: fake\/paid-model/);
  assert.match(text, /ECHO:QUOTA:model-1 background work \[model=fake\/paid-model\]/);
});

// startJob used to build its base args with the caller's model already
// baked in (hubArgsFor({..., model})), then spawnJob's per-attempt loop
// appended --model again for that same single-model chain -- a pinned model
// on a background job shipped --model twice. Harmless by luck (hub-acp just
// applies the same config value twice), but exactly the kind of thing that
// stops being harmless the day a model id needs escaping or the ACP agent
// rejects a repeated session/set_config_option.
test('a background job with an explicit model sends --model exactly once', async (t) => {
  const server = await session(t);
  const tree = join(server.paths.dir, 'tree-job-pinned-model');
  mkdirSync(tree, { recursive: true });

  const started = await server.request('tools/call', {
    name: 'ask_agent',
    arguments: {
      agent: 'fake',
      prompt: 'REPORT-MODEL-SETS background work',
      model: 'fake/model-1',
      cwd: tree,
      background: true,
    },
  });
  const jobId = /job_[0-9a-f]+/.exec(started.result.content[0].text)[0];

  let text = '';
  for (let i = 0; i < 80; i += 1) {
    const response = await server.request('tools/call', { name: 'job_result', arguments: { jobId } });
    text = response.result.content[0].text;
    if (!/still running|not ready/.test(text)) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  assert.match(text, /model: fake\/model-1/);
  // 2, not 1: the registry's own defaultConfig.model sets it once before the
  // explicit --model is applied (registry defaults apply first, by design --
  // see hub-acp.mjs). The bug this guards against made the explicit one count
  // twice (3 total), not the default disappear.
  assert.match(text, /\[modelSets=2\]/, 'the pinned model was sent exactly once on top of the registry default');
});

// A follow-up should not pay for the task again: `sessionId` continues the
// earlier conversation, whichever of resume/load the agent offers, and each
// turn is still its own consent check and audit line.
test('ask_agent with sessionId continues the session the way the agent supports', async (t) => {
  const server = await session(t);
  const ask = (agent, args = {}) =>
    server.request('tools/call', { name: 'ask_agent', arguments: { agent, prompt: 'follow up', ...args } });

  const first = await ask('resumer');
  const sessionId = /session: (\S+)/.exec(first.result.content[0].text)?.[1];
  assert.ok(sessionId, 'the first answer reports its session id');

  assert.equal((await ask('resumer', { sessionId })).result.isError, false);
  assert.equal((await ask('loader', { sessionId })).result.isError, false);
  const refused = await ask('fake', { sessionId });
  assert.equal(refused.result.isError, true);
  assert.match(refused.result.content[0].text, /cannot continue a session/);

  const records = readFileSync(server.paths.log, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(
    records.map((record) => [record.agent, record.sessionMode, record.status]),
    [
      ['resumer', 'new', 'ok'],
      ['resumer', 'resume', 'ok'],
      ['loader', 'load', 'ok'],
      ['fake', 'continue', 'failed'],
    ],
  );
  assert.equal(records[1].sessionId, sessionId);
});

test('continued sessions retain the selected model unless explicitly changed', async (t) => {
  const server = await session(t);
  const ask = (args) => server.request('tools/call', {
    name: 'ask_agent', arguments: { agent: 'resumer', prompt: 'follow up', ...args },
  });
  const first = await ask({ model: 'fake/chosen' });
  const sessionId = /session: (\S+)/.exec(first.result.content[0].text)?.[1];
  assert.ok(sessionId);
  const second = await ask({ sessionId });
  assert.match(second.result.content[0].text, /\[model=fake\/chosen\]/);
  const third = await ask({ sessionId, model: 'fake/changed' });
  assert.match(third.result.content[0].text, /\[model=fake\/changed\]/);
  const fourth = await ask({ sessionId });
  assert.match(fourth.result.content[0].text, /\[model=fake\/changed\]/);
  const started = await ask({ sessionId, background: true });
  const jobId = /job_[0-9a-f]+/.exec(started.result.content[0].text)?.[0];
  assert.ok(jobId);
  let text = '';
  for (let i = 0; i < 80; i++) {
    const response = await server.request('tools/call', { name: 'job_result', arguments: { jobId } });
    text = response.result.content[0].text;
    if (!/still running|not ready/.test(text)) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.match(text, /\[model=fake\/changed\]/);
});

// Pressing stop in the chat sends `notifications/cancelled`. It used to be
// ignored: the delegated agent worked on until its timeout. Now the run is told
// to stop, cancels its agent, and still writes its audit line.
test('a cancelled tool call stops the agent and is audited as cancelled', async (t) => {
  const before = process.env.HUB_CANCEL_WAIT_MS;
  process.env.HUB_CANCEL_WAIT_MS = '400';
  t.after(() => {
    if (before === undefined) delete process.env.HUB_CANCEL_WAIT_MS;
    else process.env.HUB_CANCEL_WAIT_MS = before;
  });
  const server = await session(t);

  const lastRecord = async (count) => {
    for (let i = 0; i < 300; i++) {
      let lines = [];
      try { lines = readFileSync(server.paths.log, 'utf8').trim().split('\n').filter(Boolean); } catch {}
      if (lines.length >= count) return JSON.parse(lines[count - 1]);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`no audit line ${count}; stderr:\n${server.stderr()}`);
  };
  const call = (id, prompt) => server.raw(JSON.stringify({
    jsonrpc: '2.0', id, method: 'tools/call',
    params: { name: 'ask_agent', arguments: { agent: 'fake', prompt, timeoutMs: 60_000 } },
  }));
  const cancelWhenRunning = async (id) => {
    // The turn is open once the inflight record names a session.
    for (let i = 0; i < 300 && !/model fake\/model-1|fake-session-1/.test(server.stderr() + JSON.stringify(await inflight())); i++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    server.raw(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: id } }));
  };
  const inflight = async () => {
    const dir = join(server.paths.dir, 'inflight');
    try { return readdirSync(dir).map((name) => readFileSync(join(dir, name), 'utf8')); } catch { return []; }
  };

  // An agent that honours session/cancel.
  call(9001, 'HANG-ACK');
  await cancelWhenRunning(9001);
  const acked = await lastRecord(1);
  assert.equal(acked.status, 'cancelled');
  assert.equal(acked.cancelAck, true);
  assert.equal(acked.stopReason, 'cancelled');

  // One that ignores it: terminated after the wait, and the line says so.
  call(9002, 'HANG-IGNORE');
  await cancelWhenRunning(9002);
  const ignored = await lastRecord(2);
  assert.equal(ignored.status, 'cancelled');
  assert.equal(ignored.cancelAck, false);
  assert.match(ignored.error, /did not confirm/);

  // The server is still healthy and never answered the cancelled ids.
  const after = await server.request('tools/call', { name: 'ask_agent', arguments: { agent: 'fake', prompt: 'still here' } });
  assert.match(after.result.content[0].text, /ECHO:still here/);
  assert.equal((await inflight()).length, 0, 'no inflight record is left behind');
});

// ── named sessions ──────────────────────────────────────────────────────────

test('a labelled ask creates a session, continues it, and survives a restart', async (t) => {
  const server = await session(t);
  const text = (r) => r.result.content[0].text;
  const first = await server.request('tools/call', {
    name: 'ask_agent', arguments: { agent: 'resumer', prompt: 'one', label: 't-one' },
  });
  assert.equal(first.result.isError, false, text(first));
  assert.match(text(first), /session: fake-session-1/);

  const registryPath = join(server.paths.dir, 'results', 'sessions.json');
  const stored = JSON.parse(readFileSync(registryPath, 'utf8'));
  assert.equal(stored['t-one'].acpSessionId, 'fake-session-1');
  assert.equal(stored['t-one'].state, 'idle');
  const audit = readFileSync(server.paths.log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(audit[0].label, 't-one');

  // Swap in a distinctive id: the next turn must resume exactly that one.
  stored['t-one'].acpSessionId = 'resume-me-7';
  writeFileSync(registryPath, JSON.stringify(stored));
  const second = await server.request('tools/call', {
    name: 'ask_agent', arguments: { agent: 'resumer', prompt: 'two', label: 't-one' },
  });
  assert.equal(second.result.isError, false, text(second));
  assert.match(text(second), /session: resume-me-7/);

  const listed = await server.request('tools/call', { name: 'sessions', arguments: {} });
  assert.match(text(listed), /t-one/);

  // A new server instance on the same results dir still knows t-one.
  const again = startServer(server.paths);
  t.after(() => again.stop());
  await again.request('initialize', { protocolVersion: '2025-06-18', clientInfo: { name: 'x', version: '0' } });
  const relisted = await again.request('tools/call', { name: 'sessions', arguments: {} });
  assert.match(text(relisted), /t-one/);

  const closed = await again.request('tools/call', { name: 'session_close', arguments: { label: 't-one' } });
  assert.equal(closed.result.isError, false);
  const afterClose = await again.request('tools/call', { name: 'sessions', arguments: {} });
  assert.doesNotMatch(text(afterClose), /t-one/);
});

test('a turn sent while a labelled job runs is queued, then started when it settles', async (t) => {
  const server = await session(t);
  const text = (r) => r.result.content[0].text;
  const started = await server.request('tools/call', {
    name: 'ask_agent', arguments: { agent: 'resumer', prompt: 'first SLEEP:1500', label: 'q-one', background: true },
  });
  assert.match(text(started), /job_/);
  const queued = await server.request('tools/call', {
    name: 'ask_agent', arguments: { agent: 'resumer', prompt: 'second', label: 'q-one' },
  });
  assert.match(text(queued), /queued \(1 waiting\)/);

  const registryPath = join(server.paths.dir, 'results', 'sessions.json');
  const deadline = Date.now() + 30_000;
  let record;
  for (;;) {
    let lines = [];
    try { lines = readFileSync(server.paths.log, 'utf8').trim().split('\n').filter(Boolean); } catch { /* not yet */ }
    const stored = JSON.parse(readFileSync(registryPath, 'utf8'))['q-one'];
    if (lines.length >= 2 && stored.state === 'idle') { record = stored; break; }
    assert.ok(Date.now() < deadline, 'the queued turn never ran');
    await new Promise((r) => setTimeout(r, 200));
  }
  assert.deepEqual(record.queued, []);
  assert.equal(record.jobId, null);
  assert.equal(record.acpSessionId, 'fake-session-1');
});

const sessionsFile = (server) => join(server.paths.dir, 'results', 'sessions.json');
const readStored = (server, label) => JSON.parse(readFileSync(sessionsFile(server), 'utf8'))[label];
const auditLines = (server) => {
  try { return readFileSync(server.paths.log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; }
};
async function waitFor(check, what) {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const value = check();
    if (value) return value;
    assert.ok(Date.now() < deadline, `timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

// A real repository for the worktree paths: the placement code asks git for
// the root and the common dir, so a plain temporary directory is not enough.
function gitRepo(base, name) {
  const dir = join(base, name);
  mkdirSync(dir, { recursive: true });
  const git = (args) =>
    spawnSync('git', args, { cwd: dir, encoding: 'utf8', windowsHide: true });
  assert.equal(git(['init', '-q']).status, 0);
  assert.equal(git(['config', 'user.email', 'test@example.invalid']).status, 0);
  assert.equal(git(['config', 'user.name', 'Test']).status, 0);
  writeFileSync(join(dir, 'README.md'), 'base\n');
  assert.equal(git(['add', '.']).status, 0);
  assert.equal(git(['commit', '-qm', 'init']).status, 0);
  return dir;
}

test('each queued prompt keeps the options of the call that queued it', async (t) => {
  const server = await session(t);
  const ask = (args) => server.request('tools/call', { name: 'ask_agent', arguments: { agent: 'resumer', label: 'q-opts', ...args } });
  await ask({ prompt: 'first SLEEP:2500', background: true });
  const q1 = await ask({ prompt: 'narrow', permission: 'allow-reads', budgetUsd: 1 });
  const q2 = await ask({ prompt: 'wide', permission: 'allow-all', budgetUsd: 9 });
  assert.match(q1.result.content[0].text, /queued \(1 waiting\)/);
  assert.match(q2.result.content[0].text, /queued \(2 waiting\)/);

  const queued = readStored(server, 'q-opts').queued;
  assert.equal(queued[0].prompt, 'narrow');
  assert.equal(queued[0].permission, 'allow-reads');
  assert.equal(queued[0].budgetUsd, 1);
  assert.equal(queued[1].permission, 'allow-all');
  assert.equal(queued[1].budgetUsd, 9);

  // The narrow prompt runs under allow-reads (refused before startup), never allow-all.
  await waitFor(() => readStored(server, 'q-opts').state === 'idle' && readStored(server, 'q-opts').queued.length === 0
    && auditLines(server).some((l) => /wide/.test(l.prompt ?? '')), 'both queued turns');
  const narrow = auditLines(server).find((l) => /narrow/.test(l.prompt ?? ''));
  assert.ok(!narrow || narrow.status !== 'ok', 'the allow-reads prompt did not run write-capable');
});

test('a prompt queued behind a foreground labelled turn is started afterwards', async (t) => {
  const server = await session(t);
  const ask = (args) => server.request('tools/call', { name: 'ask_agent', arguments: { agent: 'resumer', label: 'q-fg', ...args } });
  const foreground = ask({ prompt: 'fg SLEEP:2500' });
  await waitFor(() => { try { return readStored(server, 'q-fg').state === 'running'; } catch { return false; } }, 'foreground turn running');
  const queued = await ask({ prompt: 'after the foreground', background: true });
  assert.match(queued.result.content[0].text, /queued \(1 waiting\)/);
  await foreground;
  await waitFor(() => auditLines(server).some((l) => /after the foreground/.test(l.prompt ?? ''))
    && readStored(server, 'q-fg').state === 'idle' && readStored(server, 'q-fg').queued.length === 0, 'the queued turn to run');
});

test('a registry failure after a foreground turn warns but keeps the answer; a stale running session can be closed', async (t) => {
  const server = await session(t);
  const ask = (args) => server.request('tools/call', { name: 'ask_agent', arguments: { agent: 'resumer', label: 'stuck', ...args } });
  const turn = ask({ prompt: 'work SLEEP:1500' });
  await waitFor(() => { try { return readStored(server, 'stuck').state === 'running'; } catch { return false; } }, 'turn running');
  writeFileSync(`${sessionsFile(server)}.lock`, 'held'); // someone else holds the registry
  const answer = await turn;
  const text = answer.result.content[0].text;
  assert.match(text, /ECHO:work/, 'the answer survives');
  assert.match(text, /\[warning: session stuck could not be updated/);
  assert.equal(readStored(server, 'stuck').state, 'running');
  rmSync(`${sessionsFile(server)}.lock`, { force: true });

  const closed = await server.request('tools/call', { name: 'session_close', arguments: { label: 'stuck' } });
  assert.equal(closed.result.isError, false, closed.result.content[0].text);
  assert.equal(readStored(server, 'stuck').state, 'closed');
});

test('a session driven by another live hub process survives startup and cannot be closed here', async (t) => {
  const paths = sandbox();
  const results = join(paths.dir, 'results');
  mkdirSync(results, { recursive: true });
  const file = join(results, 'sessions.json');
  const record = (label, ownerPid) => ({
    label, agent: 'fake', acpSessionId: null, cwd: results, worktree: null, model: null, effort: null,
    state: 'running', resumable: null, createdAt: 1, lastActivity: 1, spendUsd: 0,
    jobId: `job_${label}`, lastTurn: null, ownerPid, queued: [], dropped: [],
  });
  writeFileSync(file, JSON.stringify({
    foreign: record('foreign', process.pid),
    dead: record('dead', 999999),
  }));

  const server = startServer(paths);
  t.after(() => server.stop());
  await server.request('initialize', { protocolVersion: '2025-06-18', clientInfo: { name: 'x', version: '0' } });

  // Startup reconcile is for stale records only: the other window's turn stays.
  const stored = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(stored.foreign.state, 'running');
  assert.equal(stored.dead.state, 'idle');

  const closed = await server.request('tools/call', { name: 'session_close', arguments: { label: 'foreign' } });
  assert.match(closed.error?.message ?? '', new RegExp(`another hub process \\(pid ${process.pid}\\)`));
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).foreign.state, 'running');

  // A turn addressed to it queues behind the other window's turn instead of
  // racing it, so cross-window queueing still works.
  const queued = await server.request('tools/call', {
    name: 'ask_agent', arguments: { agent: 'fake', prompt: 'later', label: 'foreign' },
  });
  assert.match(queued.result.content[0].text, /queued \(1 waiting\)/);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).foreign.queued.map((entry) => entry.prompt), ['later']);

  // The dead owner is stale and stays closable.
  const dead = await server.request('tools/call', { name: 'session_close', arguments: { label: 'dead' } });
  assert.equal(dead.result.isError, false, JSON.stringify(dead));
});

test('permission "ask" holds a request for the person, answers it, and records the decision', async (t) => {
  const server = await session(t);
  const text = (r) => r.result.content[0].text;
  const cwd = mkdtempSync(join(tmpdir(), 'hub-ask-cwd-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));

  const started = await server.request('tools/call', {
    name: 'ask_agent',
    arguments: { agent: 'asker', prompt: 'run the tests', cwd, permission: 'ask', background: true, label: 'attended' },
  });
  assert.equal(started.result.isError, false, text(started));
  const jobId = /job_[0-9a-f]+/.exec(text(started))[0];

  const deadline = Date.now() + 30_000;
  let statusText = '';
  for (;;) {
    statusText = text(await server.request('tools/call', { name: 'job_status', arguments: { jobId } }));
    if (/waiting-permission/.test(statusText)) break;
    assert.ok(Date.now() < deadline, `never held a permission:\n${statusText}`);
    await new Promise((r) => setTimeout(r, 200));
  }
  assert.match(statusText, /WAITING FOR PERMISSION: Run npm test \(execute\)/);
  assert.equal(readStored(server, 'attended').state, 'waiting-permission');
  const requestId = /request (perm_\S+)/.exec(statusText)?.[1];
  assert.ok(requestId, `job_status must show the request id:\n${statusText}`);

  const answered = await server.request('tools/call', {
    name: 'permission_answer', arguments: { jobId, requestId, decision: 'reject' },
  });
  assert.equal(answered.result.isError, false, text(answered));

  let resultText = '';
  for (;;) {
    resultText = text(await server.request('tools/call', { name: 'job_result', arguments: { jobId } }));
    if (!/still running|not ready yet/.test(resultText)) break;
    assert.ok(Date.now() < deadline, `the job never ended:\n${resultText}`);
    await new Promise((r) => setTimeout(r, 200));
  }
  assert.match(resultText, /PERM:reject-once/, resultText);
  assert.equal(readStored(server, 'attended').state, 'idle');

  // What the person decided is part of the session's transcript.
  const transcript = join(server.paths.dir, 'results', 'transcripts', 'fake-session-1.jsonl');
  const records = readFileSync(transcript, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  const decision = records.find((record) => record.kind === 'permission');
  assert.equal(decision.decision, 'reject');
  assert.equal(decision.title, 'Run npm test');

  // Answering a request that no longer exists is a clear no, not a crash.
  const again = await server.request('tools/call', {
    name: 'permission_answer', arguments: { jobId, requestId, decision: 'allow_once' },
  });
  assert.equal(again.result.isError, true);
  assert.match(text(again), new RegExp(`no pending permission request for ${jobId}`));
});

test('a job held for permission can be cancelled, and its session stays usable', async (t) => {
  const server = await session(t);
  const text = (r) => r.result.content[0].text;
  const cwd = mkdtempSync(join(tmpdir(), 'hub-ask-cancel-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));

  const started = await server.request('tools/call', {
    name: 'ask_agent',
    arguments: { agent: 'asker', prompt: 'run the tests', cwd, permission: 'ask', background: true, label: 'held-cancel' },
  });
  assert.equal(started.result.isError, false, text(started));
  const jobId = /job_[0-9a-f]+/.exec(text(started))[0];

  const deadline = Date.now() + 30_000;
  let held = false;
  while (!held) {
    held = /waiting-permission/.test(text(await server.request('tools/call', { name: 'job_status', arguments: { jobId } })));
    if (held) break;
    assert.ok(Date.now() < deadline, 'the job never held a permission');
    await new Promise((r) => setTimeout(r, 200));
  }

  const cancelled = await server.request('tools/call', { name: 'job_cancel', arguments: { jobId } });
  assert.equal(cancelled.result.isError, false, text(cancelled));

  await waitFor(() => {
    try { return readStored(server, 'held-cancel').state === 'idle'; } catch { return false; }
  }, 'the session back to idle');
  assert.equal(readStored(server, 'held-cancel').lastTurn, 'cancelled');
  const result = await server.request('tools/call', { name: 'job_result', arguments: { jobId } });
  assert.match(text(result), /cancelled/);
});

// ── worktrees for named sessions ────────────────────────────────────────────
//
// A second write-capable turn used to be refused on a busy tree. It now gets
// its own checkout under the repository's git dir, so two writers proceed and
// neither edits the other's files. The tree is claimed per turn, but a session
// started in a worktree stays there.

async function collect(server, jobId) {
  let text = '';
  for (let i = 0; i < 100; i += 1) {
    const response = await server.request('tools/call', { name: 'job_result', arguments: { jobId } });
    text = response.result.content[0].text;
    if (!/still running|not ready/.test(text)) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return text;
}

test('a write-capable job on a busy tree is placed in a worktree and the session keeps it', async (t) => {
  const server = await session(t);
  const text = (r) => r.result.content[0].text;
  const repo = gitRepo(server.paths.dir, 'wt-busy');

  const first = await server.request('tools/call', {
    name: 'ask_agent',
    arguments: {
      agent: 'resumer', prompt: 'SLEEP:4000 hold the tree', cwd: repo,
      permission: 'allow-all', background: true, label: 'wt-holder',
    },
  });
  assert.equal(first.result.isError, false, text(first));
  const firstId = /job_[0-9a-f]+/.exec(text(first))[0];

  const second = await server.request('tools/call', {
    name: 'ask_agent',
    arguments: {
      agent: 'resumer', prompt: 'SLEEP:300 second writer', cwd: repo,
      permission: 'allow-all', background: true, label: 'wt-placed',
    },
  });
  assert.equal(second.result.isError, false, text(second));
  const secondText = text(second);
  // The exact sentence that says where the turn went and why.
  assert.match(secondText, /placed in worktree .+ because .+ is busy/);
  const placed = /placed in worktree (.+) because /.exec(secondText)[1];
  assert.ok(placed.replace(/\\/g, '/').includes('/.git/agent-worktrees/'), placed);
  assert.ok(existsSync(placed), 'the worktree exists on disk');
  assert.equal(readStored(server, 'wt-placed').worktree.path, placed, 'the session records its worktree');

  const secondId = /job_[0-9a-f]+/.exec(secondText)[0];
  const answer = await collect(server, secondId);
  assert.match(answer, /status: ok/, answer);
  assert.match(answer, /ECHO:SLEEP:300 second writer/, answer);
  assert.ok(answer.includes(placed), `the collected answer names the worktree:\n${answer}`);

  // A later turn of the same label runs there, with no second worktree.
  const later = await server.request('tools/call', {
    name: 'ask_agent', arguments: { agent: 'resumer', prompt: 'later turn', label: 'wt-placed' },
  });
  assert.equal(later.result.isError, false, text(later));
  assert.equal(readStored(server, 'wt-placed').worktree.path, placed, 'a kept worktree is not replaced');

  const listed = text(await server.request('tools/call', { name: 'sessions', arguments: {} }));
  assert.ok(listed.includes(placed), `sessions shows the worktree:\n${listed}`);

  // close reports the state of the checkout, and never deletes it.
  writeFileSync(join(placed, 'agent-output.txt'), 'changed\n');
  const closed = await server.request('tools/call', { name: 'session_close', arguments: { label: 'wt-placed' } });
  assert.equal(closed.result.isError, false, text(closed));
  assert.ok(text(closed).includes(placed));
  assert.match(text(closed), /worktree kept at /);
  assert.match(text(closed), /has changes/);
  assert.ok(existsSync(placed), 'session_close never deletes a worktree');

  await server.request('tools/call', { name: 'job_cancel', arguments: { jobId: firstId } });
});

test('worktree: true runs in a fresh worktree, and refuses outside a repository', async (t) => {
  const server = await session(t);
  const text = (r) => r.result.content[0].text;
  const repo = gitRepo(server.paths.dir, 'wt-explicit');

  const started = await server.request('tools/call', {
    name: 'ask_agent',
    arguments: {
      agent: 'fake', prompt: 'SLEEP:200 explicit worktree', cwd: repo,
      permission: 'allow-all', worktree: true, background: true, label: 'wt-explicit',
    },
  });
  assert.equal(started.result.isError, false, text(started));
  const wtPath = / in (.+)\n/.exec(text(started))[1];
  assert.ok(wtPath.replace(/\\/g, '/').includes('/.git/agent-worktrees/'), text(started));
  assert.ok(existsSync(wtPath));
  assert.equal(readStored(server, 'wt-explicit').worktree.path, wtPath);

  const jobId = /job_[0-9a-f]+/.exec(text(started))[0];
  assert.match(await collect(server, jobId), /status: ok/);

  // Outside a git repository there is nothing to check out: the turn must not
  // start, and the answer has to say why in those words.
  const plain = mkdtempSync(join(tmpdir(), 'hub-norepo-'));
  t.after(() => rmSync(plain, { recursive: true, force: true }));
  const refused = await server.request('tools/call', {
    name: 'ask_agent',
    arguments: { agent: 'fake', prompt: 'must not run', cwd: plain, worktree: true },
  });
  assert.equal(refused.result.isError, true);
  assert.match(text(refused), /cannot use a worktree: .*not inside a git repository/);
  assert.doesNotMatch(text(refused), /ECHO:must not run/);
});

test('worktree: true on an existing labelled session is recorded and kept', async (t) => {
  const server = await session(t);
  const text = (r) => r.result.content[0].text;
  const repo = gitRepo(server.paths.dir, 'wt-late');

  // The session exists first, with no checkout of its own.
  const first = await server.request('tools/call', {
    name: 'ask_agent',
    arguments: { agent: 'resumer', prompt: 'first turn', cwd: repo, label: 'wt-late' },
  });
  assert.equal(first.result.isError, false, text(first));
  assert.equal(readStored(server, 'wt-late').worktree, null);

  const second = await server.request('tools/call', {
    name: 'ask_agent',
    arguments: { agent: 'resumer', prompt: 'second turn', label: 'wt-late', worktree: true },
  });
  assert.equal(second.result.isError, false, text(second));
  const recorded = readStored(server, 'wt-late');
  assert.ok(recorded.worktree?.path, 'the existing session records the checkout it was given');
  const wtPath = recorded.worktree.path;
  assert.ok(wtPath.replace(/\\/g, '/').includes('/.git/agent-worktrees/'), wtPath);
  assert.equal(recorded.cwd, repo, 'the session keeps its original tree as cwd');
  assert.equal(auditLines(server).find((line) => /second turn/.test(line.prompt ?? ''))?.cwd, wtPath);

  const third = await server.request('tools/call', {
    name: 'ask_agent',
    arguments: { agent: 'resumer', prompt: 'third turn', label: 'wt-late' },
  });
  assert.equal(third.result.isError, false, text(third));
  assert.equal(readStored(server, 'wt-late').worktree.path, wtPath);
  assert.equal(auditLines(server).find((line) => /third turn/.test(line.prompt ?? ''))?.cwd, wtPath);

  const checkouts = readdirSync(join(repo, '.git', 'agent-worktrees'));
  assert.equal(checkouts.length, 1, `a later turn creates no second checkout: ${checkouts}`);
});

test('a removed checkout is reported and refused, not silently replaced', async (t) => {
  const server = await session(t);
  const text = (r) => r.result.content[0].text;
  const repo = gitRepo(server.paths.dir, 'wt-gone');

  const started = await server.request('tools/call', {
    name: 'ask_agent',
    arguments: {
      agent: 'resumer', prompt: 'SLEEP:200 make the checkout', cwd: repo,
      worktree: true, background: true, label: 'wt-gone',
    },
  });
  assert.equal(started.result.isError, false, text(started));
  const wtPath = readStored(server, 'wt-gone').worktree.path;
  const jobId = /job_[0-9a-f]+/.exec(text(started))[0];
  assert.match(await collect(server, jobId), /status: ok/);

  // Somebody removes the checkout by hand. The session must not quietly fall
  // back to the original tree: that would put two writers back together.
  rmSync(wtPath, { recursive: true, force: true });
  const refused = await server.request('tools/call', {
    name: 'ask_agent', arguments: { agent: 'resumer', prompt: 'after deletion', label: 'wt-gone' },
  });
  assert.equal(refused.result.isError, true);
  assert.match(
    text(refused),
    /cannot use a worktree: .*is missing \(the session's checkout was removed\)/,
  );
  assert.ok(text(refused).includes(wtPath));

  const closed = await server.request('tools/call', { name: 'session_close', arguments: { label: 'wt-gone' } });
  assert.equal(closed.result.isError, false);
  assert.ok(text(closed).includes(`worktree missing at ${wtPath}`), text(closed));
});

test('a denied worktree run leaves no checkout behind', async (t) => {
  const server = await session(t);
  const text = (r) => r.result.content[0].text;
  const repo = gitRepo(server.paths.dir, 'wt-denied');

  const started = await server.request('tools/call', {
    name: 'ask_agent',
    arguments: { agent: 'denied', prompt: 'never runs', cwd: repo, worktree: true, background: true },
  });
  assert.equal(started.result.isError, false, text(started));

  // The checkout is made synchronously in startJob, before the job starts, so
  // the start reply names it and it exists now. Without this the "no checkout
  // left behind" assertion would also pass if none had ever been made.
  const checkout = / in (.+)\n/.exec(text(started))[1];
  assert.ok(checkout.replace(/\\/g, '/').includes('/.git/agent-worktrees/'), text(started));
  assert.ok(existsSync(checkout), `the placement created the checkout: ${checkout}`);

  const jobId = /job_[0-9a-f]+/.exec(text(started))[0];
  assert.match(await collect(server, jobId), /status: denied/);

  const checkouts = join(repo, '.git', 'agent-worktrees');
  await waitFor(
    () => !existsSync(checkout),
    'the denied checkout to be removed',
  );
  assert.ok(!existsSync(checkout), 'the checkout the denied run was given is gone');
  const left = existsSync(checkouts) ? readdirSync(checkouts) : [];
  assert.deepEqual(left, [], `no checkout is left behind: ${left}`);
});

test('a denied foreground worktree run leaves no checkout and no pinned session', async (t) => {
  const server = await session(t);
  const text = (r) => r.result.content[0].text;
  const repo = gitRepo(server.paths.dir, 'wt-denied-fg');

  // Foreground and labelled: this is the path that used to keep a checkout the
  // run never touched, pinning the label to it for every later turn. Watch the
  // session record while the turn runs: beginTurn writes the checkout before
  // the agent is spawned, and the cleanup clears it, so this proves a checkout
  // really existed and that "none left" is not "none ever made".
  let settled = false;
  const pending = server.request('tools/call', {
    name: 'ask_agent',
    arguments: { agent: 'denied', prompt: 'never runs either', cwd: repo, worktree: true, label: 'wt-denied-fg' },
  }).finally(() => { settled = true; });
  let placedDuring = null;
  const deadline = Date.now() + 20_000;
  while (!settled && Date.now() < deadline) {
    try {
      placedDuring = readStored(server, 'wt-denied-fg')?.worktree?.path ?? null;
    } catch {
      placedDuring = null; // the registry file does not exist yet
    }
    if (placedDuring) break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const answer = await pending;

  assert.equal(answer.result.isError, true);
  assert.match(text(answer), /status: denied/, text(answer));
  assert.match(text(answer), /no consent recorded/, text(answer));
  assert.ok(placedDuring, 'the labelled turn was given a checkout before the refusal');
  assert.ok(
    placedDuring.replace(/\\/g, '/').includes('/.git/agent-worktrees/'),
    `the turn's checkout: ${placedDuring}`,
  );

  const checkouts = join(repo, '.git', 'agent-worktrees');
  const left = existsSync(checkouts) ? readdirSync(checkouts) : [];
  assert.deepEqual(left, [], `no checkout is left behind: ${left}`);

  const stored = readStored(server, 'wt-denied-fg');
  assert.equal(stored.worktree, null, 'the label is not pinned to the discarded checkout');
  assert.equal(stored.state, 'idle');
  assert.equal(stored.lastTurn, 'failed');
});
