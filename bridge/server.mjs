#!/usr/bin/env node
/**
 * AgentHub bridge — a local, OpenAI-compatible endpoint for editor BYOK.
 *
 * VS Code's Copilot Chat can point at a custom `chat-completions` endpoint.
 * This server gives it one, on loopback only, and forwards each request to a
 * configured upstream provider using that provider's own API key from the
 * environment. It does not read, copy, or replay any subscription login token
 * (Claude Pro, Copilot, or otherwise): a provider is only usable here when it
 * exposes a normal API key, which keeps the bridge inside each provider's
 * terms.
 *
 * Responsibilities:
 *   - `GET  /v1/models`          list the models this bridge exposes
 *   - `POST /v1/chat/completions` translate, forward, and stream back
 *   - `GET  /health`             liveness, no upstream call
 *
 * Two upstream shapes are supported:
 *   - `openai`    OpenAI-compatible `/chat/completions` (OpenCode Zen, most
 *                 local servers, OpenAI itself)
 *   - `anthropic` Anthropic Messages API `/v1/messages`, translated to and
 *                 from OpenAI's streaming delta format
 *
 * Usage:
 *   node agent-hub/bridge/server.mjs [--config FILE] [--port N]
 *
 * Config: `config.json` beside this file, or `--config`. See README.md and
 * `config.example.json`. Zero dependencies; Node 18+ for global `fetch`.
 */
import { createServer } from "node:http";
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { AcpClient, makePermissionHandler, windowsPathToWsl } from "../acp/acp-client.mjs";
import { rotateIfNeeded } from "../acp/log-rotation.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const MAX_BODY_BYTES = 16 * 1024 * 1024;

// --- config ---------------------------------------------------------------

function fail(message) {
  throw new Error(message);
}

function assertString(value, what) {
  if (typeof value !== "string" || value.trim() === "") {
    fail(`${what} must be a non-empty string`);
  }
}

/**
 * Resolve one registry entry for this platform, without exiting the process
 * (hub-acp.mjs's resolver calls fail() and is CLI-only). Mirrors its rules:
 * platform override wins, `pathStyle: "wsl"` means the agent lives in WSL
 * even when the bridge runs on Windows.
 */
export function resolveAgentEntry(registry, name, platform = process.platform) {
  const entry = registry?.agents?.[name];
  if (!entry) {
    const known = Object.keys(registry?.agents ?? {});
    fail(`unknown agent ${JSON.stringify(name)}; known: ${known.join(", ") || "(none)"}`);
  }
  const override = entry.platforms?.[platform] ?? {};
  const command = override.command ?? entry.command;
  if (!command) fail(`agent ${name} has no command for ${platform}`);
  return {
    name,
    label: entry.label ?? name,
    command,
    args: override.args ?? entry.args ?? [],
    pathStyle: override.pathStyle ?? entry.pathStyle ?? "native",
    env: { ...(entry.env ?? {}), ...(override.env ?? {}) },
  };
}

export function commandExists(command) {
  // See acp/hub-acp.mjs's commandExists for why an absolute path is checked
  // directly instead of handed to `where`.
  if (isAbsolute(command)) return existsSync(command);
  if (process.platform === "win32") {
    return spawnSync("where", [command], { stdio: "ignore", windowsHide: true }).status === 0;
  }
  return spawnSync("sh", ["-c", 'command -v "$1"', "sh", command], { stdio: "ignore" }).status === 0;
}

/**
 * Load and validate a config file. Relative paths resolve against the config
 * file's own directory so the bridge behaves the same from any cwd.
 *
 * Two model kinds can coexist:
 *   - provider models: an upstream URL + an API key in an env var
 *   - agent models:    an ACP agent from the existing registry, which uses
 *                      whatever login that agent already has (no key here)
 */
