// core.mjs — the MCP surface of the hub, with no I/O of its own.
//
// Every decision lives here so it can be tested without spawning anything;
// server.mjs owns the stdio loop and the child processes. The tools are
// deliberately thin wrappers over hub-acp.mjs / fanout-acp.mjs so that
// consent.json, logs/runs.jsonl, budgets, permissions and worktrees keep
// working exactly as they do from the command line.

import { configuredRegistryPath } from '../acp/config.mjs';
import { normalizeTree } from '../acp/consent.mjs';
import { MAX_PROMPT_CHARS } from '../acp/hub-env.mjs';
import { agentChain, isQuotaError, readAgentEntry } from '../acp/router.mjs';
import { buildHandoffPrompt } from '../acp/handoff.mjs';

import { TOOLS } from './tools.mjs';
import {
  ToolError, optionalEffort, optionalPermission, optionalPositiveInt, optionalPositiveNumber,
  optionalString, requireString,
} from './validate.mjs';
import { validLabel } from './sessions.mjs';
import {
  renderAgents, renderAsk, renderFanout, renderJobResult, renderJobStatus, renderRoute, renderSessionLog, renderSessions,
} from './render.mjs';

// Kept importable from here: tests and server.mjs use these names.
export { TOOLS } from './tools.mjs';
export {
  renderAgents, renderAsk, renderFanout, renderJobResult, renderJobStatus, renderRoute, renderSessionLog, renderSessions,
} from './render.mjs';

export const PROTOCOL_VERSION = '2025-06-18';
const SEARCH_SOURCES = ['runs', 'notes', 'git'];

