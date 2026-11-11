/**
 * Bridge tests — no network, no model calls.
 *
 * A local mock upstream speaks both shapes the bridge supports, so these
 * exercise the translation and streaming logic without credentials.
 *
 *   node --test agent-hub/bridge/tests/bridge.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildAcpPrompt,
  checkReport,
  closeAgentPool,
  commandExists,
  consentAllows,
  createBridgeServer,
  loadConfig,
  resolveAgentEntry,
} from "../server.mjs";

const FAKE_ACP = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-acp-agent.mjs");
process.env.TEST_UPSTREAM_KEY = "test-key";

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

/** Mock upstream that records requests and answers in each supported shape. */
async function mockUpstream() {
  const captured = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      captured.push({ url: req.url, headers: req.headers, body: JSON.parse(raw || "{}") });
      if (req.url === "/chat/completions") {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write('data: {"choices":[{"index":0,"delta":{"content":"hel"}}]}\n\n');
        res.write('data: {"choices":[{"index":0,"delta":{"content":"lo"}}]}\n\n');
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }
      if (req.url === "/v1/messages") {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write('event: message_start\ndata: {"type":"message_start"}\n\n');
        res.write(
          'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hi"}}\n\n',
        );
        res.write(
          'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":" there"}}\n\n',
        );
        res.write('event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n');
        res.write('event: message_stop\ndata: {"type":"message_stop"}\n\n');
        res.end();
        return;
      }
      res.writeHead(404);
      res.end("not found");
    });
  });
  const port = await listen(server);
  return { server, port, captured };
}

function makeConfig(upstreamPort, overrides = {}) {
  return {
    host: "127.0.0.1",
    port: 0,
    authTokenEnv: null,
    systemPrompt: null,
    auditLog: null,
    providers: {
      mockOpenAI: {
        type: "openai",
        baseUrl: `http://127.0.0.1:${upstreamPort}`,
        apiKeyEnv: "TEST_UPSTREAM_KEY",
        anthropicVersion: "2023-06-01",
        headers: {},
      },
      mockAnthropic: {
        type: "anthropic",
        baseUrl: `http://127.0.0.1:${upstreamPort}`,
        apiKeyEnv: "TEST_UPSTREAM_KEY",
        anthropicVersion: "2023-06-01",
        headers: {},
      },
    },
    models: [
      { id: "m-openai", provider: "mockOpenAI", upstreamModel: "up-openai", systemPrompt: null, maxTokens: 100 },
      { id: "m-anthropic", provider: "mockAnthropic", upstreamModel: "up-anthropic", systemPrompt: null, maxTokens: 100 },
    ],
    ...overrides,
  };
}

async function startBridge(config) {
  const server = createBridgeServer(config);
  const port = await listen(server);
  return { server, port, base: `http://127.0.0.1:${port}` };
}

test("config validation rejects an unknown provider and duplicate model ids", () => {
  const dir = mkdtempSync(join(tmpdir(), "bridge-config-"));
  const path = join(dir, "config.json");

  writeFileSync(
    path,
    JSON.stringify({
      providers: { p: { baseUrl: "http://127.0.0.1:1", apiKeyEnv: "KEY" } },
      models: [{ id: "m", provider: "missing", upstreamModel: "x" }],
    }),
  );
  assert.throws(() => loadConfig(path), /unknown provider/);

  writeFileSync(
    path,
    JSON.stringify({
      providers: { p: { baseUrl: "http://127.0.0.1:1", apiKeyEnv: "KEY" } },
      models: [
        { id: "m", provider: "p", upstreamModel: "x" },
        { id: "m", provider: "p", upstreamModel: "y" },
      ],
    }),
  );
  assert.throws(() => loadConfig(path), /duplicate model id/);
});

