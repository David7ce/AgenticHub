#!/usr/bin/env node
// Minimal ACP agent for bridge tests: initialize, session/new, session/prompt.
// Streams three text chunks so the OpenAI delta translation can be asserted.
import { createInterface } from "node:readline";
import { appendFileSync } from "node:fs";

const LOG = process.env.FAKE_ACP_LOG;
const log = (event) => {
  if (LOG) appendFileSync(LOG, `${event}\n`);
};

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

rl.on("line", (line) => {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  const { id, method } = message;

  if (method === "initialize") {
    log("initialize");
    send({
      jsonrpc: "2.0",
      id,
      result: { protocolVersion: 1, agentCapabilities: {}, agentInfo: { name: "fake-acp" } },
    });
    return;
  }
  if (method === "session/new") {
    log("session");
    send({ jsonrpc: "2.0", id, result: { sessionId: "fake-session", configOptions: [] } });
    return;
  }
  if (method === "session/prompt") {
    log("prompt");
    for (const text of ["Hello", " from", " fake"]) {
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "fake-session",
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
        },
      });
    }
    send({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
    return;
  }
  if (method === "session/cancel") return;
  if (id != null) {
    send({ jsonrpc: "2.0", id, error: { code: -32601, message: `unsupported: ${method}` } });
  }
});