export function loadConfig(configPath) {
  const file = resolve(configPath);
  if (!existsSync(file)) fail(`config not found: ${file}`);
  const raw = JSON.parse(readFileSync(file, "utf8"));
  const baseDir = dirname(file);

  if (raw.providers != null && (typeof raw.providers !== "object" || Array.isArray(raw.providers))) {
    fail("config.providers must be an object");
  }
  if (raw.models != null && !Array.isArray(raw.models)) fail("config.models must be an array");

  const providers = {};
  for (const [name, provider] of Object.entries(raw.providers ?? {})) {
    assertString(name, "provider name");
    if (!provider || typeof provider !== "object") fail(`provider ${name} must be an object`);
    const type = provider.type ?? "openai";
    if (type !== "openai" && type !== "anthropic") {
      fail(`provider ${name}: type must be "openai" or "anthropic"`);
    }
    assertString(provider.baseUrl, `provider ${name}.baseUrl`);
    assertString(provider.apiKeyEnv, `provider ${name}.apiKeyEnv`);
    providers[name] = {
      type,
      baseUrl: provider.baseUrl.replace(/\/+$/, ""),
      apiKeyEnv: provider.apiKeyEnv,
      anthropicVersion: provider.anthropicVersion ?? "2023-06-01",
      headers: provider.headers ?? {},
    };
  }

  const seen = new Set();
  const models = [];

  for (const model of raw.models ?? []) {
    if (!model || typeof model !== "object") fail("each model must be an object");
    assertString(model.id, "model.id");
    if (seen.has(model.id)) fail(`duplicate model id: ${model.id}`);
    seen.add(model.id);
    if (!providers[model.provider]) {
      fail(`model ${model.id} references unknown provider ${JSON.stringify(model.provider)}`);
    }
    assertString(model.upstreamModel, `model ${model.id}.upstreamModel`);
    if (model.systemPrompt != null) assertString(model.systemPrompt, `model ${model.id}.systemPrompt`);
    models.push({
      kind: "provider",
      id: model.id,
      provider: model.provider,
      upstreamModel: model.upstreamModel,
      systemPrompt: model.systemPrompt ?? null,
      maxTokens: model.maxTokens ?? 4096,
    });
  }

  let agentMode = null;
  if (raw.agents != null) {
    if (typeof raw.agents !== "object" || Array.isArray(raw.agents)) {
      fail("config.agents must be an object");
    }
    assertString(raw.agents.registry, "agents.registry");
    const registryPath = isAbsolute(raw.agents.registry)
      ? raw.agents.registry
      : resolve(baseDir, raw.agents.registry);
    if (!existsSync(registryPath)) fail(`agents.registry not found: ${registryPath}`);

    let registry;
    try {
      registry = JSON.parse(readFileSync(registryPath, "utf8"));
    } catch (error) {
      fail(`agents.registry is not valid JSON (${registryPath}): ${error.message}`);
    }
    if (!registry?.agents || typeof registry.agents !== "object") {
      fail(`agents.registry has no "agents" object: ${registryPath}`);
    }

    const permission = raw.agents.permission ?? "deny";
    if (!["deny", "allow-reads", "allow-all"].includes(permission)) {
      fail(`agents.permission must be deny, allow-reads or allow-all (got ${JSON.stringify(permission)})`);
    }
    const timeoutMs = Number(raw.agents.timeoutMs ?? 300_000);
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      fail(`agents.timeoutMs must be a positive number, got ${JSON.stringify(raw.agents.timeoutMs)}`);
    }
    const cwd = raw.agents.cwd ? resolve(baseDir, raw.agents.cwd) : baseDir;

    // Reuse the hub's consent gate: an agent the hub would refuse to run must
    // not be runnable through the bridge either. `consent: false` opts out
    // explicitly; omitting it looks for ../consent.json next to the config.
    let consent = null;
    let consentPath = null;
    if (raw.agents.consent !== false) {
      const candidate = raw.agents.consent
        ? (isAbsolute(raw.agents.consent) ? raw.agents.consent : resolve(baseDir, raw.agents.consent))
        : resolve(baseDir, "..", "consent.json");
      if (existsSync(candidate)) {
        try {
          consent = JSON.parse(readFileSync(candidate, "utf8"));
        } catch (error) {
          fail(`agents.consent is not valid JSON (${candidate}): ${error.message}`);
        }
        consentPath = candidate;
      }
    }

    agentMode = { registryPath, registry, cwd, permission, timeoutMs, consent, consentPath };

    for (const model of raw.agents.models ?? []) {
      if (!model || typeof model !== "object") fail("each agents.models entry must be an object");
      assertString(model.id, "agents.models[].id");
      assertString(model.agent, `agents.models[${model.id}].agent`);
      if (seen.has(model.id)) fail(`duplicate model id: ${model.id}`);
      seen.add(model.id);
      const resolved = resolveAgentEntry(registry, model.agent);
      if (model.systemPrompt != null) assertString(model.systemPrompt, `agents.models[${model.id}].systemPrompt`);
      models.push({
        kind: "acp",
        id: model.id,
        agent: model.agent,
        label: model.label ?? resolved.label,
        systemPrompt: model.systemPrompt ?? null,
        contextWindow: model.contextWindow ?? null,
        maxOutputTokens: model.maxOutputTokens ?? null,
      });
    }
  }

  if (models.length === 0) {
    fail("config exposes no models (add providers + models, or agents.models)");
  }

  const auditLog = raw.auditLog
    ? (isAbsolute(raw.auditLog) ? raw.auditLog : resolve(baseDir, raw.auditLog))
    : null;

  return {
    host: raw.host ?? "127.0.0.1",
    port: Number(raw.port ?? 3010),
    authTokenEnv: raw.authTokenEnv ?? null,
    // Literal token for a local, git-ignored config.json; wins over authTokenEnv.
    authToken: typeof raw.authToken === "string" && raw.authToken ? raw.authToken : null,
    systemPrompt: raw.systemPrompt ?? null,
    auditLog,
    providers,
    models,
    agentMode,
  };
}