test("GET /v1/models lists the configured ids", async () => {
  const upstream = await mockUpstream();
  const bridge = await startBridge(makeConfig(upstream.port));
  try {
    const response = await fetch(`${bridge.base}/v1/models`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(
      body.data.map((model) => model.id),
      ["m-openai", "m-anthropic"],
    );
  } finally {
    await close(bridge.server);
    await close(upstream.server);
  }
});

test("OpenAI upstream streams deltas and a final [DONE]", async () => {
  const upstream = await mockUpstream();
  const bridge = await startBridge(makeConfig(upstream.port));
  try {
    const response = await fetch(`${bridge.base}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "m-openai",
        stream: true,
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.match(text, /"content":"hel"/);
    assert.match(text, /"content":"lo"/);
    assert.match(text, /data: \[DONE\]/);
  } finally {
    await close(bridge.server);
    await close(upstream.server);
  }
});

test("Anthropic upstream is translated into OpenAI delta chunks", async () => {
  const upstream = await mockUpstream();
  const bridge = await startBridge(makeConfig(upstream.port));
  try {
    const response = await fetch(`${bridge.base}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "m-anthropic",
        stream: true,
        messages: [
          { role: "system", content: "be brief" },
          { role: "user", content: "hi" },
        ],
      }),
    });
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.match(text, /"content":"Hi"/);
    assert.match(text, /"content":" there"/);
    assert.match(text, /"finish_reason":"stop"/);
    assert.match(text, /data: \[DONE\]/);

    // The system message must become Anthropic's top-level `system` field,
    // and the upstream model id must replace the bridge-facing id.
    const sent = upstream.captured.at(-1).body;
    assert.equal(sent.system, "be brief");
    assert.equal(sent.model, "up-anthropic");
    assert.deepEqual(sent.messages, [{ role: "user", content: "hi" }]);
  } finally {
    await close(bridge.server);
    await close(upstream.server);
  }
});

test("a configured system prompt is prepended without dropping the caller's", async () => {
  const upstream = await mockUpstream();
  const bridge = await startBridge(makeConfig(upstream.port, { systemPrompt: "BRIDGE RULES" }));
  try {
    await fetch(`${bridge.base}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "m-openai",
        stream: true,
        messages: [
          { role: "system", content: "caller rules" },
          { role: "user", content: "hi" },
        ],
      }),
    }).then((response) => response.text());

    const messages = upstream.captured.at(-1).body.messages;
    assert.equal(messages[0].role, "system");
    assert.match(messages[0].content, /^BRIDGE RULES\n\ncaller rules$/);
  } finally {
    await close(bridge.server);
    await close(upstream.server);
  }
});

test("unknown model returns 404 and does not call upstream", async () => {
  const upstream = await mockUpstream();
  const bridge = await startBridge(makeConfig(upstream.port));
  try {
    const response = await fetch(`${bridge.base}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "nope", messages: [] }),
    });
    assert.equal(response.status, 404);
    assert.equal(upstream.captured.length, 0);
  } finally {
    await close(bridge.server);
    await close(upstream.server);
  }
});

test("bearer token is required when authTokenEnv names a set variable", async () => {
  process.env.TEST_BRIDGE_TOKEN = "secret";
  const upstream = await mockUpstream();
  const bridge = await startBridge(makeConfig(upstream.port, { authTokenEnv: "TEST_BRIDGE_TOKEN" }));
  try {
    const denied = await fetch(`${bridge.base}/v1/models`);
    assert.equal(denied.status, 401);

    const allowed = await fetch(`${bridge.base}/v1/models`, {
      headers: { Authorization: "Bearer secret" },
    });
    assert.equal(allowed.status, 200);
  } finally {
    delete process.env.TEST_BRIDGE_TOKEN;
    await close(bridge.server);
    await close(upstream.server);
  }
});

