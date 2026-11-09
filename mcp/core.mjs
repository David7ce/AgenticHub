// core.mjs — the MCP surface of the hub, with no I/O of its own.
//
// Every decision lives here so it can be tested without spawning anything;
// server.mjs owns the stdio loop and the child processes. The tools are
// deliberately thin wrappers over hub-acp.mjs / fanout-acp.mjs so that
// consent.json, logs/runs.jsonl, budgets, permissions and worktrees keep
// working exactly as they do from the command line.

import { agentChain, DEFAULT_REGISTRY, isQuotaError, readAgentEntry } from '../acp/router.mjs';

// Reasoning-effort levels the hub maps onto each agent's own option (acp/effort.mjs).
const EFFORTS = ['low', 'medium', 'high', 'max'];

export const PROTOCOL_VERSION = '2025-06-18';
export const SERVER_INFO = { name: 'agent-hub', version: '1.0.0' };

const PERMISSIONS = ['deny', 'allow-reads', 'allow-all'];

export const TOOLS = [
  {
    name: 'ask_agent',
    description:
      'Ask one registered agent (opencode, claude, codex) a question through the ' +
      "hub's consent gate. Use it to get a second opinion, to hand cheap or bulk work to a " +
      'free model, or to ask a specialist. Writes one line to logs/runs.jsonl. Returns the ' +
      "agent's answer as text.\n\n" +
      'Calls are serialized **per working tree**: two calls on the same cwd run one after the ' +
      'other, while calls on different repos run in parallel. For N repos prefer `fanout`.\n\n' +
      'Do not combine this with a question to the user in the same turn: the question is ' +
      'rendered behind the running tool and stays unanswerable until it finishes.\n\n' +
      'The timeout defaults to 180000 ms. Repo-sized work needs 900000-1800000 ms, and if a ' +
      'turn times out the callee may still be working in `cwd` — check `git status` there ' +
      'before re-dispatching.\n\n' +
      'The budget defaults to $3 and cancels the turn (cleanly, not a crash) once reported ' +
      'cost crosses it; raise `budgetUsd` for a task bigger than one commit.\n\n' +
      'For anything longer than a couple of minutes pass `background: true`: you get a job id ' +
      'back immediately, then poll `job_status` and collect with `job_result`. That is the ' +
      'only shape in which a 40-minute delegation costs no blocked chat time.',
    inputSchema: {
      type: 'object',
      properties: {
        agent: {
          type: 'string',
          description: 'Registry name: opencode (default, cheap), claude (escalation), codex.',
        },
        prompt: {
          type: 'string',
          description: 'The full question. The agent has no context from this conversation.',
        },
        model: {
          type: 'string',
          description:
            'Override the session model (registry default otherwise), e.g. ' +
            'opencode/deepseek-v4.1-flash-free or poolside/laguna-s-2.1:free.',
        },
        effort: {
          type: 'string',
          enum: EFFORTS,
          description:
            'Reasoning effort, mapped to the agent\'s own option (OpenCode effort, Codex ' +
            'reasoning_effort). Use low for text, docs, reviews of a small diff and mechanical ' +
            'edits: a doc rewrite took 314 s at the default, 95 % of it reasoning. Leave it out ' +
            '(agent default) for real coding; high only for hard debugging.',
        },
        cwd: {
          type: 'string',
          description: 'Absolute working directory for the session. Defaults to this project.',
        },
        permission: {
          type: 'string',
          enum: PERMISSIONS,
          description: 'Tool policy for the callee. Default deny: it can read, not edit.',
        },
        timeoutMs: {
          type: 'integer',
          minimum: 1000,
          description:
            'Turn timeout in ms. Default 180000; pass 900000-1800000 for repo-sized work, ' +
            'and remember the tool call is blocked for that long.',
        },
        budgetUsd: {
          type: 'number',
          exclusiveMinimum: 0,
          description:
            "Cancel the turn once reported cost crosses this many dollars. Default 3 -- a " +
            "real one-commit dispatch (a physics tune, a feature plus tests) has cost " +
            "$0.51-$1.48 on this hub; raise it for anything bigger, lower it for a cheap " +
            "question. On a budget cut the turn still ends normally (not a crash) and, with " +
            "permission allow-all, a salvage file records what was committed before the cut.",
        },
        background: {
          type: 'boolean',
          description:
            'Return a job id immediately instead of waiting for the answer. Use it for any ' +
            'turn longer than a couple of minutes: poll `job_status`, collect with ' +
            '`job_result`. The job keeps running if this chat turns off.',
        },
      },
      required: ['agent', 'prompt'],
      additionalProperties: false,
    },
  },
  {
    name: 'fanout',
    description:
      'Send the same prompt to several agents in parallel and return every answer plus an ' +
      'optional synthesis. Use it when you want genuinely independent takes, or to compare ' +
      'a cheap model against an expensive one before committing.',
    inputSchema: {
      type: 'object',
      properties: {
        agents: {
          type: 'array',
          items: { type: 'string' },
          minItems: 2,
          description: 'Two or more registry names.',
        },
        prompt: { type: 'string', description: 'The prompt every agent receives.' },
        synthesize: {
          type: 'string',
          description:
            'Registry name that merges the answers into one section. Adds one model call. ' +
            'Omit for raw answers only.',
        },
        worktree: {
          type: 'boolean',
          description:
            'Give every agent its own git worktree, so parallel edits cannot collide. ' +
            'Changed worktrees are kept and reported.',
        },
        permission: {
          type: 'string',
          enum: PERMISSIONS,
          description: 'Tool policy for every callee. Default deny.',
        },
        effort: {
          type: 'string',
          enum: EFFORTS,
          description: 'Reasoning effort passed to every agent (see ask_agent). low for text and reviews.',
        },
      },
      required: ['agents', 'prompt'],
      additionalProperties: false,
    },
  },
  {
    name: 'route',
    description:
      "Ask the hub's router which agent should take a prompt (cost/health aware, reads the " +
      'audit log). Set run=true to also execute it, which turns this into "do it on the ' +
      'cheapest agent that is likely to succeed".',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'The work to route.' },
        run: {
          type: 'boolean',
          description: 'Execute the routed prompt instead of only reporting the choice.',
        },
        permission: {
          type: 'string',
          enum: PERMISSIONS,
          description: 'Tool policy when run=true. Default deny.',
        },
        background: {
          type: 'boolean',
          description:
            'With run=true, return a job id instead of waiting — same semantics as ask_agent.',
        },
        budgetUsd: {
          type: 'number',
          exclusiveMinimum: 0,
          description: 'With run=true, same meaning and default (3) as ask_agent\'s budgetUsd.',
        },
      },
      required: ['prompt'],
      additionalProperties: false,
    },
  },
  {
    name: 'agents',
    description:
      'List the registered agents with availability, consent state and default model. Use it ' +
      'before ask_agent to see who is actually allowed to run.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'job_status',
    description:
      'Progress of a background delegation: state, elapsed, model, cwd and last tool. Use it ' +
      'after ask_agent with background=true instead of waiting on a tool call for minutes.',
    inputSchema: {
      type: 'object',
      properties: { jobId: { type: 'string', description: 'The id returned when the job started.' } },
      required: ['jobId'],
      additionalProperties: false,
    },
  },
  {
    name: 'job_result',
    description:
      'The answer of a background delegation, rendered exactly as ask_agent would have ' +
      'returned it. Says it is still running if it is.',
    inputSchema: {
      type: 'object',
      properties: { jobId: { type: 'string', description: 'The id returned when the job started.' } },
      required: ['jobId'],
      additionalProperties: false,
    },
  },
  {
    name: 'job_cancel',
    description:
      'Stop a background delegation. The callee gets the same cancel-and-wait treatment a ' +
      'timeout does, so the tree may still be changing briefly afterwards.',
    inputSchema: {
      type: 'object',
      properties: { jobId: { type: 'string', description: 'The id returned when the job started.' } },
      required: ['jobId'],
      additionalProperties: false,
    },
  },
  {
    name: 'status',
    description:
      "The hub's own health, the same snapshot `hubctl status` prints: consent/expiry per " +
      'agent, claude-mem and the bridge (if running), worktrees left on disk, the last bench ' +
      'result against baseline, egress posture, and the most recent runs. Use it to check the ' +
      "hub's own state from inside the chat instead of shelling out.",
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
];

