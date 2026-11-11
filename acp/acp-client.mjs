// acp-client.mjs — minimal Agent Client Protocol v1 client over stdio.
//
// ACP is JSON-RPC 2.0 over stdio: one UTF-8 JSON object per line, no
// embedded newlines, agent logs on stderr only. The hub is the Client and
// each managed agent is a subprocess in the Agent role -- one independent
// session per agent, no multi-agent primitive in the protocol itself.
// Spec: https://agentclientprotocol.com/protocol/v1/overview
//
// Deliberately zero-dependency: the transport is small enough (spawn,
// line-split, dispatch by shape) that adding the SDK would hide the one
// part worth understanding. It also keeps this runnable from WSL and
// Windows with the same Node install the rest of repos/ already needs.
//
// Baseline client methods implemented: session/request_permission.
// Not implemented on purpose (capabilities are simply not advertised, and
// calls are answered with METHOD_NOT_FOUND): fs/read_text_file,
// fs/write_text_file, all terminal/* methods, elicitation/create. Agents
// keep using their own file/tool access; the hub does not proxy it yet.

import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';

// child.kill() signals one PID. On Windows the child is usually a wrapper --
// cmd.exe for an npx shim, wsl.exe for OpenCode -- whose own children survive
// the signal. fanout-acp.mjs already tree-kills for that reason; the
// single-agent path has to match it, or a cancelled run keeps editing.
function killTree(child) {
  if (!child || child.killed || child.pid == null) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    return;
  }
  try {
    child.kill('SIGTERM');
  } catch {}
}

export const ACP_PROTOCOL_VERSION = 1;
export const CLIENT_INFO = {
  name: 'agent-hub-acp',
  title: 'AI+PC Agent Hub',
  version: '0.1.0',
};

// JSON-RPC 2.0 standard codes.
export const RPC_ERRORS = {
  METHOD_NOT_FOUND: -32601,
  INTERNAL_ERROR: -32603,
};

export class AcpRpcError extends Error {
  constructor(method, error) {
    super(`${method}: ${error?.message ?? 'JSON-RPC error'} (code ${error?.code ?? '?'})`);
    this.name = 'AcpRpcError';
    this.method = method;
    this.code = error?.code;
    this.data = error?.data;
  }
}

export class AcpClient {
  #pending = new Map(); // id -> {resolve, reject, timer, method}
  #nextId = 1;
  #child = null;
  #rl = null;
  #closing = false;
  #exitInfo = null;
  #exitWaiters = [];
  #turn = null; // { ended: Promise } for the prompt in flight, for cancelAndWait

  constructor({
    command,
    args = [],
    env = {},
    cwd,
    agentLabel = command,
    onNotification = () => {},
    onPermission = async () => ({ outcome: { outcome: 'cancelled' } }),
    onStderr = () => {},
    requestTimeoutMs = 30_000,
  }) {
    if (!command) throw new Error('AcpClient: command is required');
    this.command = command;
    this.args = args;
    this.env = env;
    this.spawnCwd = cwd;
    this.agentLabel = agentLabel;
    this.onNotification = onNotification;
    this.onPermission = onPermission;
    this.onStderr = onStderr;
    this.requestTimeoutMs = requestTimeoutMs;
    this.stderrTail = [];
    this.protocolWarnings = [];
    this.agentCapabilities = {};
    this.agentInfo = null;
    this.authMethods = [];
    this.sessionInfo = null;
    this.configOptions = [];
  }

