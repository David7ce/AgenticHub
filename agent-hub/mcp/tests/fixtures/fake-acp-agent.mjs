#!/usr/bin/env node
// fake-acp-agent.mjs — the smallest ACP agent that can complete a turn.
//
// Test fixture only: it echoes the prompt back so the MCP end-to-end test can
// prove the whole chain (MCP -> hub-acp -> ACP -> answer) without a model
// call, a login, or a network round trip. Implements exactly the methods
// hub-acp.mjs uses: initialize, session/new, session/set_config_option,
// session/prompt, and the session/cancel notification.

import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';

const send = (message) => process.stdout.write(JSON.stringify(message) + '\n');

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

// A turn that is deliberately still open, so the cancel path can be tested:
// "HANG-ACK" ends the turn when session/cancel arrives (the well-behaved
// agent), "HANG-IGNORE" never does (the one that keeps working).
let pending = null;
let currentModel = 'unset';
let currentMode = 'build';
// FAKE_PERMISSION=execute|edit|double makes a turn ask the client for permission
// before it answers, the way a real agent does before running a command.
// 'double' sends two at once, which an agent may do; the client must keep both
// and wait for both. The client's answers are echoed as PERM:<option>[,<option>].
let pendingPermissions = new Map();
let permissionSeq = 0;
let permissionNote = '';
// How many times session/set_config_option has been asked to set 'model' in
// this process. Each hub-acp invocation (one model-chain attempt) spawns its
// own fresh copy of this fixture, so a correctly built --model flag sends
// exactly one of these; a flag passed twice by mistake sends two, which
// REPORT-MODEL-SETS below exposes to a test.
let modelSetCount = 0;