test("a missing provider credential fails closed with 503", async () => {
  const upstream = await mockUpstream();
  const config = makeConfig(upstream.port);
  config.providers.mockOpenAI.apiKeyEnv = "DEFINITELY_UNSET_KEY";
  delete process.env.DEFINITELY_UNSET_KEY;
  const bridge = await startBridge(config);
  try {
    const response = await fetch(`${bridge.base}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "m-openai", messages: [{ role: "user", content: "hi" }] }),
    });
    assert.equal(response.status, 503);
    assert.match((await response.json()).error.message, /DEFINITELY_UNSET_KEY/);
    assert.equal(upstream.captured.length, 0);
  } finally {
    await close(bridge.server);
    await close(upstream.server);
  }
});

test("one audit line is written per completed request", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bridge-audit-"));
  const auditLog = join(dir, "audit.jsonl");
  const upstream = await mockUpstream();
  const bridge = await startBridge(makeConfig(upstream.port, { auditLog }));
  try {
    await fetch(`${bridge.base}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "m-openai", stream: true, messages: [{ role: "user", content: "hi" }] }),
    }).then((response) => response.text());

    const lines = readFileSync(auditLog, "utf8").trim().split("\n").map(JSON.parse);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].model, "m-openai");
    assert.equal(lines[0].provider, "mockOpenAI");
    assert.equal(lines[0].status, "streamed");
    assert.equal(typeof lines[0].durationMs, "number");
  } finally {
    await close(bridge.server);
    await close(upstream.server);
  }
});

test("checkReport flags missing provider keys without printing them", () => {
  const config = makeConfig(1);
  delete process.env.TEST_UPSTREAM_KEY;

  const missing = checkReport(config);
  assert.equal(missing.ready, false);
  assert.match(missing.text, /TEST_UPSTREAM_KEY MISSING/);
  assert.match(missing.text, /not ready/);

  process.env.TEST_UPSTREAM_KEY = "test-key";
  const ready = checkReport(config);
  assert.equal(ready.ready, true);
  assert.match(ready.text, /ready: every configured credential and command is available/);
});

test("checkReport only claims tool calling for openai-shaped models", () => {
  process.env.TEST_UPSTREAM_KEY = "test-key";
  const report = checkReport(makeConfig(1));
  const json = report.text.slice(report.text.indexOf("["), report.text.lastIndexOf("]") + 1);
  const models = JSON.parse(json)[0].models;
  const byId = Object.fromEntries(models.map((model) => [model.id, model]));

  assert.equal(byId["m-openai"].toolCalling, true);
  assert.equal(byId["m-anthropic"].toolCalling, false);
});

test("buildAcpPrompt keeps roles and a configured system prompt", () => {
  const prompt = buildAcpPrompt(
    {
      messages: [
        { role: "user", content: "first" },
        { role: "assistant", content: [{ type: "text", text: "second" }] },
      ],
    },
    "BRIDGE RULES",
  );
  assert.match(prompt, /^System: BRIDGE RULES/);
  assert.match(prompt, /User: first/);
  assert.match(prompt, /Assistant: second/);
});

test("resolveAgentEntry applies platform overrides", () => {
  const registry = {
    agents: {
      a: {
        command: "default",
        args: ["x"],
        platforms: { testos: { command: "override", args: ["y"], pathStyle: "wsl" } },
      },
    },
  };
  const resolved = resolveAgentEntry(registry, "a", "testos");
  assert.equal(resolved.command, "override");
  assert.deepEqual(resolved.args, ["y"]);
  assert.equal(resolved.pathStyle, "wsl");
  assert.equal(resolveAgentEntry(registry, "a", "other").command, "default");
});

test("commandExists checks an absolute path directly, not via PATH search", () => {
  assert.equal(commandExists(process.execPath), true);
  assert.equal(commandExists(join(tmpdir(), "definitely-not-a-real-binary-xyz")), false);
});

test("commandExists still finds a bare, well-known command on PATH", () => {
  assert.equal(commandExists(process.platform === "win32" ? "cmd.exe" : "sh"), true);
});

test("loadConfig accepts an agents-only config", () => {
  const dir = mkdtempSync(join(tmpdir(), "bridge-agents-"));
  writeFileSync(
    join(dir, "agents.json"),
    JSON.stringify({ agents: { fake: { command: process.execPath, args: [FAKE_ACP] } } }),
  );
  writeFileSync(
    join(dir, "config.json"),
    JSON.stringify({
      agents: {
        registry: "agents.json",
        models: [{ id: "fake-agent", agent: "fake" }],
      },
    }),
  );

  const config = loadConfig(join(dir, "config.json"));
  assert.equal(config.models.length, 1);
  assert.equal(config.models[0].kind, "acp");
  assert.equal(config.models[0].agent, "fake");
  assert.ok(config.agentMode);
  assert.equal(config.agentMode.permission, "deny");
});

