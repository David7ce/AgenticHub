# hub-mcp — the hub as an MCP server

STATUS: active

One surface, not five. This exposes the other agents on this machine as MCP
tools, so the agent you already chat with can call them instead of you opening
a second app.

```
Claude Code (or any MCP client)
  ├── skills, Playwright, git worktrees, images, mobile   ← already there
  └── MCP "agent-hub": ask_agent / sessions / fanout / route / agents / status
```

Node.js 22+, no dependencies. OpenCode and Claude Code can host the hub;
other MCP clients can register the same stdio server.

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
| `ask_agent` | One registered agent (`claude`, `opencode`, `codex`) answers a prompt. Optional `model`, native `mode`, `cwd`, `permission`, `timeoutMs`, `budgetUsd` (default 3; cancels the turn past it), `label` (a named session; see [Sessions](#sessions)), `worktree`, `from` (hand over another session's turn) and `background: true`, which returns a job id instead of waiting. `permission: "ask"` holds permission requests for the owner and needs `background: true`. | yes |
| `job_status` | State, elapsed, model, cwd, session label, last tool, live `recent text` when the agent has streamed some, requested/reported native mode, and any permission held for the owner — with the `requestId` needed to answer it. | no |
| `job_result` | The answer of a background delegation, rendered as `ask_agent` would have returned it. A job also saves it under `results/` (a foreground ask does not), so an answer that was already written survives the chat closing. A job still running when the chat closes is cancelled, not left to finish (see Cancellation and connection shutdown). | no |
| `job_cancel` | Stop a background delegation. Waits (bounded) for the process to exit and says whether it did — an unacknowledged cancel means the tree may still be changing. | no |
| `permission_answer` | Answer a permission the hub is holding: `jobId`, the `requestId` `job_status` showed and `decision` (`allow_once` or `reject`). A job with nothing pending is an error, so an answer cannot land on a later request. | no |
| `sessions` | The named sessions: label, agent, state, tree, model, last activity and spend. Closed sessions are hidden unless `includeClosed: true`; filter with `agent` or `state`. Read-only. | no |
| `session_log` | What a named session did, newest first: prompts, agent text, tools, permission decisions and stops. Page older records with `before`; `textOnly` keeps prompts and agent text. Read-only. | no |
| `session_close` | End a session by label. It stays listed as closed and its label cannot be reused. A worktree is reported with its path and whether it has changes; this call never deletes one. | no |
| `session_config` | Set the model and/or effort a named session uses from its next turn on. | no |
| `fanout` | Same prompt to 2+ agents in parallel, with optional `synthesize` and per-agent `worktree`. | yes, per agent |
| `route` | Which agent should take this prompt (cost/health aware, reads the audit log). `run: true` also executes it; `run` + `background` executes it as a job. | only with `run` |
| `agents` | Registry, availability, consent state, default model. | no |
| `brief` | The workspace in at most 40 lines — same text as `hubctl brief`: doctor, repos with uncommitted changes, last runs, today's spend, the handoff's pending list. `json: true` returns the object. Call it first in a new session. | no |
| `search` | Full-text search over the audit log, the working notes and git commit messages (`hubctl search`). `query` plus optional `since`, `source` (`runs`/`notes`/`git`), `limit`. Read-only; it refreshes only its own derived `workspace-panel/logs/index.db`. | no |
| `status` | The hub's own health — same snapshot as `hubctl status` (consent/expiry, worktrees, bench vs. baseline, egress, recent runs), plus the background jobs living in this server process. | no |

Restricted dispatches currently fail closed. `fanout` with `allow-all` requires
`worktree: true` and a Git repository; each agent must already have a suitable
consent grant. `permission: "ask"` is write-capable for consent and tree locking,
but it is a distinct cap below full `allow-all`: a grant limited to `ask` does not
admit `allow-all`. Only `ask_agent` with `background: true` accepts it —
`fanout` and a foreground `route` refuse it. Worktrees and the retained synthesis
working directory are not sandboxes and do not prevent access outside those
directories.
Live mode information comes from the agent's latest report and can be unknown
or pending; it is not proof of effective permissions or OS isolation. A running
`job_result` shows the same status details.
Cancelled or timed-out results show whether cancellation was acknowledged;
missing confirmation is treated as unknown. An acknowledgment is not proof
that every process stopped or that earlier actions were undone.

Every call goes through `../consent.json` (copy `consent.example.json` and
edit) and writes one
line to `workspace-panel/logs/runs.jsonl`, exactly like
`hub-acp.mjs`. There is no second, unaudited path.

## Sessions

A conversation can be addressed by a short label (lowercase letters, digits and
hyphens). `results/sessions.json` (ignored) holds each one: agent, ACP session id,
tree or worktree, model, effort, state (`idle`, `running`, `waiting-permission`,
`closed`), last activity, reported spend and the running job's id. An unknown label
starts a session; a known one continues it with its stored session, tree, model and
effort, so it survives the MCP server restarting. A label belongs to the agent and
tree that first used it — addressing it with another is an error — and a closed
label cannot be reused.

A session records the MCP server process that started its current turn
(`ownerPid`). A second server's startup leaves a session owned by a live foreign
process alone, and `session_close` refuses it with a message naming that pid —
close it from the window that owns it. A session whose record was left `running`
with no live turn in its own server is not busy: the next turn takes the record
over instead of queueing behind it forever, and closing it records any prompts
still queued as `dropped`.

Each ACP session's transcript is `results/transcripts/<acpSessionId>.jsonl`, one
JSON object per line: prompts, tool calls, permission requests and answers, the
agent's text and the stop record. Agent text is written when the turn ends, so
`session_log` on a running turn shows its prompt but not its answer. `job_status`
carries the live text instead, though an agent that streams its answer last leaves
`recent text` empty until the end; `last tool` is the dependable live signal.

## Attended `ask`

`permission: "ask"` (background only) runs the adapter in its attended native mode
from `agents.json`, `permissionModes.attended.force`: Claude `acceptEdits`, Codex
`workspace-write`, OpenCode `build`. An explicit `mode` still wins. The hub answers
in-tree reads, searches and edits itself and holds every other
`session/request_permission` — shell commands, fetches, edits outside the tree —
for the owner. `job_status` shows the held request and its `requestId`;
`permission_answer` requires that id, so an answer names exactly the request the
person read. An unanswered request is refused after the permission timeout (five
minutes by default), and the turn's own deadline pauses while one is held.

**What the adapters actually do.** A request can only be held if the adapter sends
one. On 2026-11-22 the pinned Claude adapter
(`@agentclientprotocol/claude-agent-acp@0.101.0`) and native OpenCode sent none: a
shell command ran under the attended mode and under `default` without ever asking.
So `ask` is not a supervision boundary today; with these adapters it is
write-capable, effectively `allow-all` within the grant. Codex is untested — its
quota was exhausted on the day. The matrix and the run's defects are in the
[acceptance report](../benchmarks/opencode-control-acceptance-2026-11-22.md).

## Worktrees

`worktree: true` runs the turn in a fresh checkout under the repository's git
directory — `<repo>/.git/agent-worktrees/` for an ordinary checkout — so two
writers cannot collide. Outside a Git repository the turn does not start. A
write-capable turn (`allow-all` or `ask`) whose tree is already claimed is placed
in one automatically instead of failing, and the reply says `placed in worktree
<path> because <tree> is busy`.

A labelled session keeps the first checkout it is given for the rest of its life,
so later turns land in the same worktree. `session_close` reports that path and
whether it holds changes, and never deletes it; merging back stays an explicit
step. If the checkout is removed by hand, the session reports `worktree missing at
<path>` and a turn refuses rather than falling back to the original tree.

## Handoff by reference

`from: {label, turns}` (1-3, default 1) prepends the source session's last turn(s)
and the path of its full transcript to `prompt`, and is independent of the target's
own `label`/`sessionId`. The carried text is trimmed from its oldest side so the
whole prompt stays within the 4000-character cap, and the heading says how many
turns were really carried. A source with no finished turn is an error, not an
empty handover.

The carried text is another agent's output, already redacted when that turn
stopped, but the handover still sends it to this agent's provider. Hand over only
what may leave the machine.

## Register it

From the repository root, `node hub.mjs init --workspace --dry-run` previews
client configuration in the clone's parent folder. Remove `--dry-run` to write
missing files. See [Getting started](../getting-started.md) for the full setup.
The tracked assets live in `templates/workspace/`; the parent `.mcp.json` is
local generated configuration, not a committed file.

For a manual registration, use `node` with the absolute path to this clone's
`mcp/server.mjs`. Claude Code uses `mcpServers`; VS Code uses `servers`.
OpenCode's generated entry uses Windows Node via `cmd.exe /c` on Windows and
plain `node` on native non-Windows hosts. For a WSL client reaching Windows
agents, explicitly use the Windows process and paths.

## Run it by hand

```
node mcp/server.mjs
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"agents","arguments":{}}}
```

Ctrl-D closes it. Logs go to stderr; stdout carries only protocol messages.

## Tests

```
node --test agent-hub/mcp/tests/*.test.mjs
```

Protocol/dispatch tests with no I/O, plus end-to-end tests that spawn the
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

## Cancellation and connection shutdown

`notifications/cancelled` stops a foreground request; `job_cancel` stops a
background job. Both use the same ACP cancellation path. A wrapper exiting with
`cancelAck: false` does not become an acknowledged cancellation: the tool still
warns that the agent's tree may be changing. Foreground results preserve that
verdict too.

Closing the MCP input stream requests cancellation for every owned hub script,
including background jobs and fan-outs. Queued calls and routing decisions still
in flight cannot start new work after shutdown begins. The server waits for its
children to finish and write audit records, bounded by the normal stop grace
plus one second. A script that still has not exited is reported and the server
exits with failure. Forcibly terminating the server can bypass this graceful
EOF path; inspect audit/inflight state after an abnormal exit.

A cancelled fan-out is recorded as `cancelled`, preserves each child's
`cancelAck`/`cancelWaitMs`, and sets its aggregate `cancelAck` only when every
child finished normally or acknowledged cancellation. It does not start a
subsequent synthesis after cancellation was received.

## Known limits

- The in-memory job registry targets 20 retained records and expires completed
  records after one hour, with cleanup on job start and settlement. Active
  controllers, including unacknowledged cancellations, are never evicted to
  satisfy that limit. Results needed later should be read from their saved
  files; an evicted job id is no longer available through `job_status` or
  `job_result`.
- Child stdout and stderr each have an 8 MiB capture limit. Overflow requests
  graceful cancellation and continues draining while discarding excess bytes,
  with the normal stop-grace/tree-kill backstop. The result reports a capture
  error rather than treating truncated JSON as success, even if the other
  stream contains valid JSON. This bounds capture memory; it does not prove a
  daemon-backed agent stopped. Saved results and audit records remain separate.
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
- A cancelled MCP request (the person presses stop: `notifications/cancelled`) stops the run:
  the server asks hub-acp to stop, hub-acp sends `session/cancel`, waits for proof and writes
  its audit line with status `cancelled` and `cancelAck`. Only a run that does not stop within
  15 s is killed. `job_cancel` and a cancelled `fanout` go the same way. A failed or cancelled
  write run also leaves a salvage file (HEAD, `git status`, diffstat) named in the result.
- Answers come back as text. An image produced by a callee cannot be returned
  through MCP; write it to a file and reference the path instead.
- The callee starts with no context from the conversation. Anything it needs
  must be in the prompt.
- `ask_agent` passes `--no-save`: the audit line is the record, and
  `results/` stays for deliberate runs. `fanout` still writes its merged file.
- **`ask` is not a supervision boundary yet.** The pinned Claude and OpenCode
  adapters send no permission request for a shell command, so there is nothing to
  hold and `ask` behaves as write-capable. See [Attended `ask`](#attended-ask) and
  the [acceptance report](../benchmarks/opencode-control-acceptance-2026-11-22.md).
- **A denied first turn still binds its label.** The session is recorded before
  consent answers, so a refused first turn leaves the label belonging to that
  agent and tree. Pick a new label instead of reusing it.
- **A failed registry write can wedge a session while its window is open.** A
  record left `running` or `waiting-permission` with no live turn is taken over
  by the next turn and stays closable, but a registry write that keeps failing in
  the owning window can leave it looking busy there; the exit is to close the
  session from that window.
- **A checkout is discarded only when the run never started.** A `denied` or
  `rejected` turn is refused before the agent starts, so its clean auto-placed
  checkout is removed and the label is not pinned to it. Any other failed run
  keeps its checkout — it may hold edits or detached commits — for
  `hubctl clean` or a manual merge.
- **The last requested mode outlives its policy.** A resumed session restores the
  mode its previous turn asked for, whichever policy asked for it, so an `ask`
  turn can leave a later `allow-all` turn in the attended mode. Pass `mode`
  explicitly when that matters.
- **`--json` no longer carries text or thought chunks in `events`.** `hub-acp
  --json` keeps the answer in the result's `text` and tool activity in `tools`;
  `events` is redacted and no longer duplicates streamed text, so a consumer that
  read it there must read the answer instead.
- **A hard-killed run leaves no agent text and no audit line.** Agent text is
  written to the transcript, and the audit line at the same point, when a turn
  stops; a process killed outright writes neither. `session_log` then shows the
  prompt with no answer.
- **A worktree is pinned for the session's life.** A labelled session keeps the
  first checkout it is given, with no per-turn choice afterwards, and closing the
  session does not delete it. Use a new label to return to the original tree.