function findModel(config, id) {
  return config.models.find((model) => model.id === id) ?? null;
}

// --- small HTTP helpers ---------------------------------------------------

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function sendError(res, status, message, type = "invalid_request_error", code = null) {
  sendJson(res, status, { error: { message, type, code } });
}

function readBody(req) {
  return new Promise((resolvePromise, rejectPromise) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        rejectPromise(Object.assign(new Error("request body too large"), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolvePromise(Buffer.concat(chunks).toString("utf8")));
    req.on("error", rejectPromise);
  });
}

function expectedToken(config) {
  return config.authToken ?? (config.authTokenEnv ? process.env[config.authTokenEnv] : undefined);
}

function authorized(req, config) {
  if (!config.authToken && !config.authTokenEnv) return true;
  const expected = expectedToken(config);
  if (!expected) return true; // env not set: fall back to loopback-only
  const header = req.headers.authorization ?? "";
  return header === `Bearer ${expected}`;
}

function audit(config, entry) {
  if (!config.auditLog) return;
  try {
    mkdirSync(dirname(config.auditLog), { recursive: true });
    rotateIfNeeded(config.auditLog);
    appendFileSync(config.auditLog, `${JSON.stringify(entry)}\n`);
  } catch {
    // Auditing must never take the request down with it.
  }
}

// --- message translation --------------------------------------------------

/** Flatten an OpenAI content value to plain text (text parts only). */
function contentToText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part && part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("");
}

/**
 * Add a system prompt to an OpenAI-shaped message list without discarding the
 * caller's own system message: the caller's text is kept and the configured
 * prompt is prepended.
 */
function withSystemPrompt(messages, prompt) {
  const list = Array.isArray(messages) ? messages : [];
  if (!prompt) return list;
  const firstSystem = list.find((message) => message.role === "system");
  if (firstSystem) {
    const existing = contentToText(firstSystem.content);
    return [
      { role: "system", content: existing ? `${prompt}\n\n${existing}` : prompt },
      ...list.filter((message) => message !== firstSystem),
    ];
  }
  return [{ role: "system", content: prompt }, ...list];
}

/** OpenAI chat request -> Anthropic Messages request. */
function toAnthropicRequest(payload, model, systemPrompt) {
  const systemParts = [];
  const messages = [];

  for (const message of withSystemPrompt(payload.messages, systemPrompt)) {
    const text = contentToText(message.content);
    if (message.role === "system") {
      if (text) systemParts.push(text);
      continue;
    }
    const role = message.role === "assistant" ? "assistant" : "user";
    // Anthropic requires alternating roles; merge neighbours.
    if (messages.length && messages[messages.length - 1].role === role) {
      messages[messages.length - 1].content += `\n\n${text}`;
    } else {
      messages.push({ role, content: text });
    }
  }

  if (messages.length === 0) messages.push({ role: "user", content: "" });

  const request = {
    model: model.upstreamModel,
    max_tokens: Number(payload.max_tokens ?? model.maxTokens),
    messages,
    stream: Boolean(payload.stream),
  };
  if (systemParts.length) request.system = systemParts.join("\n\n");
  if (typeof payload.temperature === "number") request.temperature = payload.temperature;
  if (typeof payload.top_p === "number") request.top_p = payload.top_p;
  if (typeof payload.stop === "string") request.stop_sequences = [payload.stop];
  else if (Array.isArray(payload.stop)) request.stop_sequences = payload.stop;
  return request;
}