rl.on('line', (line) => {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }

  const { id, method, params } = message;
  if (method === undefined) {
    // A response to a permission request this fixture sent. Anything else
    // without a method is not ours to interpret.
    const waiter = pendingPermissions.get(message.id);
    if (waiter) {
      pendingPermissions.delete(message.id);
      waiter(message.result ?? null);
    }
    return;
  }
  const isNotification = id === undefined || id === null;

  switch (method) {
    case 'initialize':
      send({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: 1,
          // FAKE_ACP_CAPS=resume|load makes this agent able to continue a session.
          agentCapabilities:
            process.env.FAKE_ACP_CAPS === 'resume'
              ? { sessionCapabilities: { resume: {} } }
              : process.env.FAKE_ACP_CAPS === 'load'
                ? { loadSession: true }
                : {},
          agentInfo: { name: 'fake-agent', title: 'Fake ACP agent', version: '0.0.0' },
        },
      });
      break;

    case 'session/new':
      send({
        jsonrpc: '2.0',
        id,
        result: {
          sessionId: 'fake-session-1',
          // hub-acp records the model the agent says it is running.
          configOptions: [{ id: 'model', category: 'model', currentValue: 'unset' }],
        },
      });
      break;

    case 'session/resume':
    case 'session/load':
      if (process.env.FAKE_RESUME_MESSAGE) {
        send({ jsonrpc: '2.0', method: 'session/update', params: {
          sessionId: params.sessionId,
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'resume warning' } },
        } });
      }
      send({ jsonrpc: '2.0', id, result: process.env.FAKE_RESUME_MODE
        ? { configOptions: [{ id: 'mode', category: 'mode', currentValue: process.env.FAKE_RESUME_MODE }] }
        : {} });
      break;

    case 'session/set_config_option':
      if (params?.configId === 'model') modelSetCount += 1;
      if (params?.configId === 'model') currentModel = params?.value ?? currentModel;
      if (params?.configId === 'mode' && process.env.FAKE_MODE !== 'mismatch') currentMode = params.value;
      send({
        jsonrpc: '2.0',
        id,
        result: { configOptions: [
          { id: 'model', category: 'model', currentValue: currentModel },
          ...(process.env.FAKE_MODE && process.env.FAKE_MODE !== 'missing'
            ? [{ id: 'mode', category: 'mode', currentValue: currentMode }] : []),
        ] },
      });
      break;

    case 'session/prompt': {
      if (process.env.FAKE_PROMPT_MARKER) appendFileSync(process.env.FAKE_PROMPT_MARKER, 'prompt\n');
      if (process.env.FAKE_MODE?.startsWith('drift')) {
        send({ jsonrpc: '2.0', method: 'session/update', params: {
          sessionId: params.sessionId,
          update: { sessionUpdate: 'current_mode_update', currentModeId: 'build' },
        } });
        if (process.env.FAKE_MODE === 'drift-ignore') {
          pending = { id, ack: false };
          break;
        }
      }
      const text = (params?.prompt ?? [])
        .filter((block) => block?.type === 'text')
        .map((block) => block.text)
        .join('');
      // COST:<amount> simulates a turn that reports a cost: a usage_update
      // before the turn ends, exactly like a real agent reporting spend.
      // The turn still finishes normally -- hub-acp's own budget watcher is
      // what has to react to the number, not this fixture. Reported before
      // HANG so "COST:x HANG-IGNORE" can test a budget cut whose agent
      // ignores session/cancel.
      const reportedCost = /COST:(\d+(?:\.\d+)?)/.exec(text);
      // CTX:<used>[:<size>] reports a context window the way a real adapter
      // does, so hub-acp's own ceiling is what has to react to it.
      const reportedContext = /CTX:(\d+)(?::(\d+))?/.exec(text);
      if (reportedCost || reportedContext) {
        send({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: params?.sessionId,
            update: {
              sessionUpdate: 'usage_update',
              ...(reportedCost ? { cost: { amount: Number(reportedCost[1]) } } : {}),
              ...(reportedContext
                ? {
                  used: Number(reportedContext[1]),
                  ...(reportedContext[2] ? { size: Number(reportedContext[2]) } : {}),
                }
                : {}),
            },
          },
        });
      }
      if (text.includes('HANG')) {
        pending = { id, ack: !text.includes('HANG-IGNORE') };
        break;
      }
      // QUOTA:<substring> simulates an exhausted pool: any model whose id
      // contains the substring fails with a quota error, so the hub has to
      // treat it as "try the next model", not as a failed task.
      const quota = /QUOTA:(\S+)/.exec(text);
      if (quota && currentModel.includes(quota[1])) {
        send({
          jsonrpc: '2.0',
          id,
          error: {
            code: -32603,
            message: 'session/prompt: Internal error: Free usage limit reached.',
          },
        });
        break;
      }
      // MARK:<file> appends "start|end <pid> <ms>" so a test can check whether
      // two turns actually overlapped, without trusting wall-clock margins.
      const mark = /MARK:(\S+)/.exec(text);
      const stamp = (tag) => {
        if (mark) appendFileSync(mark[1], `${tag} ${process.pid} ${Date.now()}\n`);
      };
      stamp('start');
      // FAKE_TOOL_KEY=1 reports one tool call whose title carries a key shape,
      // built at runtime so no complete key literal lives in the repo. The
      // audit line, the in-flight file and --json tools[] all carry that title,
      // so every one of them has to redact it.
      if (process.env.FAKE_TOOL_KEY === '1') {
        send({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: params?.sessionId,
            update: {
              sessionUpdate: 'tool_call',
              toolCallId: 'tc-key-1',
              title: `Run curl with ${'s' + 'k-' + 'K'.repeat(24)}`,
              kind: 'execute',
              status: 'completed',
            },
          },
        });
      }
      // FAKE_SPLIT_TOKEN=1 streams the answer as two chunks with a key shape
      // straddling the boundary: neither chunk matches it at write time, so a
      // reader that redacts only per chunk would keep the second half.
      const chunk = (value) => send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: params?.sessionId,
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: value } },
        },
      });
      const echo = () => {
        const answer =
          `ECHO:${text} [model=${currentModel}]` +
          (text.includes('REPORT-MODEL-SETS') ? ` [modelSets=${modelSetCount}]` : '') +
          permissionNote;
        if (process.env.FAKE_SPLIT_TOKEN === '1') {
          // Built at runtime so no complete key literal lives in the repo.
          const key = 'sk-' + 'Q'.repeat(20) + 'R'.repeat(20);
          const at = Math.min(10, answer.length);
          chunk(answer.slice(0, at) + ' ' + key.slice(0, 23));
          chunk(key.slice(23) + answer.slice(at));
        } else {
          chunk(answer);
        }
        stamp('end');
        send({ jsonrpc: '2.0', id, result: { stopReason: 'end_turn' } });
      };
      // Ask the client before answering, as a real agent does for a command.
      const askPermission = ({ kind = 'execute', title = 'Run npm test' } = {}) => new Promise((resolve) => {
        const requestId = `perm-${++permissionSeq}`;
        pendingPermissions.set(requestId, resolve);
        send({
          jsonrpc: '2.0',
          id: requestId,
          method: 'session/request_permission',
          params: {
            sessionId: params?.sessionId,
            toolCall: {
              toolCallId: `tc-${requestId}`,
              title,
              kind,
              status: 'pending',
              locations: [],
            },
            options: [
              { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
              { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
            ],
          },
        });
      });
      const permissionMode = process.env.FAKE_PERMISSION;
      const picked = (answer) => answer?.outcome?.optionId ?? answer?.outcome?.outcome ?? 'cancelled';
      if (permissionMode === 'double') {
        // Two requests in flight at once: the client must hold both, keep the
        // turn clock paused until both are settled, and route each answer.
        Promise.all([
          askPermission({ kind: 'execute', title: 'Run npm test' }),
          // Built at runtime so no key-shaped literal lives in the repo.
          askPermission({ kind: 'fetch', title: `Fetch https://example.test with ${'sk-'}${'a'.repeat(24)}` }),
        ]).then((answers) => {
          permissionNote = ` PERM:${answers.map(picked).join(',')}`;
          echo();
        });
      } else if (permissionMode && !text.includes('NO-PERM')) {
        askPermission({ kind: permissionMode === 'edit' ? 'edit' : 'execute' }).then((answer) => {
          permissionNote = ` PERM:${picked(answer)}`;
          echo();
        });
      } else {
        const delay = /SLEEP:(\d+)/.exec(text);
        if (delay) setTimeout(echo, Number(delay[1]));
        else echo();
      }
      break;
    }

    case 'session/cancel':
      if (pending) {
        if (pending.ack) {
          send({ jsonrpc: '2.0', id: pending.id, result: { stopReason: 'cancelled' } });
        }
        pending = null;
      }
      if (!isNotification) send({ jsonrpc: '2.0', id, result: {} });
      break;

    default:
      send({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } });
  }
});
