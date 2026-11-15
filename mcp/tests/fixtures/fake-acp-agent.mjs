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
  if (method === undefined) return; // not a request
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
      send({ jsonrpc: '2.0', id, result: {} });
      break;

    case 'session/set_config_option':
      if (params?.configId === 'model') modelSetCount += 1;
      currentModel = params?.value ?? currentModel;
      send({
        jsonrpc: '2.0',
        id,
        result: { configOptions: [{ id: 'model', category: 'model', currentValue: currentModel }] },
      });
      break;

    case 'session/prompt': {
      const text = (params?.prompt ?? [])
        .filter((block) => block?.type === 'text')
        .map((block) => block.text)
        .join('');
      if (text.includes('HANG')) {
        pending = { id, ack: !text.includes('HANG-IGNORE') };
        break;
      }
      // COST:<amount> simulates a turn that reports a cost: a usage_update
      // before the turn ends, exactly like a real agent reporting spend.
      // The turn still finishes normally -- hub-acp's own budget watcher is
      // what has to react to the number, not this fixture.
      const reportedCost = /COST:(\d+(?:\.\d+)?)/.exec(text);
      if (reportedCost) {
        send({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: params?.sessionId,
            update: { sessionUpdate: 'usage_update', cost: { amount: Number(reportedCost[1]) } },
          },
        });
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
      const echo = () => {
        send({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: params?.sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: {
                type: 'text',
                text:
                  `ECHO:${text} [model=${currentModel}]` +
                  (text.includes('REPORT-MODEL-SETS') ? ` [modelSets=${modelSetCount}]` : ''),
              },
            },
          },
        });
        stamp('end');
        send({ jsonrpc: '2.0', id, result: { stopReason: 'end_turn' } });
      };
      const delay = /SLEEP:(\d+)/.exec(text);
      if (delay) setTimeout(echo, Number(delay[1]));
      else echo();
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