function mapStopReason(reason) {
  if (reason === "max_tokens") return "length";
  if (reason === "tool_use") return "tool_calls";
  return "stop";
}

function chunk(id, created, model, delta, finishReason = null) {
  return `data: ${JSON.stringify({
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`;
}

/** Decode a stream chunk: Node yields Uint8Array, not Buffer, from fetch. */
function toText(part) {
  if (typeof part === "string") return part;
  return Buffer.from(part).toString("utf8");
}

/** Parse an SSE byte stream into `data:` payload strings. */
async function* sseData(stream) {
  let buffer = "";
  for await (const part of stream) {
    buffer += toText(part);
    let boundary = buffer.indexOf("\n\n");
    while (boundary !== -1) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      for (const line of block.split("\n")) {
        if (line.startsWith("data:")) yield line.slice(5).trim();
      }
      boundary = buffer.indexOf("\n\n");
    }
  }
  if (buffer.trim()) {
    for (const line of buffer.split("\n")) {
      if (line.startsWith("data:")) yield line.slice(5).trim();
    }
  }
}

// --- upstream calls -------------------------------------------------------

function upstreamAuth(provider) {
  const key = process.env[provider.apiKeyEnv];
  if (!key) {
    const error = new Error(
      `missing credential: set ${provider.apiKeyEnv} for this provider (no subscription login token is used)`,
    );
    error.status = 503;
    throw error;
  }
  return key;
}

async function callOpenAI(provider, model, payload, systemPrompt, signal) {
  const key = upstreamAuth(provider);
  const body = {
    ...payload,
    model: model.upstreamModel,
    messages: withSystemPrompt(payload.messages, systemPrompt),
  };
  const response = await fetch(`${provider.baseUrl}/chat/completions`, {
    method: "POST",
    signal,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
      ...provider.headers,
    },
    body: JSON.stringify(body),
  });
  return response;
}

async function callAnthropic(provider, model, payload, systemPrompt, signal) {
  const key = upstreamAuth(provider);
  const response = await fetch(`${provider.baseUrl}/v1/messages`, {
    method: "POST",
    signal,
    headers: {
      "Content-Type": "application/json",
      "x-api-key": key,
      "anthropic-version": provider.anthropicVersion,
      ...provider.headers,
    },
    body: JSON.stringify(toAnthropicRequest(payload, model, systemPrompt)),
  });
  return response;
}

async function upstreamError(res, upstream) {
  let detail = "";
  try {
    detail = await upstream.text();
  } catch {
    detail = "";
  }
  let message = detail || `upstream returned ${upstream.status}`;
  try {
    const parsed = JSON.parse(detail);
    message = parsed?.error?.message ?? parsed?.message ?? message;
  } catch {
    // keep the raw text
  }
  sendError(res, upstream.status, message, "upstream_error");
}

/** Pass an OpenAI-shaped stream through, guaranteeing a final [DONE]. */
async function pipeOpenAIStream(res, upstream, requestedModel) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  let tail = "";
  let sawDone = false;
  for await (const part of upstream.body) {
    const text = toText(part);
    tail = (tail + text).slice(-64);
    if (tail.includes("[DONE]")) sawDone = true;
    res.write(text);
  }
  if (!sawDone) {
    // Rewrite nothing; just close the stream in the format clients expect.
    res.write(chunk(`chatcmpl-bridge-${Date.now()}`, Math.floor(Date.now() / 1000), requestedModel, {}, "stop"));
    res.write("data: [DONE]\n\n");
  }
  res.end();
}

/** Translate an Anthropic event stream into OpenAI chat-completion chunks. */
async function pipeAnthropicStream(res, upstream, requestedModel) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  const id = `chatcmpl-bridge-${Date.now()}`;
  const created = Math.floor(Date.now() / 1000);
  let finishReason = null;

  for await (const data of sseData(upstream.body)) {
    if (data === "[DONE]") break;
    let event;
    try {
      event = JSON.parse(data);
    } catch {
      continue;
    }
    if (event.type === "content_block_delta" && event.delta?.type === "text_delta") {
      res.write(chunk(id, created, requestedModel, { content: event.delta.text }));
    } else if (event.type === "message_delta" && event.delta?.stop_reason) {
      finishReason = mapStopReason(event.delta.stop_reason);
    } else if (event.type === "error") {
      sendError(res, 502, event.error?.message ?? "upstream stream error", "upstream_error");
      return;
    }
  }

  res.write(chunk(id, created, requestedModel, {}, finishReason ?? "stop"));
  res.write("data: [DONE]\n\n");
  res.end();
}

