import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { makePermissionHandler } from '../acp-client.mjs';

const options = [
  { optionId: 'allow-once', kind: 'allow_once' },
  { optionId: 'allow-always', kind: 'allow_always' },
  { optionId: 'reject-once', kind: 'reject_once' },
];

const read = { toolCallId: 't1', title: 'Read a file', kind: 'read', status: 'pending' };
const edit = { toolCallId: 't2', title: 'Write a file', kind: 'edit', status: 'pending' };
const exec = { toolCallId: 't3', title: 'Run a command', kind: 'execute', status: 'pending' };

test('deny rejects an otherwise safe tool', async () => {
  const outcome = await makePermissionHandler('deny')({ toolCall: read, options });
  assert.deepEqual(outcome, { outcome: { outcome: 'selected', optionId: 'reject-once' } });
});

test('allow-reads permits read/search/fetch/think', async () => {
  for (const kind of ['read', 'search', 'fetch', 'think']) {
    const outcome = await makePermissionHandler('allow-reads')({
      toolCall: { ...read, kind },
      options,
    });
    assert.equal(outcome.outcome.optionId, 'allow-once', kind);
  }
});

test('allow-reads still rejects edit/execute', async () => {
  for (const toolCall of [edit, exec]) {
    const outcome = await makePermissionHandler('allow-reads')({ toolCall, options });
    assert.equal(outcome.outcome.optionId, 'reject-once', toolCall.kind);
  }
});

test('allow-all picks allow_once, never allow_always implicitly', async () => {
  const outcome = await makePermissionHandler('allow-all')({ toolCall: exec, options });
  assert.equal(outcome.outcome.optionId, 'allow-once');
});

test('no reject option means cancelled, not allowed', async () => {
  const outcome = await makePermissionHandler('deny')({
    toolCall: read,
    options: [{ optionId: 'allow-once', kind: 'allow_once' }],
  });
  assert.deepEqual(outcome, { outcome: { outcome: 'cancelled' } });
});

test('permission decisions are reported with the policy and tool kind', async () => {
  const logged = [];
  const handler = makePermissionHandler('allow-reads', (d) => logged.push(d));
  await handler({ toolCall: read, options });
  await handler({ toolCall: edit, options });
  assert.deepEqual(
    logged.map((d) => [d.decision, d.kind, d.policy]),
    [
      ['allow', 'read', 'allow-reads'],
      ['reject', 'edit', 'allow-reads'],
    ],
  );
});

// ── ask: attended policy ────────────────────────────────────────────────────
//
// ask never guesses on a write: an edit whose paths are all inside the tree
// goes ahead (the agent is doing its job), everything else is put to the
// person. These tests drive the handler directly, so the hold is a stub.

const tree = mkdtempSync(join(tmpdir(), 'hub-ask-tree-'));
const outside = mkdtempSync(join(tmpdir(), 'hub-ask-outside-'));

function askHandler({ hold, log } = {}) {
  return makePermissionHandler('ask', log ?? (() => {}), {
    hold: hold ?? (async () => 'allow_once'),
    treeRoot: tree,
  });
}

function inTreeEdit() {
  return { ...edit, locations: [{ path: join(tree, 'src', 'a.js') }] };
}

test('ask allows an edit that stays inside the tree, without holding', async () => {
  let held = 0;
  const handler = askHandler({
    hold: async () => {
      held += 1;
      return 'reject';
    },
  });
  const outcome = await handler({ toolCall: inTreeEdit(), options });
  assert.equal(outcome.outcome.optionId, 'allow-once');
  assert.equal(held, 0, 'an in-tree edit is the agent doing its job');
});

test('ask holds an out-of-tree edit and selects what the person answered', async () => {
  const heldWith = [];
  const handler = askHandler({
    hold: async (request) => {
      heldWith.push(request);
      return 'allow_once';
    },
  });
  const toolCall = { ...edit, locations: [{ path: join(outside, 'a.js') }] };
  const outcome = await handler({ toolCall, options });
  assert.equal(outcome.outcome.optionId, 'allow-once');
  assert.equal(heldWith.length, 1);
  assert.equal(heldWith[0].kind, 'edit');
  assert.equal(heldWith[0].title, 'Write a file');
});