// ── argument validation ──────────────────────────────────────────────────────

class ToolError extends Error {}

function requireString(args, name, { max = 100_000 } = {}) {
  const value = args[name];
  if (typeof value !== 'string' || !value.trim()) {
    throw new ToolError(`"${name}" must be a non-empty string`);
  }
  if (value.length > max) throw new ToolError(`"${name}" is too long (${value.length} > ${max})`);
  return value;
}

function optionalString(args, name) {
  const value = args[name];
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') throw new ToolError(`"${name}" must be a string`);
  return value;
}

function optionalEffort(args) {
  const value = args.effort;
  if (value === undefined) return undefined;
  if (!EFFORTS.includes(value)) {
    throw new ToolError(`"effort" must be one of ${EFFORTS.join(', ')}`);
  }
  return value;
}

function optionalPermission(args, fallback = 'deny') {
  const value = args.permission;
  if (value === undefined) return fallback;
  if (!PERMISSIONS.includes(value)) {
    throw new ToolError(`"permission" must be one of ${PERMISSIONS.join(', ')}`);
  }
  return value;
}

function optionalPositiveInt(args, name) {
  const value = args[name];
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value < 1000) {
    throw new ToolError(`"${name}" must be an integer >= 1000`);
  }
  return value;
}

function optionalPositiveNumber(args, name) {
  const value = args[name];
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new ToolError(`"${name}" must be a number > 0`);
  }
  return value;
}