function openAICompletion(anthropicBody, requestedModel) {
  const text = (anthropicBody.content ?? [])
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
  const usage = anthropicBody.usage ?? {};
  const promptTokens = usage.input_tokens ?? 0;
  const completionTokens = usage.output_tokens ?? 0;
  return {
    id: `chatcmpl-bridge-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: requestedModel,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: text },
        finish_reason: mapStopReason(anthropicBody.stop_reason),
      },
    ],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    },
  };
}

// --- request handler ------------------------------------------------------

/** Flatten an OpenAI message list into the text prompt an ACP agent expects. */
export function buildAcpPrompt(payload, systemPrompt) {
  const parts = [];
  if (systemPrompt) parts.push(`System: ${systemPrompt}`);
  for (const message of payload.messages ?? []) {
    const text = contentToText(message.content);
    if (!text) continue;
    const role =
      message.role === "assistant" ? "Assistant" : message.role === "system" ? "System" : "User";
    parts.push(`${role}: ${text}`);
  }
  return parts.join("\n\n");
}

/** Reuse the hub's consent gate for agent-backed models. */
export function consentAllows(agentMode, agent, now = Date.now()) {
  if (!agentMode?.consent) return { ok: true, reason: "no consent file configured" };
  const grant = agentMode.consent[agent];
  if (!grant) return { ok: false, reason: `no consent entry for ${agent}` };
  if (grant.enabled !== true) return { ok: false, reason: `${agent} is disabled` };
  if (grant.overseerAck !== true) return { ok: false, reason: `${agent} is not overseer-acknowledged` };
  if (grant.expires && Date.parse(grant.expires) <= now) {
    return { ok: false, reason: `${agent} consent expired at ${grant.expires}` };
  }
  return { ok: true, reason: "ok" };
}

// --- agent process pool ----------------------------------------------------
// Spawning and initializing an ACP agent costs seconds. Keep one initialized
// process per agent and open a fresh session for every request, so separate
// conversations never share context. Idle processes close themselves.

const AGENT_IDLE_MS = Number(process.env.AGENT_HUB_BRIDGE_IDLE_MS ?? 60_000);
const agentPool = new Map();

function agentKey(agent) {
  return `${agent.name}|${agent.command}|${agent.args.join("\u0000")}`;
}

function makeAgentClient(agent, config) {
  return new AcpClient({
    command: agent.command,
    args: agent.args,
    env: agent.env,
    cwd: config.agentMode.cwd,
    agentLabel: agent.label,
    requestTimeoutMs: 60_000,
    onStderr: () => {},
  });
}

/** Take an initialized client for this agent, spawning one if none is idle. */
export async function acquireAgent(agent, config, { fresh = false } = {}) {
  const key = agentKey(agent);
  let entry = agentPool.get(key);
  if (!entry) {
    entry = { idle: null, timer: null };
    agentPool.set(key, entry);
  }
  if (entry.timer) {
    clearTimeout(entry.timer);
    entry.timer = null;
  }

  if (entry.idle) {
    if (!fresh) {
      const client = entry.idle;
      entry.idle = null;
      return client;
    }
    await entry.idle.close().catch(() => {});
    entry.idle = null;
  }

  const client = makeAgentClient(agent, config);
  client.start();
  try {
    await client.initialize();
  } catch (error) {
    await client.close().catch(() => {});
    throw error;
  }
  return client;
}

/** Return a client to the pool, or close it when it is no longer usable. */
export function releaseAgent(agent, client, { broken = false } = {}) {
  const key = agentKey(agent);
  let entry = agentPool.get(key);
  if (!entry) {
    entry = { idle: null, timer: null };
    agentPool.set(key, entry);
  }
  if (broken || entry.idle) {
    client.close().catch(() => {});
    return;
  }
  entry.idle = client;
  entry.timer = setTimeout(() => {
    entry.idle = null;
    entry.timer = null;
    client.close().catch(() => {});
  }, AGENT_IDLE_MS);
  entry.timer.unref?.();
}

export async function closeAgentPool() {
  for (const entry of agentPool.values()) {
    if (entry.timer) clearTimeout(entry.timer);
    if (entry.idle) await entry.idle.close().catch(() => {});
  }
  agentPool.clear();
}

/**
 * Run one turn through an ACP agent that already has its own credentials.
 * Nothing here reads, copies or forwards a provider token: the agent uses the
 * login it was set up with, exactly as it would from a terminal.
 */
async function runAcpCompletion({ res, config, model, payload, systemPrompt, controller, entry }) {
  if (!config.agentMode) throw new Error("this model needs an agents section in the config");
  const agent = resolveAgentEntry(config.agentMode.registry, model.agent);

  const consent = consentAllows(config.agentMode, model.agent);
  if (!consent.ok) {
    const error = new Error(`consent denied: ${consent.reason}`);
    error.status = 403;
    throw error;
  }
  const sessionCwd =
    agent.pathStyle === "wsl" && process.platform === "win32"
      ? windowsPathToWsl(config.agentMode.cwd)
      : config.agentMode.cwd;

  const streaming = Boolean(payload.stream);
  const id = `chatcmpl-bridge-${Date.now()}`;
  const created = Math.floor(Date.now() / 1000);
  let text = "";
  let client = null;
  let checkedOut = false;
  // Token accounting: what the agent reports (PromptResponse.usage or a
  // usage_update), else a chars/4 estimate, flagged as such in the audit.
  let reported = null;

  // Handlers are per-request: a pooled client must never write the previous
  // request's response.
  const attach = (target) => {
    target.onNotification = (msg) => {
      if (res.writableEnded) return;
      if (msg.method !== "session/update") return;
      const update = msg.params?.update;
      if (update?.sessionUpdate === "usage_update" && Number.isFinite(update.used)) {
        reported = { ...(reported ?? {}), contextUsed: update.used, contextSize: update.size ?? null };
      }
      if (update?.sessionUpdate !== "agent_message_chunk") return;
      if (update.content?.type !== "text") return;
      const part = update.content.text ?? "";
      text += part;
      if (streaming) res.write(chunk(id, created, model.id, { content: part }));
    };
    target.onPermission = makePermissionHandler(config.agentMode.permission, (decision) => {
      entry.permissions = entry.permissions ?? [];
      entry.permissions.push(decision);
    });
  };

  try {
    client = await acquireAgent(agent, config);
    checkedOut = true;
    attach(client);

    try {
      await client.newSession({ cwd: sessionCwd });
    } catch {
      // A long-lived process may reject a new session. Stop it fully before
      // starting a clean one: two agent processes contending for the same
      // runtime is what produced the transient -32603 seen on 2026-10-30.
      await client.close().catch(() => {});
      checkedOut = false;
      entry.retried = true;
      client = await acquireAgent(agent, config, { fresh: true });
      checkedOut = true;
      attach(client);
      await client.newSession({ cwd: sessionCwd });
    }

    if (streaming) {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
    }

    controller.signal.addEventListener(
      "abort",
      () => {
        try {
          client?.cancel();
        } catch {
          // The process may already be gone.
        }
      },
      { once: true },
    );

    const result = await client.prompt(
      client.sessionId,
      [{ type: "text", text: buildAcpPrompt(payload, systemPrompt) }],
      { timeoutMs: config.agentMode.timeoutMs },
    );
    entry.stopReason = result?.stopReason ?? null;
    const u = result?.usage ?? result?._meta?.usage;
    if (u && (Number.isFinite(u.inputTokens) || Number.isFinite(u.outputTokens))) {
      reported = { ...(reported ?? {}), input: u.inputTokens ?? 0, output: u.outputTokens ?? 0 };
    }
    releaseAgent(agent, client, { broken: false });
    checkedOut = false;
  } catch (error) {
    if (checkedOut) releaseAgent(agent, client, { broken: true });
    throw error;
  }

  const promptChars = entry.promptChars ?? 0;
  const usage = reported?.input != null
    ? { prompt_tokens: reported.input, completion_tokens: reported.output, total_tokens: reported.input + reported.output }
    : { prompt_tokens: Math.ceil(promptChars / 4), completion_tokens: Math.ceil(text.length / 4), total_tokens: Math.ceil((promptChars + text.length) / 4) };
  entry.usage = { ...usage, source: reported?.input != null ? "agent" : "estimate", contextUsed: reported?.contextUsed ?? null, contextSize: reported?.contextSize ?? null };

  if (streaming) {
    res.write(chunk(id, created, model.id, {}, "stop"));
    if (payload.stream_options?.include_usage) {
      res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model: model.id, choices: [], usage })}

`);
    }
    res.write("data: [DONE]\n\n");
    res.end();
    return;
  }

  sendJson(res, 200, {
    id,
    object: "chat.completion",
    created,
    model: model.id,
    choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
    usage,
  });
}