test('ask holds execute, fetch and any unknown kind', async () => {
  const held = [];
  const handler = askHandler({
    hold: async (request) => {
      held.push(request.kind);
      return 'allow_once';
    },
  });
  for (const kind of ['execute', 'fetch', 'other']) {
    const outcome = await handler({ toolCall: { ...exec, kind }, options });
    assert.equal(outcome.outcome.optionId, 'allow-once', kind);
  }
  assert.deepEqual(held, ['execute', 'fetch', 'other']);
});

test('ask holds an edit that names no location', async () => {
  let held = 0;
  const handler = askHandler({
    hold: async () => {
      held += 1;
      return 'allow_once';
    },
  });
  await handler({ toolCall: edit, options });
  assert.equal(held, 1, 'an edit that does not say where it writes is not in-tree');
});

// Ruling 2: read/search are auto-allowed only when every location they name is
// inside the tree; with no locations they are allowed; anything outside is held.
// `think` names no file at all and is always the agent doing its job.

test('ask holds a read that names a location outside the tree', async () => {
  const held = [];
  const handler = askHandler({
    hold: async (request) => {
      held.push(request);
      return 'allow_once';
    },
  });
  const toolCall = { ...read, locations: [{ path: join(outside, 'secret.txt') }] };
  const outcome = await handler({ toolCall, options });
  assert.equal(outcome.outcome.optionId, 'allow-once', 'the person allowed it');
  assert.equal(held.length, 1, 'an out-of-tree read is put to the person');
  assert.equal(held[0].kind, 'read');
});

test('ask holds a search that names a location outside the tree', async () => {
  let held = 0;
  const handler = askHandler({
    hold: async () => {
      held += 1;
      return 'reject';
    },
  });
  const toolCall = {
    ...read,
    kind: 'search',
    locations: [{ path: join(tree, 'src') }, { path: join(outside, 'src') }],
  };
  const outcome = await handler({ toolCall, options });
  assert.equal(outcome.outcome.optionId, 'reject-once', 'the person rejected it');
  assert.equal(held, 1, 'one out-of-tree location is enough to hold');
});

test('ask allows a read or search that names no location, without holding', async () => {
  let held = 0;
  const handler = askHandler({
    hold: async () => {
      held += 1;
      return 'reject';
    },
  });
  for (const kind of ['read', 'search']) {
    const outcome = await handler({ toolCall: { ...read, kind }, options });
    assert.equal(outcome.outcome.optionId, 'allow-once', kind);
  }
  assert.equal(held, 0, 'no location says nothing about leaving the tree');
});

test('ask always allows think, with or without locations', async () => {
  let held = 0;
  const handler = askHandler({
    hold: async () => {
      held += 1;
      return 'reject';
    },
  });
  for (const toolCall of [
    { ...read, kind: 'think' },
    { ...read, kind: 'think', locations: [{ path: join(outside, 'a.txt') }] },
  ]) {
    const outcome = await handler({ toolCall, options });
    assert.equal(outcome.outcome.optionId, 'allow-once');
  }
  assert.equal(held, 0, 'thinking is never a decision for the person');
});

test('ask maps a rejected hold to reject-once and logs the rejection', async () => {
  const logged = [];
  const handler = askHandler({
    hold: async () => 'reject',
    log: (d) => logged.push(d),
  });
  const outcome = await handler({ toolCall: exec, options });
  assert.equal(outcome.outcome.optionId, 'reject-once');
  assert.equal(logged[0].decision, 'reject');
  assert.equal(logged[0].policy, 'ask');
});

test('ask records a request nobody answered as a timeout', async () => {
  const logged = [];
  const handler = askHandler({
    hold: async () => ({ decision: 'reject', reason: 'timeout' }),
    log: (d) => logged.push(d),
  });
  const outcome = await handler({ toolCall: exec, options });
  assert.equal(outcome.outcome.optionId, 'reject-once');
  assert.equal(logged[0].decision, 'timeout');
});

test('ask records a hold that failed as hold-failed, not as the owner saying no', async () => {
  const logged = [];
  const handler = askHandler({
    hold: async () => {
      throw new Error('ipc gone');
    },
    log: (d) => logged.push(d),
  });
  const outcome = await handler({ toolCall: exec, options });
  assert.equal(outcome.outcome.optionId, 'reject-once');
  assert.equal(logged[0].decision, 'reject');
  assert.equal(logged[0].reason, 'hold-failed');
});