function isRealDate(text) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const date = new Date(`${text}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === text;
}

export const SERVER_INFO = { name: 'agent-hub', version: '1.0.0' };

// What the client's model reads when it connects. The person talks to that
// model and does not run hub commands, so this is the manual: which tool a
// plain request maps to. Short on purpose; the details are in each tool.
export const INSTRUCTIONS = [
  'agent-hub lets you call the other coding agents on this machine (claude, codex, opencode). Every call is ' +
    'checked against the owner\'s consent grant and logged. The person talks to you and does not run commands: ' +
    'you choose the tool.',
  '',
  '- Start of a session, or "where are we", "the roadmap", "what is next": call `brief`. The roadmap itself is ' +
    'workspaces-panel/working/ROADMAP.md in the workspace folder; read it yourself.',
  '- "Ask", "consult", "get a second opinion from" Claude or Codex: `ask_agent`. The callee sees nothing of this ' +
    'conversation, so the prompt must carry the task, the paths that matter and what you want back.',
  '- The same question to several agents (for example Claude and Codex on a plan): `fanout`, with `synthesize` ' +
    'to merge their answers.',
  '- Unsure who should take a task: `route`; add `run: true` to execute the choice.',
  '- A follow-up or a correction to an agent\'s answer: `ask_agent` again with the `sessionId` that answer reported.',
  '- Give every Claude/Codex conversation a short `label` and reuse it for follow-ups; `sessions` lists them; ' +
    '`session_log` reads what one did; `session_close` ends one; `session_config` sets its model or effort.',
  '- To hand one agent\'s result to another, pass `from: {label: "<session>"}` (turns 1-3) to `ask_agent`; ' +
    'the prompt carries that session\'s last turn(s) and the transcript path.',
  '- Anything longer than a couple of minutes: `background: true`, then `job_status` and `job_result`; `job_cancel` stops it.',
  '- `permission: "ask"` (background only) holds a permission request for the person, but the adapter ' +
    'decides whether one arrives: the pinned Claude and OpenCode adapters send none today, so treat it ' +
    'as write-capable, not supervised. When `job_status` does show a held request, ask the person, then ' +
    'call `permission_answer`.',
  '- "What did we do about X", "when did that run": `search` (the audit log, the working notes, git history).',
  '- Restricted policies deny and allow-reads currently fail closed before agent startup; ACP agents may execute tools without requesting permission. ' +
    'Only explicit `permission: "allow-all"` runs within the existing grant can start, and they are write-capable, not read-only.',
  '- A refusal that mentions consent, a cap or a tree is the owner\'s decision. Report it; do not work around it.',
  '- `agents` lists who is available and granted; `status` shows health and running jobs.',
].join('\n');

// ── dispatch ────────────────────────────────────────────────────────────────

// Resolves a labelled request against its stored session (mutating request) and
// returns text when the turn was queued behind a running one.
async function applySession(request, args, handlers) {
  const label = args.label;
  if (!validLabel(label)) {
    throw new ToolError('"label" must be 1-48 chars: lowercase letters, digits, hyphens, starting with a letter or digit');
  }
  if (request.sessionId) throw new ToolError('pass either "label" or "sessionId", not both');
  request.label = label;
  request.worktree = args.worktree === true;
  const session = await handlers.session?.(label);
  if (!session) return null;
  const belongs = () => new ToolError(`label ${label} belongs to ${session.agent} in ${session.cwd}`);
  if (session.agent !== request.agent) throw belongs();
  // The session's own tree and its worktree are both legitimate; the error
  // still names the original tree, which is the session's identity. Tree
  // identity is compared in the same canonical form the tree lock uses: on
  // Windows `d:\x` and `D:\x` are one tree, and a follow-up spelled that way
  // must not be refused as another session's.
  const trees = [session.cwd, session.worktree?.path].filter(Boolean).map((tree) => normalizeTree(tree));
  if (request.cwd && !trees.includes(normalizeTree(request.cwd))) throw belongs();
  if (session.state === 'closed') throw new ToolError(`label ${label} is closed; pick another label`);
  request.cwd = session.cwd;
  request.sessionId = session.acpSessionId ?? undefined;
  request.model ??= session.model ?? undefined;
  request.effort ??= session.effort ?? undefined;
  // A `running` record whose job is gone is stale, not busy: queueing behind it
  // would leave the prompt waiting for a drain that never comes. The turn runs
  // instead and its beginTurn takes the record over.
  const active = session.state === 'running' || session.state === 'waiting-permission';
  if (active && session.live !== false) {
    const waiting = await handlers.sessionQueue?.(label, request);
    if (waiting) return `${label}: queued (${waiting} waiting) — it starts when the running turn finishes`;
  }
  return null;
}

// ── handoff by reference ────────────────────────────────────────────────────
//
// `from` carries another session's result inside this prompt. The text shares
// hub-acp's 4000-character prompt budget, so it is cut from its oldest end:
// the newest text is what the next agent needs, and the path points at the
// whole transcript when it needs more.

function parseHandoff(from) {
  if (!from || typeof from !== 'object' || Array.isArray(from)) {
    throw new ToolError('"from" must be an object with a non-empty "label"');
  }
  const unknown = Object.keys(from).filter((key) => key !== 'label' && key !== 'turns');
  if (unknown.length) throw new ToolError(`"from" does not accept ${unknown.join(', ')}`);
  const label = requireString(from, 'label', { max: 64 });
  const turns = from.turns === undefined ? 1 : from.turns;
  if (!Number.isInteger(turns) || turns < 1 || turns > 3) {
    throw new ToolError('"from.turns" must be an integer from 1 to 3');
  }
  return { label, turns };
}

function composeHandoff({ prompt, label, agent, text, path, turns }) {
  const head = `${prompt}\n\n--- from session ${label} (${agent}), last ${turns} turn(s) ---\n`;
  const tail = `\n--- full transcript: ${path} ---`;
  const fixed = head.length + tail.length;
  if (fixed > MAX_PROMPT_CHARS || (fixed === MAX_PROMPT_CHARS && text.length > 0)) {
    throw new ToolError(
      `prompt is too long for a handoff: ${fixed} characters of prompt, headings and transcript path ` +
      `(limit ${MAX_PROMPT_CHARS})`,
    );
  }
  const room = MAX_PROMPT_CHARS - fixed;
  let body = text;
  if (text.length > room) {
    // Cut from the oldest side. A cut between the halves of a surrogate pair
    // would leave a lone low surrogate, which is not valid text; step past it.
    // Never step backwards: that would exceed the prompt budget.
    let start = text.length - (room - 1);
    const first = text.charCodeAt(start);
    if (first >= 0xdc00 && first <= 0xdfff) start += 1;
    body = `…${text.slice(start)}`;
  }
  return head + body + tail;
}

// handlers: { ask, fanout, route, agents } — each async, already I/O-bound.
export async function callTool(name, args, handlers, ctx = {}) {
  switch (name) {
    case 'ask_agent': {
      const agent = requireString(args, 'agent', { max: 64 });
      const prompt = requireString(args, 'prompt');
      const request = {
        agent,
        prompt,
        model: optionalString(args, 'model'),
        mode: args.mode === undefined ? undefined : requireString(args, 'mode', { max: 128 }),
        cwd: optionalString(args, 'cwd'),
        permission: optionalPermission(args),
        timeoutMs: optionalPositiveInt(args, 'timeoutMs'),
        budgetUsd: optionalPositiveNumber(args, 'budgetUsd'),
        effort: optionalEffort(args),
        sessionId: optionalString(args, 'sessionId'),
        // Carried for every call, not only a labelled one: an unlabelled
        // `worktree: true` is a request for a fresh checkout for this turn.
        worktree: args.worktree === true,
      };
      if (args.worktree !== undefined && typeof args.worktree !== 'boolean') throw new ToolError('"worktree" must be a boolean');
      // ask holds the turn until the person answers. A foreground call blocks
      // the chat that would have to relay that question, so it can never work.
      if (request.permission === 'ask' && args.background !== true) {
        throw new ToolError('permission "ask" needs background: true');
      }
      // Expanded before the label queue sees it: a queued turn must carry the
      // already-composed prompt, not one that depends on this call's state.
      if (args.from !== undefined) {
        const from = parseHandoff(args.from);
        const source = await handlers.handoffSource(from.label, from.turns);
        if (!source) return { text: `no session labelled ${from.label}`, isError: true };
        if (source.noTranscript) {
          return { text: `session ${from.label} has no transcript yet`, isError: true };
        }
        // A running turn has its prompt record but no text yet (the turn's text
        // is written when it stops), and a finished turn can be text-empty. An
        // empty body would ask the target agent to work with nothing.
        const sourceText = String(source.text ?? '');
        if (!sourceText.trim()) {
          return { text: `session ${from.label} has no finished turn to hand over yet`, isError: true };
        }
        request.prompt = composeHandoff({
          prompt,
          label: from.label,
          agent: source.agent,
          text: sourceText,
          path: source.path,
          // What the handler really carried, not what was asked for.
          turns: source.turns ?? from.turns,
        });
      }
      if (args.label !== undefined) {
        const queued = await applySession(request, args, handlers);
        if (queued) return { text: queued, isError: false };
      }
      if (args.background === true) {
        const job = await handlers.startJob(request);
        if (job?.error) return { text: `cannot start job: ${job.error}`, isError: true };
        return {
          text:
            `job ${job.id} started · ${agent}` +
            (job.cwd ? ` in ${job.cwd}` : '') +
            (job.note ? `\n${job.note}` : '') +
            `\npoll job_status ${job.id}, collect with job_result ${job.id}`,
          isError: false,
        };
      }
      const result = await handlers.ask(request, ctx);
      return { text: renderAsk(result), isError: !result.ok };
    }
    case 'job_status': {
      const jobId = requireString(args, 'jobId', { max: 64 });
      const job = await handlers.jobStatus(jobId);
      return { text: renderJobStatus(job), isError: !job };
    }
    case 'job_result': {
      const jobId = requireString(args, 'jobId', { max: 64 });
      const job = await handlers.jobResult(jobId);
      return { text: renderJobResult(job), isError: !job || (job && !job.running && job.answer?.ok !== true) };
    }
    case 'job_cancel': {
      const jobId = requireString(args, 'jobId', { max: 64 });
      const outcome = await handlers.jobCancel(jobId);
      if (!outcome?.ok) {
        return { text: `cannot cancel ${jobId}: ${outcome?.reason ?? 'unknown job'}`, isError: true };
      }
      return {
        text: outcome.ack
          ? `${jobId}: ${outcome.detail}`
          : `${jobId}: ${outcome.detail} — check \`git status\` in its tree before re-dispatching`,
        isError: false,
      };
    }
    case 'permission_answer': {
      const jobId = requireString(args, 'jobId', { max: 64 });
      const requestId = requireString(args, 'requestId', { max: 64 });
      if (args.decision !== 'allow_once' && args.decision !== 'reject') {
        throw new ToolError('"decision" must be "allow_once" or "reject"');
      }
      const outcome = await handlers.permissionAnswer(jobId, args.decision, requestId);
      if (!outcome?.ok) {
        return { text: outcome?.reason ?? `no pending permission request for ${jobId}`, isError: true };
      }
      const sent = `${jobId}: ${outcome.decision} sent${outcome.requestId ? ` for request ${outcome.requestId}` : ''}`;
      // The child acknowledged whether it was still holding that request; an
      // answer that missed must not read as applied.
      if (outcome.acknowledged === false) {
        return { text: `${sent} — but the turn was no longer holding it (already answered or timed out)`, isError: true };
      }
      return { text: sent, isError: false };
    }
    case 'fanout': {
      const agents = Array.isArray(args.agents) ? args.agents.filter((a) => typeof a === 'string') : [];
      if (agents.length < 2) throw new ToolError('"agents" must list two or more agent names');
      const prompt = requireString(args, 'prompt');
      const permission = optionalPermission(args);
      if (permission === 'ask') {
        throw new ToolError('permission "ask" is only for ask_agent with background: true');
      }
      if (permission === 'allow-all' && args.worktree !== true) {
        throw new ToolError('fanout with allow-all requires worktree: true');
      }
      const result = await handlers.fanout({
        agents,
        prompt,
        synthesize: optionalString(args, 'synthesize'),
        worktree: args.worktree === true,
        permission,
        effort: optionalEffort(args),
      }, ctx);
      return { text: renderFanout(result), isError: !result.ok };
    }
    case 'route': {
      const prompt = requireString(args, 'prompt');
      const decision = await handlers.route(prompt);
      if (ctx.signal?.aborted) return { text: 'request cancelled before dispatch', isError: true };
      if (args.run !== true) return { text: renderRoute(decision), isError: false };
      const permission = optionalPermission(args);
      const budgetUsd = optionalPositiveNumber(args, 'budgetUsd');
      const cwd = optionalString(args, 'cwd');
      if (permission === 'ask' && args.background !== true) {
        throw new ToolError('permission "ask" is only for ask_agent with background: true');
      }
      if (args.background === true) {
        const job = await handlers.startJob({ agent: decision.agent, prompt, permission, budgetUsd, cwd });
        if (job?.error) return { text: `cannot start job: ${job.error}`, isError: true };
        return {
          text: `${renderRoute(decision)}\n\njob ${job.id} started · poll job_status ${job.id}`,
          isError: false,
        };
      }
      let result = await handlers.ask({ agent: decision.agent, prompt, permission, budgetUsd, cwd }, ctx);
      // A pool that is out of quota is not a failed task: hand it to the other
      // one, and say so, rather than reporting an exhausted pool as the answer.
      let failedOver = null;
      if (!result.ok && !ctx.signal?.aborted && isQuotaError(result.error)) {
        const registry = configuredRegistryPath();
        for (const next of agentChain(readAgentEntry(registry, decision.agent), decision.agent)) {
          failedOver = next;
          const handedOver = cwd
            ? buildHandoffPrompt({ cwd, target: next, from: decision.agent, task: prompt })
            : prompt;
          result = await handlers.ask({ agent: next, prompt: handedOver, permission, budgetUsd, cwd }, ctx);
          if (result.ok || !isQuotaError(result.error)) break;
        }
      }
      return { text: renderRoute(decision, result, failedOver), isError: !result.ok };
    }
    case 'agents': {
      const rows = await handlers.agents();
      return { text: renderAgents(rows), isError: false };
    }
    case 'brief': {
      if (args.json !== undefined && typeof args.json !== 'boolean') throw new ToolError('"json" must be a boolean');
      const text = await handlers.brief({ json: args.json === true });
      return { text, isError: false };
    }
    case 'search': {
      const query = requireString(args, 'query');
      const since = optionalString(args, 'since');
      if (since !== undefined && !isRealDate(since)) throw new ToolError('"since" must be a real date as YYYY-MM-DD');
      const source = optionalString(args, 'source');
      if (source !== undefined && !SEARCH_SOURCES.includes(source)) {
        throw new ToolError(`"source" must be one of ${SEARCH_SOURCES.join(', ')}`);
      }
      const limit = args.limit === undefined ? 20 : args.limit;
      if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new ToolError('"limit" must be an integer from 1 to 50');
      const text = await handlers.search({ query, since, source, limit });
      return { text, isError: false };
    }
    case 'sessions': {
      const agent = optionalString(args, 'agent');
      const state = optionalString(args, 'state');
      if (args.includeClosed !== undefined && typeof args.includeClosed !== 'boolean') {
        throw new ToolError('"includeClosed" must be a boolean');
      }
      const rows = await handlers.sessions({ agent, state, includeClosed: args.includeClosed === true });
      return { text: renderSessions(rows), isError: false };
    }
    case 'session_close': {
      const label = requireString(args, 'label', { max: 64 });
      const outcome = await handlers.sessionClose(label);
      if (!outcome) return { text: `no session labelled ${label}`, isError: true };
      return { text: outcome.text ?? `${label}: closed`, isError: false };
    }
    case 'session_log': {
      const label = requireString(args, 'label', { max: 64 });
      const limit = args.limit === undefined ? 30 : args.limit;
      if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new ToolError('"limit" must be an integer from 1 to 200');
      const before = args.before;
      if (before !== undefined && (!Number.isInteger(before) || before < 0)) throw new ToolError('"before" must be a non-negative integer');
      if (args.textOnly !== undefined && typeof args.textOnly !== 'boolean') throw new ToolError('"textOnly" must be a boolean');
      const log = await handlers.sessionLog(label, { before, limit, textOnly: args.textOnly === true });
      if (!log) return { text: `no session labelled ${label}`, isError: true };
      if (log.noTranscript) return { text: `${label}: no transcript yet (the first turn has not completed)`, isError: false };
      return { text: renderSessionLog({ label, records: log.records, total: log.total, before }), isError: false };
    }
    case 'session_config': {
      const label = requireString(args, 'label', { max: 64 });
      const patch = {};
      const model = optionalString(args, 'model');
      const effort = optionalEffort(args);
      if (model) patch.model = model;
      if (effort) patch.effort = effort;
      if (!Object.keys(patch).length) throw new ToolError('session_config needs "model" and/or "effort"');
      const session = await handlers.sessionConfig(label, patch);
      if (!session) return { text: `no session labelled ${label}`, isError: true };
      const set = Object.entries(patch).map(([k, v]) => `${k}=${v}`).join(' ');
      return { text: `${label}: ${set} from the next turn`, isError: false };
    }
    case 'status': {
      const text = await handlers.status();
      return { text, isError: false };
    }
    default:
      throw new ToolError(`unknown tool: ${name}`);
  }
}

