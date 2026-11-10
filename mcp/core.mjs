// core.mjs — the MCP surface of the hub, with no I/O of its own.
//
// Every decision lives here so it can be tested without spawning anything;
// server.mjs owns the stdio loop and the child processes. The tools are
// deliberately thin wrappers over hub-acp.mjs / fanout-acp.mjs so that
// consent.json, logs/runs.jsonl, budgets, permissions and worktrees keep
// working exactly as they do from the command line.

import { agentChain, DEFAULT_REGISTRY, isQuotaError, readAgentEntry } from '../acp/router.mjs';
import { buildHandoffPrompt } from '../acp/handoff.mjs';

import { TOOLS } from './tools.mjs';
import {
  ToolError, optionalEffort, optionalPermission, optionalPositiveInt, optionalPositiveNumber,
  optionalString, requireString,
} from './validate.mjs';
import { renderAgents, renderAsk, renderFanout, renderJobResult, renderJobStatus, renderRoute } from './render.mjs';

// Kept importable from here: tests and server.mjs use these names.
export { TOOLS } from './tools.mjs';
export { renderAgents, renderAsk, renderFanout, renderJobResult, renderJobStatus, renderRoute } from './render.mjs';

export const PROTOCOL_VERSION = '2025-06-18';
const SEARCH_SOURCES = ['runs', 'notes', 'git'];

function isRealDate(text) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const date = new Date(`${text}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === text;
}

export const SERVER_INFO = { name: 'agent-hub', version: '1.0.0' };

// ── dispatch ────────────────────────────────────────────────────────────────

// handlers: { ask, fanout, route, agents } — each async, already I/O-bound.
export async function callTool(name, args, handlers) {
  switch (name) {
    case 'ask_agent': {
      const agent = requireString(args, 'agent', { max: 64 });
      const prompt = requireString(args, 'prompt');
      const request = {
        agent,
        prompt,
        model: optionalString(args, 'model'),
        cwd: optionalString(args, 'cwd'),
        permission: optionalPermission(args),
        timeoutMs: optionalPositiveInt(args, 'timeoutMs'),
        budgetUsd: optionalPositiveNumber(args, 'budgetUsd'),
        effort: optionalEffort(args),
      };
      if (args.background === true) {
        const job = await handlers.startJob(request);
        if (job?.error) return { text: `cannot start job: ${job.error}`, isError: true };
        return {
          text:
            `job ${job.id} started · ${agent}` +
            (job.cwd ? ` in ${job.cwd}` : '') +
            `\npoll job_status ${job.id}, collect with job_result ${job.id}`,
          isError: false,
        };
      }
      const result = await handlers.ask(request);
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
    case 'fanout': {
      const agents = Array.isArray(args.agents) ? args.agents.filter((a) => typeof a === 'string') : [];
      if (agents.length < 2) throw new ToolError('"agents" must list two or more agent names');
      const prompt = requireString(args, 'prompt');
      const result = await handlers.fanout({
        agents,
        prompt,
        synthesize: optionalString(args, 'synthesize'),
        worktree: args.worktree === true,
        permission: optionalPermission(args),
        effort: optionalEffort(args),
      });
      return { text: renderFanout(result), isError: !result.ok };
    }
    case 'route': {
      const prompt = requireString(args, 'prompt');
      const decision = await handlers.route(prompt);
      if (args.run !== true) return { text: renderRoute(decision), isError: false };
      const permission = optionalPermission(args);
      const budgetUsd = optionalPositiveNumber(args, 'budgetUsd');
      const cwd = optionalString(args, 'cwd');
      if (args.background === true) {
        const job = await handlers.startJob({ agent: decision.agent, prompt, permission, budgetUsd, cwd });
        if (job?.error) return { text: `cannot start job: ${job.error}`, isError: true };
        return {
          text: `${renderRoute(decision)}\n\njob ${job.id} started · poll job_status ${job.id}`,
          isError: false,
        };
      }
      let result = await handlers.ask({ agent: decision.agent, prompt, permission, budgetUsd, cwd });
      // A pool that is out of quota is not a failed task: hand it to the other
      // one, and say so, rather than reporting an exhausted pool as the answer.
      let failedOver = null;
      if (!result.ok && isQuotaError(result.error)) {
        const registry = process.env.AGENT_HUB_REGISTRY ?? DEFAULT_REGISTRY;
        for (const next of agentChain(readAgentEntry(registry, decision.agent), decision.agent)) {
          failedOver = next;
          const handedOver = cwd
            ? buildHandoffPrompt({ cwd, target: next, from: decision.agent, task: prompt })
            : prompt;
          result = await handlers.ask({ agent: next, prompt: handedOver, permission, budgetUsd, cwd });
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
export async function handleMessage(message, handlers, { log = () => {} } = {}) {
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
            instructions:
              'agent-hub exposes this machine\'s other coding agents. Every call goes through ' +
              'consent.json and is logged to logs/runs.jsonl.',
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
        const outcome = await callTool(name, args, handlers);
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