// ── ask end to end: the IPC hold, the answer and the paused turn timer ─────

const HERE = dirname(fileURLToPath(import.meta.url));
const HUB_ACP = resolve(HERE, '..', 'hub-acp.mjs');
const FIXTURE = resolve(HERE, '..', '..', 'mcp', 'tests', 'fixtures', 'fake-acp-agent.mjs');

// Spawning hub-acp writes transcripts and inflight files: keep them out of the
// real results dir, as the other suites do.
process.env.AGENT_HUB_RESULTS = mkdtempSync(join(tmpdir(), 'hub-results-'));

function askSandbox(permissionMode = 'execute') {
  const dir = mkdtempSync(join(tmpdir(), 'hub-ask-e2e-'));
  const registry = join(dir, 'agents.json');
  const consent = join(dir, 'consent.json');
  const cwd = join(dir, 'tree');
  mkdirSync(cwd);
  writeFileSync(registry, JSON.stringify({
    agents: {
      asker: {
        label: 'Asks the owner',
        command: process.execPath,
        args: [FIXTURE],
        env: { FAKE_PERMISSION: permissionMode },
        defaultConfig: { model: 'fake/ask' },
      },
    },
  }));
  writeFileSync(consent, JSON.stringify({
    asker: { enabled: true, overseerAck: true, expires: '2099-01-01T00:00:00Z' },
  }));
  return { dir, registry, consent, cwd };
}

function runAsk(paths, { args = [], prompt = 'run the tests', env = {}, onRequest = () => {}, onMessage = () => {} } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(
      process.execPath,
      [
        HUB_ACP, '--agent', 'asker', '--permission', 'ask', '--prompt', prompt,
        '--cwd', paths.cwd, '--registry', paths.registry, '--json', '--no-save', ...args,
      ],
      {
        env: {
          ...process.env,
          AGENT_HUB_CONSENT: paths.consent,
          AGENT_HUB_LOG: join(paths.dir, 'runs.jsonl'),
          AGENT_HUB_LOCKS: join(paths.dir, 'locks'),
          AGENT_HUB_RESULTS: join(paths.dir, 'results'),
          AGENT_HUB_INFLIGHT: join(paths.dir, 'inflight'),
          ...env,
        },
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      },
    );
    let stdout = '';
    let stderr = '';
    const requests = [];
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('message', (message) => {
      onMessage(child, message);
      if (message?.type !== 'permission-request') return;
      requests.push(message);
      onRequest(child, message);
    });
    child.on('close', (code) => {
      const text = stdout.trim();
      if (!text) {
        reject(new Error(`hub-acp exited ${code} with no output\n${stderr}`));
        return;
      }
      try {
        resolvePromise({ code, json: JSON.parse(text), stderr, requests });
      } catch (err) {
        reject(new Error(`hub-acp did not return JSON: ${text.slice(0, 300)}\n${stderr}`));
      }
    });
  });
}

test('nobody answers a held request: it is rejected after --permission-timeout', async () => {
  const paths = askSandbox();
  const run = await runAsk(paths, { args: ['--permission-timeout', '200'] });
  assert.equal(run.code, 0, run.stderr);
  assert.equal(run.requests.length, 1, 'the child asked over IPC');
  assert.equal(run.json.status, 'ok', run.json.error);
  assert.equal(run.json.permissions[0].decision, 'timeout');
  assert.match(run.json.text, /PERM:reject-once/);
});

test('an answer over IPC releases the turn, and the turn timer is paused meanwhile', async () => {
  const paths = askSandbox();
  let askedAt = 0;
  let answeredAt = 0;
  const run = await runAsk(paths, {
    // The turn would time out 300 ms after the prompt starts. The permission
    // is held for 600 ms, so this passes only if holding pauses that clock.
    args: ['--timeout', '300'],
    onRequest: (child, message) => {
      askedAt = Date.now();
      setTimeout(() => {
        answeredAt = Date.now();
        child.send({ type: 'permission-answer', requestId: message.requestId, decision: 'allow_once' });
      }, 600);
    },
  });
  assert.equal(run.code, 0, run.stderr);
  assert.equal(run.requests.length, 1, 'the child asked over IPC');
  assert.equal(run.json.status, 'ok', run.json.error);
  assert.ok(answeredAt - askedAt >= 550, `held for ${answeredAt - askedAt}ms`);
  assert.equal(run.json.permissions[0].decision, 'allow');
  assert.match(run.json.text, /PERM:allow-once/);
});