const ERROR_CODES = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
};

function errorResponse(id, code, message) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

// Returns a response object, or null when the message needs no reply
// (notifications). Never throws: a protocol-level failure must not kill the
// server, or the client loses every other tool with it.
export async function handleMessage(message, handlers, { log = () => {}, signal, treeKey } = {}) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    return errorResponse(null, ERROR_CODES.invalidRequest, 'expected a single JSON-RPC object');
  }
  if (message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
    return errorResponse(message.id, ERROR_CODES.invalidRequest, 'not a JSON-RPC 2.0 request');
  }

  const { id, method, params } = message;
  const isNotification = id === undefined || id === null;

  try {
    switch (method) {
      case 'initialize':
        return {
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: { tools: { listChanged: false } },
            serverInfo: SERVER_INFO,
            instructions: INSTRUCTIONS,
          },
        };
      case 'notifications/initialized':
      case 'notifications/cancelled':
        return null;
      case 'ping':
        return { jsonrpc: '2.0', id, result: {} };
      case 'tools/list':
        return { jsonrpc: '2.0', id, result: { tools: TOOLS } };
      case 'tools/call': {
        const name = params?.name;
        if (typeof name !== 'string') {
          throw new ToolError('tools/call needs a tool name');
        }
        const args = params?.arguments ?? {};
        if (typeof args !== 'object' || Array.isArray(args)) {
          throw new ToolError('tools/call arguments must be an object');
        }
        log(`call ${name}`);
        // treeKey is opaque here: the caller's own tree claim, so an I/O
        // handler can exclude it when asking whether the tree is busy.
        const outcome = await callTool(name, args, handlers, { signal, treeKey });
        return {
          jsonrpc: '2.0',
          id,
          result: {
            content: [{ type: 'text', text: outcome.text }],
            isError: outcome.isError === true,
          },
        };
      }
      default:
        if (isNotification) return null;
        return errorResponse(id, ERROR_CODES.methodNotFound, `unknown method: ${method}`);
    }
  } catch (err) {
    if (isNotification) return null;
    if (err instanceof ToolError) return errorResponse(id, ERROR_CODES.invalidParams, err.message);
    log(`error ${method}: ${err?.message ?? err}`);
    return errorResponse(id, ERROR_CODES.internal, err?.message ?? String(err));
  }
}

export { ToolError };