  start() {
    if (this.#child) return this;

    // Node cannot spawn .cmd/.bat wrappers directly on Windows (EINVAL
    // since the CVE-2024-27980 fix), and passing args with shell:true
    // triggers a deprecation warning. Run the wrapper through cmd.exe
    // instead. Registry args are static and trusted; refuse anything that
    // would need cmd quoting rather than hand-rolling it.
    if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(this.command)) {
      const line = [this.command, ...this.args];
      if (line.some((part) => /[\s"&|<>^%]/.test(part))) {
        throw new Error(
          `refusing to shell out to ${this.command}: registry args contain cmd metacharacters`,
        );
      }
      this.#child = spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', line.join(' ')], {
        cwd: this.spawnCwd,
        env: { ...process.env, ...this.env },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsVerbatimArguments: true,
        windowsHide: true,
      });
    } else {
      this.#child = spawn(this.command, this.args, {
        cwd: this.spawnCwd,
        env: { ...process.env, ...this.env },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    }

    this.#child.on('error', (err) => {
      this.#settleAll(err);
      this.#finish({ code: null, signal: null, error: err });
    });

    this.#child.on('exit', (code, signal) => {
      this.#finish({ code, signal, error: null });
    });

    this.#rl = createInterface({ input: this.#child.stdout, crlfDelay: Infinity });
    this.#rl.on('line', (line) => this.#handleLine(line));

    this.#child.stderr.on('data', (chunk) => {
      for (const line of chunk.toString('utf8').split('\n')) {
        if (!line.trim()) continue;
        if (this.stderrTail.length >= 40) this.stderrTail.shift();
        this.stderrTail.push(line);
        this.onStderr(line);
      }
    });

    this.#child.stdin.on('error', (err) => {
      // EPIPE after the agent exits is expected; anything else is worth
      // surfacing through the same tail as its stderr.
      if (err.code !== 'EPIPE') this.stderrTail.push(`stdin: ${err.message}`);
    });

    return this;
  }

  async initialize() {
    const result = await this.request(
      'initialize',
      {
        protocolVersion: ACP_PROTOCOL_VERSION,
        // Omitted capabilities mean unsupported (ACP initialization
        // rules). session/request_permission is baseline, not a capability.
        clientCapabilities: {},
        clientInfo: CLIENT_INFO,
      },
      { timeoutMs: 90_000 },
    );

    if (result.protocolVersion !== ACP_PROTOCOL_VERSION) {
      throw new Error(
        `agent chose ACP protocol version ${result.protocolVersion}; ` +
          `this hub implements v${ACP_PROTOCOL_VERSION} only ` +
          `(v2 is still a draft -- see the design doc's pinning decision)`,
      );
    }

    this.agentCapabilities = result.agentCapabilities ?? {};
    this.agentInfo = result.agentInfo ?? null;
    this.authMethods = result.authMethods ?? [];
    return result;
  }

  async authenticate(methodId) {
    return this.request('authenticate', { methodId }, { timeoutMs: 60_000 });
  }

  async newSession({ cwd, mcpServers = [], additionalDirectories = [], meta = null }) {
    const result = await this.request(
      'session/new',
      this.#sessionParams({ cwd, mcpServers, additionalDirectories, meta }),
      { timeoutMs: 120_000 },
    );
    if (!result?.sessionId) throw new Error('session/new returned no sessionId');
    this.sessionId = result.sessionId;
    this.sessionInfo = result;
    this.configOptions = result.configOptions ?? [];
    return result;
  }

  // Resume an existing session. `session/load` replays the conversation as
  // session/update notifications before responding; `session/resume` does
  // not replay. Both need the matching agent capability.
  async loadSession({ sessionId, cwd, mcpServers = [], additionalDirectories = [] }) {
    if (!sessionId) throw new Error('loadSession: sessionId is required');
    if (this.agentCapabilities.loadSession !== true) {
      throw new Error('agent does not advertise the loadSession capability');
    }
    return this.#openSession('session/load', sessionId, {
      cwd,
      mcpServers,
      additionalDirectories,
      timeoutMs: 300_000,
    });
  }

  async resumeSession({ sessionId, cwd, mcpServers = [], additionalDirectories = [] }) {
    if (!sessionId) throw new Error('resumeSession: sessionId is required');
    if (!this.agentCapabilities.sessionCapabilities?.resume) {
      throw new Error('agent does not advertise the sessionCapabilities.resume capability');
    }
    return this.#openSession('session/resume', sessionId, {
      cwd,
      mcpServers,
      additionalDirectories,
      timeoutMs: 120_000,
    });
  }

  async #openSession(method, sessionId, { cwd, mcpServers, additionalDirectories, timeoutMs }) {
    const result = await this.request(
      method,
      this.#sessionParams({ sessionId, cwd, mcpServers, additionalDirectories }),
      { timeoutMs },
    );
    this.sessionId = sessionId;
    this.sessionInfo = result;
    this.configOptions = result.configOptions ?? this.configOptions;
    return result;
  }

  #sessionParams({ sessionId, cwd, mcpServers, additionalDirectories, meta = null }) {
    const params = { cwd, mcpServers };
    if (meta) params._meta = meta; // agent-specific session options (e.g. claudeCode.options)
    if (sessionId) params.sessionId = sessionId;
    if (
      additionalDirectories.length &&
      this.agentCapabilities.sessionCapabilities?.additionalDirectories
    ) {
      params.additionalDirectories = additionalDirectories;
    }
    return params;
  }

  // Session config options (model, mode, thought level, ...). The response
  // is always the complete option list and current values.
  async setConfigOption(sessionId, configId, value, { type } = {}) {
    const params = { sessionId, configId, value };
    if (type) params.type = type;
    const result = await this.request('session/set_config_option', params, { timeoutMs: 30_000 });
    this.configOptions = result?.configOptions ?? this.configOptions;
    return result;
  }

  // Returns { stopReason }. Streamed output arrives via onNotification as
  // session/update messages; this call resolves when the turn ends.
  async prompt(sessionId, contentBlocks, { timeoutMs = 300_000 } = {}) {
    const prompt = Array.isArray(contentBlocks)
      ? contentBlocks
      : [{ type: 'text', text: String(contentBlocks ?? '') }];
    // Keep the request in the pending map after its timer fires, so a turn
    // that ends late -- the usual shape of "cancelled, but not immediately" --
    // is still observable. cancelAndWait() is what reads it.
    let end = () => {};
    this.#turn = { ended: new Promise((resolve) => { end = resolve; }) };
    const result = await this.request('session/prompt', { sessionId, prompt }, {
      timeoutMs,
      keepOnTimeout: true,
      onLate: () => end(true),
    });
    end(true);
    return result;
  }

  // Notification, not a request: no response is expected. Best-effort.
  cancel(sessionId = this.sessionId) {
    this.notify('session/cancel', { sessionId });
  }

  // Send session/cancel and wait, bounded, for the turn to actually end.
  //
  // ACP answers the cancel itself with nothing -- it is a notification -- so
  // the only evidence that the callee stopped is the prompt request settling
  // or the process exiting. `ack: false` therefore means "still going": the
  // caller must treat the working tree as live, not as abandoned.
  async cancelAndWait({ ms = 8000 } = {}) {
    const turn = this.#turn;
    this.cancel();
    if (!turn) return { ack: false, waitedMs: 0 };
    const started = Date.now();
    let timer;
    const timedOut = new Promise((resolve) => {
      timer = setTimeout(() => resolve(false), ms);
      timer.unref?.();
    });
    const stopped = await Promise.race([turn.ended.then(() => true), this.#waitForExit(), timedOut]);
    clearTimeout(timer);
    return { ack: stopped === true, waitedMs: Date.now() - started };
  }

  request(method, params, { timeoutMs = this.requestTimeoutMs, keepOnTimeout = false, onLate } = {}) {
    if (!this.#child || this.#child.killed) {
      return Promise.reject(new Error(`cannot call ${method}: agent is not running`));
    }
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const entry = { id, method, resolve, reject, timedOut: false, onLate, timer: null };
      entry.timer = setTimeout(() => {
        entry.timedOut = true;
        // Default: forget the request, as before. Keeping it costs nothing but
        // lets the caller see an answer that arrives too late to matter.
        if (!keepOnTimeout) this.#pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      entry.timer.unref?.();

      this.#pending.set(id, entry);
      this.#write({ jsonrpc: '2.0', id, method, params });
    });
  }

  notify(method, params) {
    if (!this.#child || this.#child.killed) return;
    this.#write({ jsonrpc: '2.0', method, params });
  }

  async close({ graceMs = 1500 } = {}) {
    if (!this.#child) return;
    this.#closing = true;
    const child = this.#child;
    this.#child.stdin.end();
    const exited = await Promise.race([
      this.#waitForExit(),
      new Promise((resolve) => setTimeout(() => resolve(false), graceMs)),
    ]);
    // Only now, and with a tree kill: a wrapper process exiting first is what
    // leaves an agent (or a whole build) running behind a "finished" run.
    if (!exited) killTree(child);
  }

  #write(message) {
    // ACP requires one JSON object per line with no embedded newlines.
    this.#child.stdin.write(JSON.stringify(message) + '\n');
  }

  #handleLine(line) {
    const text = line.trim();
    if (!text) return;

    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      // Agents MUST NOT write non-ACP text to stdout. Keep the line for
      // diagnostics instead of throwing it away silently.
      if (this.protocolWarnings.length < 20) {
        this.protocolWarnings.push(text.slice(0, 500));
      }
      return;
    }

    const hasId = Object.hasOwn(msg, 'id');
    const isResponse = hasId && (Object.hasOwn(msg, 'result') || Object.hasOwn(msg, 'error'));

    if (isResponse) {
      const pending = this.#pending.get(msg.id);
      if (!pending) return; // late/unknown response after a timeout
      this.#pending.delete(msg.id);
      clearTimeout(pending.timer);
      if (pending.timedOut) {
        // The caller was already told this request timed out. Use the late
        // answer only as evidence that the turn ended (cancelAndWait).
        pending.onLate?.(msg);
        return;
      }
      if (Object.hasOwn(msg, 'error')) {
        pending.reject(new AcpRpcError(pending.method, msg.error));
      } else {
        pending.resolve(msg.result);
      }
      return;
    }

    if (hasId && msg.method) {
      // Agent -> Client request (baseline: session/request_permission).
      void this.#handleAgentRequest(msg);
      return;
    }

    if (msg.method) this.onNotification(msg);
  }

  async #handleAgentRequest(msg) {
    try {
      let result;
      if (msg.method === 'session/request_permission') {
        result = await this.onPermission(msg.params);
      } else {
        // Capabilities for these were not advertised, so a compliant
        // agent will not call them. Be strict rather than silently
        // pretending to support them.
        throw Object.assign(new Error(`${msg.method} is not supported by this client`), {
          rpcCode: RPC_ERRORS.METHOD_NOT_FOUND,
        });
      }
      this.#write({ jsonrpc: '2.0', id: msg.id, result });
    } catch (err) {
      this.#write({
        jsonrpc: '2.0',
        id: msg.id,
        error: {
          code: err.rpcCode ?? RPC_ERRORS.INTERNAL_ERROR,
          message: err.message ?? String(err),
        },
      });
    }
  }

  #settleAll(err) {
    for (const [id, pending] of this.#pending) {
      clearTimeout(pending.timer);
      pending.reject(err);
      this.#pending.delete(id);
    }
  }

  #finish(info) {
    this.#exitInfo = info;
    this.#rl?.close();
    const suffix = this.stderrTail.length
      ? `\nagent stderr (tail):\n${this.stderrTail.join('\n')}`
      : '';
    this.#settleAll(
      new Error(
        `agent ${this.agentLabel} exited ` +
          `(code ${info.code ?? '?'}${info.signal ? `, signal ${info.signal}` : ''})` +
          (info.error ? `: ${info.error.message}` : '') +
          suffix,
      ),
    );
    for (const resolve of this.#exitWaiters) resolve(true);
    this.#exitWaiters.length = 0;
  }

  #waitForExit() {
    if (this.#exitInfo) return Promise.resolve(true);
    return new Promise((resolve) => this.#exitWaiters.push(resolve));
  }

  get exitInfo() {
    return this.#exitInfo;
  }
}