test('ask with no IPC caller rejects at once instead of holding out the timeout', () => {
  const paths = askSandbox();
  const started = Date.now();
  const result = spawnSync(
    process.execPath,
    [
      HUB_ACP, '--agent', 'asker', '--permission', 'ask', '--prompt', 'run the tests',
      '--cwd', paths.cwd, '--registry', paths.registry, '--json', '--no-save',
    ],
    {
      encoding: 'utf8',
      timeout: 25_000,
      env: {
        ...process.env,
        AGENT_HUB_CONSENT: paths.consent,
        AGENT_HUB_LOG: join(paths.dir, 'runs.jsonl'),
        AGENT_HUB_LOCKS: join(paths.dir, 'locks'),
        AGENT_HUB_RESULTS: join(paths.dir, 'results'),
        AGENT_HUB_INFLIGHT: join(paths.dir, 'inflight'),
      },
    },
  );
  const body = JSON.parse(result.stdout);
  assert.equal(body.status, 'ok', body.error);
  assert.equal(body.permissions[0].decision, 'reject');
  assert.equal(body.permissions[0].reason, 'no-caller');
  assert.match(body.text, /PERM:reject-once/);
  assert.ok(Date.now() - started < 10_000, 'it did not wait out the 5-minute permission timeout');
});

test('two requests held at once both pause the turn timer and are answered by id', async () => {
  const paths = askSandbox('double');
  const requests = [];
  let closed = 0;
  const run = await runAsk(paths, {
    // Either hold alone is shorter than the deadline; together they are longer.
    // A timer that resumes after the first would cancel this turn.
    args: ['--timeout', '300'],
    onRequest: (child, message) => {
      requests.push(message);
      if (requests.length === 1) {
        setTimeout(() => {
          child.send({ type: 'permission-answer', requestId: message.requestId, decision: 'allow_once' });
        }, 100);
      }
    },
    onMessage: (child, message) => {
      if (message?.type !== 'permission-closed') return;
      closed += 1;
      if (closed === 1) {
        const second = requests[1];
        // Longer than what would be left of the 300 ms deadline after the
        // first answer: a timer resumed too early would cancel here.
        setTimeout(() => {
          child.send({ type: 'permission-answer', requestId: second.requestId, decision: 'reject' });
        }, 400);
      }
    },
  });
  assert.equal(run.code, 0, run.stderr);
  assert.equal(run.json.status, 'ok', run.json.error);
  assert.equal(run.requests.length, 2, 'both requests reached the caller');
  assert.deepEqual(run.json.permissions.map((entry) => entry.decision), ['allow', 'reject']);
  assert.match(run.json.text, /PERM:allow-once,reject-once/);
  // The agent's own title can be a command line; it is redacted on the way out.
  assert.equal(run.requests[0].title, 'Run npm test');
  assert.doesNotMatch(run.requests[1].title, /sk-/);
  assert.match(run.requests[1].title, /\[redacted\]/);
});

test('a budget cut still ends a run whose agent ignores the cancel', async () => {
  const paths = askSandbox();
  const started = Date.now();
  const run = await runAsk(paths, {
    args: ['--budget', '0.1'],
    prompt: 'COST:5 HANG-IGNORE',
    env: { HUB_CANCEL_WAIT_MS: '300' },
  });
  assert.equal(run.json.status, 'budget', run.json.error);
  assert.equal(run.json.cancelAck, false, 'the fixture never confirmed the cancel');
  assert.ok(Date.now() - started < 20_000, 'the run ended without anyone calling job_cancel');
});

test('a budget cut refuses a request that arrives during the cancel instead of holding it', async () => {
  const paths = askSandbox();
  const run = await runAsk(paths, { args: ['--budget', '0.1'], prompt: 'COST:5 do a lot of work' });
  assert.equal(run.requests.length, 0, 'no request was surfaced after the cut');
  assert.equal(run.json.status, 'budget', run.json.error);
  assert.equal(run.json.permissions[0].decision, 'reject');
  assert.equal(run.json.permissions[0].reason, 'stopped');
});