function acpConfig() {
  return {
    host: "127.0.0.1",
    port: 0,
    authTokenEnv: null,
    systemPrompt: null,
    auditLog: null,
    providers: {},
    models: [
      { kind: "acp", id: "fake-agent", agent: "fake", label: "Fake", systemPrompt: null },
    ],
    agentMode: {
      registryPath: "(test)",
      registry: { agents: { fake: { command: process.execPath, args: [FAKE_ACP] } } },
      cwd: process.cwd(),
      permission: "deny",
      timeoutMs: 20_000,
    },
  };
}

test("an ACP agent streams text as OpenAI delta chunks", async () => {
  const bridge = await startBridge(acpConfig());
  try {
    const response = await fetch(`${bridge.base}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "fake-agent",
        stream: true,
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.match(text, /"content":"Hello"/);
    assert.match(text, /"content":" from"/);
    assert.match(text, /"content":" fake"/);
    assert.match(text, /"finish_reason":"stop"/);
    assert.match(text, /data: \[DONE\]/);
  } finally {
    await closeAgentPool();
    await close(bridge.server);
  }
});

test("an ACP agent returns a non-streaming completion", async () => {
  const bridge = await startBridge(acpConfig());
  try {
    const response = await fetch(`${bridge.base}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "fake-agent",
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.choices[0].message.content, "Hello from fake");
    assert.equal(body.choices[0].finish_reason, "stop");
  } finally {
    await closeAgentPool();
    await close(bridge.server);
  }
});

test("agent mode reuses one process across requests", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bridge-reuse-"));
  const logPath = join(dir, "events.log");
  const config = acpConfig();
  config.agentMode.registry.agents.fake.env = { FAKE_ACP_LOG: logPath };
  const bridge = await startBridge(config);
  try {
    for (let i = 0; i < 2; i++) {
      const response = await fetch(`${bridge.base}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "fake-agent", messages: [{ role: "user", content: "hi" }] }),
      });
      assert.equal(response.status, 200);
      await response.json();
    }
    const events = readFileSync(logPath, "utf8").trim().split("\n");
    assert.equal(events.filter((event) => event === "initialize").length, 1);
    assert.equal(events.filter((event) => event === "session").length, 2);
  } finally {
    await closeAgentPool();
    await close(bridge.server);
  }
});

test("consentAllows mirrors the hub gate", () => {
  const mode = {
    consent: {
      good: { enabled: true, overseerAck: true, expires: "2999-01-01T00:00:00Z" },
      off: { enabled: false, overseerAck: true },
      unacked: { enabled: true, overseerAck: false },
      old: { enabled: true, overseerAck: true, expires: "2000-01-01T00:00:00Z" },
    },
  };
  assert.equal(consentAllows(mode, "good").ok, true);
  assert.match(consentAllows(mode, "off").reason, /disabled/);
  assert.match(consentAllows(mode, "unacked").reason, /acknowledged/);
  assert.match(consentAllows(mode, "old").reason, /expired/);
  assert.equal(consentAllows(mode, "missing").ok, false);
  assert.equal(consentAllows({ consent: null }, "anything").ok, true);
});

test("an ACP model without a consent entry returns 403", async () => {
  const config = acpConfig();
  config.agentMode.consent = { other: { enabled: true, overseerAck: true } };
  const bridge = await startBridge(config);
  try {
    const response = await fetch(`${bridge.base}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "fake-agent", messages: [{ role: "user", content: "hi" }] }),
    });
    assert.equal(response.status, 403);
    assert.match((await response.json()).error.message, /consent denied/);
  } finally {
    await close(bridge.server);
  }
});