// ── result rendering ────────────────────────────────────────────────────────

function seconds(ms) {
  return typeof ms === 'number' ? `${(ms / 1000).toFixed(1)}s` : '—';
}

function money(cost) {
  const amount = cost?.amount;
  return typeof amount === 'number' ? `$${amount.toFixed(4)}` : '—';
}

export function renderAsk(result) {
  const head =
    `agent: ${result.agent} · status: ${result.status} · ${seconds(result.durationMs)} · ` +
    `cost: ${money(result.cost)}` +
    (result.model ? ` · model: ${result.model}` : '') +
    (result.stopReason ? ` · stop: ${result.stopReason}` : '') +
    (result.sessionId ? ` · session: ${result.sessionId}` : '');

  // A model move is worth stating: the answer came from a paid pool because
  // the free one was empty, and the caller may want to know that.
  const trail =
    result.modelAttempts?.length > 1 ? `\nmodels tried: ${result.modelTrail}` : '';
  const concurrent = result.concurrentWrite
    ? `\nanother write run held this tree: ${result.concurrentWrite}`
    : '';
  const salvage = result.salvage
    ? `\nwhat it left behind: ${result.salvage} (git status, HEAD, diffstat)`
    : '';
  const saved = result.savedTo ? `\nsaved: ${result.savedTo}` : '';

  if (!result.ok) {
    const where = result.cwd ? ` in ${result.cwd}` : '';
    // A timeout is the one failure that leaves work behind. Say so, with the
    // path, instead of letting the caller assume the tree is untouched.
    const leftover =
      result.status === 'timeout'
        ? `\nthe callee may still be working${where} — check \`git status\` there before ` +
          're-dispatching, and release any write lane it claimed.'
        : '';
    return `${head}${trail}${concurrent}${salvage}${saved}\n\nerror: ${result.error ?? result.status}${leftover}`;
  }
  const tools = Array.isArray(result.tools) && result.tools.length
    ? `\n\ntool calls (${result.tools.length}): ` +
      result.tools.slice(0, 12).map((t) => t.title ?? 'tool').join(', ') +
      (result.tools.length > 12 ? ', …' : '')
    : '';
  return `${head}${trail}${concurrent}${saved}${tools}\n\n${(result.text ?? '').trimEnd() || '(empty answer)'}`;
}