async function handleCompletions(req, res, config) {
  const started = Date.now();
  let payload;
  try {
    payload = JSON.parse(await readBody(req));
  } catch (error) {
    sendError(res, error.status ?? 400, error.status ? error.message : "invalid JSON body");
    return;
  }

  const model = findModel(config, payload.model);
  if (!model) {
    sendError(res, 404, `unknown model ${JSON.stringify(payload.model)}; see GET /v1/models`, "model_not_found");
    return;
  }

  const systemPrompt = model.systemPrompt ?? config.systemPrompt;
  const controller = new AbortController();
  // Abort the upstream only if the client goes away before we finish.
  res.on("close", () => {
    if (!res.writableEnded) controller.abort();
  });

  const entry = {
    ts: new Date().toISOString(),
    model: model.id,
    provider: model.kind === "acp" ? `acp:${model.agent}` : model.provider,
    upstreamModel: model.kind === "acp" ? model.agent : model.upstreamModel,
    stream: Boolean(payload.stream),
    promptChars: JSON.stringify(payload.messages ?? []).length,
  };

  try {
    if (model.kind === "acp") {
      await runAcpCompletion({ res, config, model, payload, systemPrompt, controller, entry });
      entry.status = payload.stream ? "streamed" : "ok";
    } else {
      const provider = config.providers[model.provider];
      const kind = provider.type === "anthropic" ? "anthropic" : "openai";
      const upstream =
        kind === "anthropic"
          ? await callAnthropic(provider, model, payload, systemPrompt, controller.signal)
          : await callOpenAI(provider, model, payload, systemPrompt, controller.signal);
      entry.upstreamStatus = upstream.status;

      if (!upstream.ok) {
        await upstreamError(res, upstream);
        entry.status = "upstream_error";
        return;
      }

      if (payload.stream) {
        if (kind === "anthropic") await pipeAnthropicStream(res, upstream, model.id);
        else await pipeOpenAIStream(res, upstream, model.id);
        entry.status = "streamed";
      } else if (kind === "anthropic") {
        sendJson(res, 200, openAICompletion(await upstream.json(), model.id));
        entry.status = "ok";
      } else {
        sendJson(res, 200, await upstream.json());
        entry.status = "ok";
      }
    }
  } catch (error) {
    if (process.env.AGENT_HUB_BRIDGE_DEBUG) console.error(error);
    if (controller.signal.aborted) {
      entry.status = "client_closed";
      return;
    }
    if (!res.headersSent) {
      sendError(res, error.status ?? 502, error.message ?? "bridge error", "bridge_error");
    } else {
      res.end();
    }
    entry.status = "error";
    entry.error = error.message;
  } finally {
    entry.durationMs = Date.now() - started;
    audit(config, entry);
  }
}

