# hub-mcp — the hub as an MCP server

STATUS: active

One surface, not five. This exposes the other agents on this machine as MCP
tools, so the agent you already chat with can call them instead of you opening
a second app.

```
Claude Code (or any MCP client)
  ├── skills, Playwright, git worktrees, images, mobile   ← already there
  └── MCP "agent-hub": ask_agent / fanout / route / agents / status
```

Created 2026-10-30. Node 18+, no dependencies.

## Why this exists

Claude Code is the best agent surface here, but it cannot reach the free
OpenCode models or the hub's router. The alternatives either replace
Claude Code (OpenCode, Kilo) or need a translation layer for Anthropic's
`tool_use` (an `ANTHROPIC_BASE_URL` gateway). This is the cheap third option:
keep the surface, give it a tool that reaches the rest of the fleet.

## Files

| File | What it is |
|---|---|
| `server.mjs` | The stdio loop, the handlers and the per-tree queue |
| `hub-process.mjs` | Running the hub's own scripts: paths, timeouts, spawn, tree-kill |
| `core.mjs` | Protocol constants, tool dispatch and JSON-RPC handling (no I/O) |
| `tools.mjs` | The tool catalogue: names, descriptions, JSON schemas |
| `validate.mjs` | Argument validation |
| `render.mjs` | Results as the text the chat shows |
| `jobs.mjs` | Background jobs |

## Tools

| Tool | What it does | Costs a model call |
|---|---|---|
| `ask_agent` | One registered agent (`claude`, `opencode`, `codex`) answers a prompt. Optional `model`, `cwd`, `permission`, `timeoutMs`, `budgetUsd` (default 3; cancels the turn past it), and `background: true` returns a job id instead of waiting. | yes |
| `job_status` | State, elapsed, model, cwd and last tool of a background delegation. | no |
| `job_result` | The answer of a background delegation, rendered as `ask_agent` would have returned it. A job also saves it under `results/` (a foreground ask does not), so the answer survives a chat that closes before it finishes. | no |
| `job_cancel` | Stop a background delegation. Waits (bounded) for the process to exit and says whether it did — an unacknowledged cancel means the tree may still be changing. | no |
| `fanout` | Same prompt to 2+ agents in parallel, with optional `synthesize` and per-agent `worktree`. | yes, per agent |
| `route` | Which agent should take this prompt (cost/health aware, reads the audit log). `run: true` also executes it; `run` + `background` executes it as a job. | only with `run` |
| `agents` | Registry, availability, consent state, default model. | no |
| `status` | The hub's own health — same snapshot as `hubctl status` (consent/expiry, worktrees, bench vs. baseline, egress, recent runs), plus the background jobs living in this server process. | no |

Every call goes through `../consent.json` (copy `consent.example.json` and
edit) and writes one
line to [`../../logs/runs.jsonl`](../../logs/runs.jsonl), exactly like
`hub-acp.mjs`. There is no second, unaudited path.

## Register it

**Claude Code** — [`../../.mcp.json`](../../.mcp.json) is already committed:

```json
{
  "mcpServers": {
    "agent-hub": { "type": "stdio", "command": "node", "args": ["D:\\Workspaces\\AgentHub\\agent-hub\\mcp\\server.mjs"] }
  }
}
```

**VS Code / Copilot agent mode** — `.vscode/mcp.json`, same command under a
`servers` key instead of `mcpServers`.

**OpenCode** — `opencode.json`:

```json
{ "mcp": { "agent-hub": { "type": "local", "command": ["node", "D:\\Workspaces\\AgentHub\\agent-hub\\mcp\\server.mjs"] } } }
```

**Zed** — `context_servers` in `settings.json`, with the same `command`/`args`.

## Run it by hand

```
node agent-hub/mcp/server.mjs
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"agents","arguments":{}}}
```

Ctrl-D closes it. Logs go to stderr; stdout carries only protocol messages.

## Tests

```
node --test agent-hub/mcp/tests/*.test.mjs
```

22 protocol/dispatch tests with no I/O, plus 8 end-to-end tests that spawn the
real server, the real `hub-acp.mjs` and a fake ACP agent in a temp registry —
so the consent gate and the audit line are proven without a model call.

## Env overrides

| Variable | Effect |
|---|---|
| `AGENT_HUB_REGISTRY` | Alternate `agents.json` |
| `AGENT_HUB_CONSENT` | Alternate consent file |
| `AGENT_HUB_LOG` | Alternate audit log |
| `AGENT_HUB_LOCKS` | Alternate directory for the per-tree write locks (see `acp/tree-lock.mjs`) |
| `AGENT_HUB_INFLIGHT` | Alternate directory for the in-flight records (default `results/inflight`) |

Used by the tests; also lets a second hub run beside this one.

## Known limits

- Calls are serialized **per working tree**: two `ask_agent` calls on the same
  `cwd` queue, calls on different repos do not, and reads (`status`, `agents`)
  never queue. Use `fanout` (with `worktree`) for one prompt across N agents.
- `ask_agent` walks the agent's `modelFallbacks` when a pool reports
  exhaustion (free first, then Go by price — `docs/routing.md`); the answer names the
  model that responded and every attempt gets its own audit line. Passing
  `model` explicitly disables that substitution.
- A timeout asks the callee to stop (`session/cancel`) and waits up to
  `HUB_CANCEL_WAIT_MS` (default 8000) for proof that the turn ended. The audit
  line records `cancelAck`; when it is `false` the tree may still be changing.
  A callee that lives in a shared daemon (OpenCode: `opencode serve`) can keep
  going past the client being killed.
- A cancelled MCP request does not kill the child; it runs to `--timeout`.
  While it runs, `results/inflight/<pid>.json` makes it visible in `hubctl
  status` (the `running` line). A failed write run also leaves a salvage file
  (HEAD, `git status`, diffstat) named in the tool result.
- Answers come back as text. An image produced by a callee cannot be returned
  through MCP; write it to a file and reference the path instead.
- The callee starts with no context from the conversation. Anything it needs
  must be in the prompt.
- `ask_agent` passes `--no-save`: the audit line is the record, and
  `results/` stays for deliberate runs. `fanout` still writes its merged file.
