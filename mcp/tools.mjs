// tools.mjs — the tool catalogue the hub advertises over MCP: names, descriptions and
// JSON schemas. No behaviour; core.mjs dispatches them.

// Reasoning-effort levels the hub maps onto each agent's own option (acp/effort.mjs).
export const EFFORTS = ['low', 'medium', 'high', 'max'];

export const PERMISSIONS = ['deny', 'allow-reads', 'allow-all'];

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
            'opencode-go/beam-free or opencode-go/deepseek-v4.1-flash.',
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
        cwd: {
          type: 'string',
          description:
            'Working tree for the run. When set and the pool is out of quota, the next agent ' +
            'also receives the tree\'s git state, recent runs and the original task.',
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
      'agent, worktrees left on disk, the last bench ' +
      'result against baseline, egress posture, and the most recent runs. Use it to check the ' +
      "hub's own state from inside the chat instead of shelling out.",
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'brief',
    description:
      "The state of the hub's workspace in at most 40 lines, as `hubctl brief` prints it: config health (doctor), " +
      'repositories with uncommitted changes, the last runs, today\'s spend per agent and the pending list from the ' +
      'handoff. Call it first in a new session to resume without reading the whole docs trail. Read-only; no agent runs.',
    inputSchema: {
      type: 'object',
      properties: { json: { type: 'boolean', description: 'Return the structured object instead of the text.' } },
      additionalProperties: false,
    },
  },
  {
    name: 'search',
    description:
      'Full-text search over what the hub has already done and decided: the audit log (prompts and answers), the ' +
      'working notes (journal, handoff, history) and git commit messages. Use it before repeating work or to find why ' +
      'something was decided. Diacritics are ignored. Read-only; it only refreshes its own derived index.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', minLength: 1, description: 'Words to find; all must appear.' },
        since: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: 'Only results from this date on, YYYY-MM-DD.' },
        source: { type: 'string', enum: ['runs', 'notes', 'git'], description: 'Limit to one source.' },
        limit: { type: 'integer', minimum: 1, maximum: 50, default: 20, description: 'Maximum results.' },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
];
