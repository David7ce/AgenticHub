import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
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
        resumer: { label: 'Resumes', command: process.execPath, args: [FIXTURE], env: { FAKE_ACP_CAPS: 'resume' } },
        loader: { label: 'Loads', command: process.execPath, args: [FIXTURE], env: { FAKE_ACP_CAPS: 'load' } },
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
        ['fake', 'resumer', 'loader'].map((name) => [
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
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
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

  return { request, stop, raw: (line) => child.stdin.write(line + '\n'), stderr: () => stderr };
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
    ['ask_agent', 'fanout', 'route', 'agents', 'job_status', 'job_result', 'job_cancel', 'status', 'brief', 'search'],
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
  assert.equal(list.result.tools.length, 10);
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
  assert.equal(second.result.isError, true);
  assert.match(second.result.content[0].text, /already writing to/);

  const cancelled = await server.request('tools/call', { name: 'job_cancel', arguments: { jobId } });
  assert.equal(cancelled.result.isError, false);
  assert.match(cancelled.result.content[0].text, /stopped|not exited/);
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