/**
 * Readiness report for `--check`: validates the config, says which provider
 * keys are present (never their values), and prints the exact VS Code
 * `chatLanguageModels.json` entry for this bridge.
 */
export function checkReport(config) {
  const lines = [`config ok: ${config.models.length} model(s)`];
  let ready = true;

  const providerNames = Object.keys(config.providers);
  if (providerNames.length === 0) {
    lines.push("  providers: none (agent mode only)");
  }
  for (const [name, provider] of Object.entries(config.providers)) {
    const present = Boolean(process.env[provider.apiKeyEnv]);
    if (!present) ready = false;
    lines.push(
      `  provider ${name}: ${provider.type} ${provider.baseUrl} — ${provider.apiKeyEnv} ` +
        (present ? "set" : "MISSING"),
    );
  }

  if (config.agentMode) {
    lines.push(
      `  agents: ${config.agentMode.registryPath} (permission ${config.agentMode.permission})`,
    );
    const seenAgents = new Set();
    for (const model of config.models.filter((m) => m.kind === "acp")) {
      if (seenAgents.has(model.agent)) continue;
      seenAgents.add(model.agent);
      try {
        const agent = resolveAgentEntry(config.agentMode.registry, model.agent);
        const present = commandExists(agent.command);
        if (!present) ready = false;
        const consent = consentAllows(config.agentMode, model.agent);
        if (!consent.ok) ready = false;
        lines.push(
          `  agent ${model.agent}: ${agent.command} ${present ? "found" : "MISSING"}; ` +
            `consent ${consent.ok ? "ok" : `denied (${consent.reason})`}`,
        );
      } catch (error) {
        ready = false;
        lines.push(`  agent ${model.agent}: ${error.message}`);
      }
    }
  }

  if (config.authToken) {
    lines.push("  auth: bearer token from config.authToken");
  } else if (config.authTokenEnv) {
    const set = Boolean(process.env[config.authTokenEnv]);
    lines.push(
      `  auth: bearer token from ${config.authTokenEnv}` +
        (set ? "" : " (unset: loopback stays open)"),
    );
  } else {
    lines.push("  auth: none (loopback only)");
  }

  const entry = [
    {
      name: "AgentHub",
      vendor: "customendpoint",
      apiKey: "${input:agentHubBridgeToken}", // pragma: allowlist secret
      apiType: "chat-completions",
      models: config.models.map((model) => ({
        id: model.id,
        name: model.label ?? model.id,
        url: `http://${config.host}:${config.port}/v1/chat/completions`,
        // Only the `openai` provider path translates tools. Agent mode is
        // text chat: the agent's own tools stay inside the agent.
        toolCalling:
          (model.kind ?? "provider") === "provider" &&
          config.providers[model.provider]?.type === "openai",
        // Full window (input + output); VS Code derives the input budget.
        ...(model.contextWindow
          ? { contextWindow: model.contextWindow }
          : { maxInputTokens: 128000 }),
        maxOutputTokens: model.maxOutputTokens ?? 8192,
      })),
    },
  ];

  lines.push("", "VS Code `chatLanguageModels.json` entry:", JSON.stringify(entry, null, 2), "");
  lines.push(
    ready
      ? "ready: every configured credential and command is available"
      : "not ready: fix the MISSING entries above",
  );
  return { text: lines.join("\n"), ready };
}