export function renderJobStatus(job) {
  if (!job) return 'unknown job';
  const head =
    `${job.id} · ${job.state} · ${seconds(job.elapsedMs)} · ${job.agent}` +
    (job.model ? ` · model: ${job.model}` : '') +
    (job.cwd ? ` · ${job.cwd}` : '');
  const tail = job.lastTool ? `\nlast tool: ${job.lastTool}` : '';
  const error = job.error ? `\nerror: ${job.error}` : '';
  const hint = job.running
    ? '\nstill running — poll job_status, or collect with job_result when it ends'
    : '\nfinished — job_result has the answer';
  return `${head}${tail}${error}${hint}`;
}

export function renderJobResult(job) {
  if (!job) return 'unknown job';
  if (job.running) return `${renderJobStatus(job)}\n\nthe answer is not ready yet`;
  if (!job.answer) {
    return `${renderJobStatus(job)}\n\nfinished as ${job.state} with no answer object`;
  }
  return renderAsk({ ...job.answer, modelAttempts: job.answer.modelAttempts });
}

export function renderFanout(result) {
  const lines = [
    `fan-out · ${result.okCount}/${result.agents.length} answered · ${seconds(result.durationMs)}`,
  ];
  if (result.synthesis?.ok) {
    lines.push('', `## synthesis (${result.synthesis.agent})`, '', (result.synthesis.text ?? '').trimEnd());
  }
  for (const agent of result.agents) {
    lines.push(
      '',
      `## ${agent.agent} — ${agent.status} — ${seconds(agent.durationMs)} — ${money(agent.cost)}`,
      '',
      agent.ok ? (agent.text ?? '').trimEnd() || '(empty answer)' : `error: ${agent.error ?? agent.status}`,
    );
  }
  if (result.worktrees?.length) {
    lines.push('', 'worktrees kept: ' + result.worktrees.map((w) => w.path).join(', '));
  }
  return lines.join('\n');
}

export function renderRoute(decision, result, failedOver = null) {
  const model = decision.model ? ` (${decision.model})` : '';
  const topology = decision.topology ? ` · topology: ${decision.topology}` : '';
  const head =
    `routed to: ${decision.agent}${model}${topology} — ${decision.reason}` +
    (failedOver ? ` (out of quota; retried on ${failedOver})` : '');
  return result ? `${head}\n\n${renderAsk(result)}` : head;
}

export function renderAgents(rows) {
  if (!rows.length) return 'no agents registered';
  const lines = ['agent       available  consent   default model'];
  for (const row of rows) {
    lines.push(
      `${String(row.name).padEnd(11)} ${(row.available ? 'yes' : 'no').padEnd(10)} ` +
        `${(row.consent.ok ? 'granted' : `denied (${row.consent.reason})`).padEnd(9)} ` +
        `${row.defaultModel ?? '—'}`,
    );
  }
  return lines.join('\n');
}

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
      if (args.background === true) {
        const job = await handlers.startJob({ agent: decision.agent, prompt, permission, budgetUsd });
        if (job?.error) return { text: `cannot start job: ${job.error}`, isError: true };
        return {
          text: `${renderRoute(decision)}\n\njob ${job.id} started · poll job_status ${job.id}`,
          isError: false,
        };
      }
      let result = await handlers.ask({ agent: decision.agent, prompt, permission, budgetUsd });
      // A pool that is out of quota is not a failed task: hand it to the other
      // one, and say so, rather than reporting an exhausted pool as the answer.
      let failedOver = null;
      if (!result.ok && isQuotaError(result.error)) {
        const registry = process.env.AGENT_HUB_REGISTRY ?? DEFAULT_REGISTRY;
        for (const next of agentChain(readAgentEntry(registry, decision.agent), decision.agent)) {
          failedOver = next;
          result = await handlers.ask({ agent: next, prompt, permission, budgetUsd });
          if (result.ok || !isQuotaError(result.error)) break;
        }
      }
      return { text: renderRoute(decision, result, failedOver), isError: !result.ok };
    }
    case 'agents': {
      const rows = await handlers.agents();
      return { text: renderAgents(rows), isError: false };
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