// --- Permission policies -------------------------------------------------
//
// The hub answers ACP's baseline session/request_permission request. The
// default is deny: an unattended orchestrator must not inherit a coding
// agent's "just say yes" habits. allow-reads is the escape hatch for
// review-style prompts; allow-all trusts the agent for the whole run and
// is never selected implicitly.

const READ_TOOL_KINDS = new Set(['read', 'search', 'fetch', 'think']);

function pickOption(options, kinds) {
  for (const kind of kinds) {
    const hit = options.find((o) => o.kind === kind);
    if (hit) return hit.optionId;
  }
  return null;
}

export function makePermissionHandler(policy = 'deny', log = () => {}) {
  return async function permissionHandler({ toolCall, options = [] } = {}) {
    const title = toolCall?.title ?? toolCall?.toolCallId ?? 'tool call';
    const kind = toolCall?.kind ?? 'other';
    let optionId = null;

    if (policy === 'allow-all') {
      optionId = pickOption(options, ['allow_once', 'allow_session', 'allow_always']);
    } else if (policy === 'allow-reads' && READ_TOOL_KINDS.has(kind)) {
      optionId = pickOption(options, ['allow_once', 'allow_session', 'allow_always']);
    }

    if (optionId) {
      log({ decision: 'allow', policy, kind, title, optionId });
      return { outcome: { outcome: 'selected', optionId } };
    }

    const reject = pickOption(options, ['reject_once', 'reject_always']);
    log({ decision: 'reject', policy, kind, title, optionId: reject });
    if (reject) return { outcome: { outcome: 'selected', optionId: reject } };
    return { outcome: { outcome: 'cancelled' } };
  };
}

// --- Path helpers --------------------------------------------------------
//
// ACP requires absolute cwd paths. When the hub runs on Windows but drives
// an agent inside WSL (OpenCode), the Windows cwd has to be translated.
// The implementation lives in paths.mjs so there is exactly one definition
// of how the two spellings map; this re-export keeps the older call sites
// (hub-acp, bridge) working without a flag day.

export { toWsl as windowsPathToWsl } from './paths.mjs';