export function createBridgeServer(config) {
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    if (req.method === "GET" && url.pathname === "/health") {
      sendJson(res, 200, { ok: true, models: config.models.length });
      return;
    }

    if (!authorized(req, config)) {
      sendError(res, 401, "missing or invalid bearer token", "authentication_error");
      return;
    }

    if (req.method === "GET" && url.pathname === "/v1/models") {
      sendJson(res, 200, {
        object: "list",
        data: config.models.map((model) => ({
          id: model.id,
          object: "model",
          owned_by: model.provider,
        })),
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
      await handleCompletions(req, res, config);
      return;
    }

    sendError(res, 404, `no route for ${req.method} ${url.pathname}`, "not_found");
  });
}

// --- CLI ------------------------------------------------------------------

function argValue(argv, name) {
  const index = argv.indexOf(name);
  return index === -1 ? null : argv[index + 1] ?? null;
}

async function main() {
  const argv = process.argv.slice(2);
  const configPath = argValue(argv, "--config") ?? process.env.AGENT_HUB_BRIDGE_CONFIG ?? join(HERE, "config.json");
  const config = loadConfig(configPath);
  const port = Number(argValue(argv, "--port") ?? config.port);

  if (argv.includes("--check")) {
    const report = checkReport({ ...config, port });
    process.stdout.write(`${report.text}\n`);
    process.exitCode = report.ready ? 0 : 1;
    return;
  }

  const server = createBridgeServer(config);
  server.listen(port, config.host, () => {
    const auth = config.authToken ? "bearer token from config" : config.authTokenEnv ? `bearer token from ${config.authTokenEnv}` : "no bearer token (loopback only)";
    console.log(`agent-hub bridge on http://${config.host}:${port} — ${config.models.length} model(s), ${auth}`);
    if (!config.authToken && !config.authTokenEnv) {
      console.warn("warning: no authToken/authTokenEnv configured; any local process can call this bridge.");
    }
    for (const model of config.models) {
      if (model.kind !== "provider") continue;
      const provider = config.providers[model.provider];
      if (!process.env[provider.apiKeyEnv]) {
        console.warn(`warning: ${provider.apiKeyEnv} is not set; model ${model.id} will fail until it is.`);
      }
    }
    if (config.agentMode) {
      console.log(
        `agent mode: ${config.models.filter((m) => m.kind === "acp").length} model(s) via ` +
          `${config.agentMode.registryPath} (permission ${config.agentMode.permission})`,
      );
    }
  });

  const stop = () => {
    void closeAgentPool().finally(() => server.close(() => process.exit(0)));
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(`bridge: ${error.message}`);
    process.exit(1);
  });
}
