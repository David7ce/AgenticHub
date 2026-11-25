# OpenCode as the single control room for Claude Code and Codex

Date: 2026-11-22. Status: design, awaiting owner approval. Builds on
[target-workflow.md](../../target-workflow.md) and the existing MCP/ACP hub.

## Intent

The owner wants to **write only in OpenCode** and from there have full control of,
and communication with, real **Claude Code** sessions (Claude subscription) and real
**Codex** sessions (ChatGPT subscription): start them, follow up, see what they are
doing, read what they said, approve or refuse what they want to do, stop them, and
pass work between them — without opening another app.

Comparison of alternatives (DeepSeek Harness `dsh`, OpenClaw, 2026-11-22) found no
better single terminal app: `dsh` ships no interactive terminal UI (web, headless,
ACP, SDK only), and OpenClaw is a chat-app assistant gateway whose ACP bridge rejects
per-session MCP. `dsh` did show the right shape — genuine Claude Code and Codex as
sub-agents on their own logins, worktrees for writers — and this design brings that
shape to OpenCode through the hub instead of adopting `dsh`.

## What exists today

- OpenCode v2.3.2 loads the hub MCP server (`mcp/server.mjs`).
- `ask_agent` runs one ACP turn on `claude`, `codex` or `opencode`; `sessionId`
  continues an earlier conversation; `background: true` returns a job id read with
  `job_status` / `job_result` / `job_cancel`. Jobs live in memory and die with the
  MCP server process (i.e. with the OpenCode session).
- `job_status` reports the last tool from the finished run's `output.tools`, and while
  a job runs falls back to `results/inflight/<pid>.json` when the pids match
  (`withLiveJobDetails` in `mcp/server.mjs`).
- Each turn is one hub-acp process plus one adapter process; follow-ups reconnect with
  `--continue`, which already picks `session/resume` or `session/load` by capability.
- The hub answers `session/request_permission` automatically by policy
  (`acp/acp-client.mjs` `makePermissionHandler`); nobody is asked.
- `deny`/`allow-reads` are rejected before startup for every adapter except native
  OpenCode (`acp/readonly.mjs`, `permissionSafetyReason` in `acp/consent.mjs`). The
  motivation is the 2026-11-16 benchmark
  ([opencode-vs-hub](../../benchmarks/opencode-vs-hub-2026-11-16.md)), in which Claude,
  Codex and OpenCode wrote files under `allow-reads` without sending permission requests.
- `agents.json` declares `permissionModes.attended` (Claude `acceptEdits`, Codex
  `workspace-write`, OpenCode `build`) but no code reads it yet.
- The MCP default budget is $3 per turn (`DEFAULT_BUDGET_USD`); hub-acp's own CLI
  default is $0.50 (`acp/hub-args.mjs`).
- Worktrees exist (`acp/worktree.mjs`) and are required for `fanout` with `allow-all`,
  but `ask_agent` has no `worktree` option. `tree-lock.mjs` rejects a second
  `allow-all` writer on the same tree.
- `acp-client.mjs` implements `session/load` and `session/resume`.

The gaps are therefore **visibility, conversation management and live control**, not
the transport.

## Goals

1. **Named, persistent sessions.** Every Claude Code / Codex conversation the owner
   starts from OpenCode has a short label, survives closing OpenCode, and can be
   listed, resumed and closed by label.
2. **See what they are doing.** While a turn runs: current tool, recent agent text,
   elapsed time, spend. After: the full conversation of any session, readable from
   OpenCode on demand, paginated.
3. **Control.** Cancel a running turn; change model or effort for the next turn; queue
   a follow-up while a turn runs (ACP allows one prompt in flight per session).
4. **Ask the owner, when asked.** An attended policy in which an agent's permission
   request is held and shown to the owner in OpenCode, who allows once or refuses.
   Unanswered requests are refused after a timeout.
5. **Safe parallel writers.** `ask_agent` accepts `worktree: true`; a writing turn
   whose tree is already claimed is placed in a worktree automatically and the owner is
   told where, instead of failing. A tree is claimed per turn, as today, not for a
   session's lifetime. A session started in a worktree stays in it for later turns.
   Merging a worktree back stays an explicit, separate step.
6. **Agent-to-agent.** The OpenCode model can hand one session's output to another
   ("send Codex's review to Claude") by reference to the source session's turn, not
   by re-pasting it.
7. **Phase 0 check of the native route.** Live-test OpenCode's built-in Claude Agent
   provider and the stored ChatGPT sign-in as plain OpenCode models, for quick
   questions that do not need a full agent. Record the result; no code depends on it.

## Non-goals

- No new GUI, web UI, daemon or always-running backend.
- No OpenCode fork or OpenCode plugin (rejected approach C).
- No replacement of the consent gate, audit log, budgets or routing.
- No live mirroring of a session into a separate pane; reading is on demand.

## Anti-goals (failure even if it works)

- Silent fallback from a subscription to paid API billing.
- Credentials, tokens or `.env` contents copied between apps or written into
  transcripts or the audit log.
- Presenting the attended policy as a sandbox: it only governs requests the adapter
  actually sends. Claude/Codex writes that bypass permission requests remain possible.
- Personal or machine-specific data committed to `agent-hub/` (public repo).

## Constraints

- Windows native is the deployment; no new WSL boundary.
- MCP is request/response: no tool call may block the chat for long; anything long is
  a background job.
- One writer per working tree; worktrees for simultaneous writers.
- Default budget per MCP turn stays $3; spend reporting is best-effort, not a ceiling.
- One hub-acp process per turn stays (no long-lived per-session process): a held
  permission keeps that turn's process alive only for the turn.
- Persistent state goes in ignored paths (`results/`, `projects/logs/`), never in
  tracked files.

## Approaches considered

| | Approach | Trade-off | Decision |
|---|---|---|---|
| A | Claude and ChatGPT as OpenCode's own models (Claude Agent provider, ChatGPT sign-in) | Simplest, one history; but Codex becomes "a GPT model with OpenCode's tools", not real Codex; Claude Agent provider untested live | Kept only as the Phase 0 check |
| **B** | **Upgrade the hub bridge: real Claude Code / Codex over ACP, driven from OpenCode** | Full native agents on their own subscriptions, reuses tested code; helper sessions appear as tool calls, not native panes | **Chosen by the owner** |
| C | OpenCode plugin adding Claude Code / Codex as native sub-agents (the `dsh` pattern) | Nicest in-UI look; duplicates consent/audit/routing in new code, tied to a changing plugin API | Rejected |

## Design (decided parts)

### Session registry

A durable registry, owned by the hub, keyed by a hub session label (e.g.
`claude-auth-fix`) and mapping to: agent, ACP session id, cwd or worktree path,
model, effort, state (`idle`, `running`, `waiting-permission`, `closed`), created/last
activity, cumulative reported spend, and the job id of a running turn. Stored under
`results/` (ignored). The in-memory job registry stays; the durable registry is what
lets a session be continued after OpenCode restarts. Resuming uses the adapter's
`session/resume` or `session/load`, whichever it advertises; if neither, the session
is marked not resumable and the owner is told so.

*Builder's call (from review):* closing OpenCode kills the MCP process and therefore
cancels any running turn, as today. On the next start the registry marks such a
session `idle` with its last turn `cancelled` and clears the stale job id. Queued
follow-ups live in memory only; on restart they are dropped and listed as dropped in
`sessions`, never silently re-sent.

### Transcript capture

hub-acp already receives every `session/update`. It appends a compact record per
update (agent text, tool call title/kind/status, permission request and answer, stop
reason, spend) to a per-session transcript file under `results/`. Tool payloads are
truncated. No secret-pattern set exists in `acp/` today; *builder's call:* define one
small shared redaction module (paths matching `.env`/`.env.*` except `.env.example`,
mirroring OpenCode's `attendedEnv` rules, plus common token shapes such as `sk-…`,
`ghp_…`, `Bearer …`) and apply it to transcripts, registry and audit lines. The audit line in `runs.jsonl` gains the hub session label.

### MCP tools

Extend, don't multiply:

- `ask_agent`: add `label` (create or address a named session; replaces passing raw
  `sessionId`, which stays accepted), `worktree`, and permission value `ask`
  (attended).
- `sessions` (new): list sessions with state, agent, tree, model, last activity,
  spend; filter by agent/state.
- `session_log` (new): read a session's transcript, newest-first, paginated, with an
  option for only agent text.
- `job_status`: also return the last few agent messages and any pending permission
  request.
- `permission_answer` (new): answer a held request (`allow_once` | `reject`) by job id.
- `session_config` (new, or folded into `ask_agent`): set model/effort for the next
  turn of a named session.
- `session_close` (new): close a session and, for a worktree, report whether it has
  changes left.

Tool descriptions must tell the OpenCode model how to use them conversationally, as
the current ones do, so the owner keeps working in plain language.

### Attended permission flow (`permission: ask`)

When an agent sends `session/request_permission` under `ask`, hub-acp holds the
response, writes the request to the inflight file and transcript, and the job's state
becomes `waiting-permission`. `job_status` shows it; the OpenCode model asks the
owner; `permission_answer` releases it. If OpenCode's MCP client supports MCP
elicitation, the hub may ask directly instead; that is an optimisation behind a
capability check, not a requirement. Timeout (default 5 minutes) → reject, recorded.

*Builder's calls (from review):*
- `ask` is write-capable for consent and locking: it needs the same grant as
  `allow-all` and takes the tree lock.
- `ask` requires `background: true` (a foreground call blocks the OpenCode model, so it
  could never call `permission_answer`); a foreground `ask` is rejected with that reason.
- The turn timeout pauses while a request is held, so a held request cannot kill the
  turn before the owner answers.
- The native mode `ask` forces comes from `permissionModes.attended` in `agents.json`,
  which this work starts reading.

*Owner's decision (2026-11-22): ask for commands and risky actions.* File edits inside
the working tree proceed on their own; shell commands and anything outside the tree
wait for the owner. Concretely the attended modes stay Claude `acceptEdits`, Codex
`workspace-write`, OpenCode `build`. The hub's `ask` handler auto-allows requests whose
tool kind is an in-tree edit or read and holds everything else (`execute`, `fetch`,
`other`, and any edit whose path is outside the tree or worktree). Whichever requests
an adapter never sends cannot be held; acceptance 4 documents each adapter's actual
behaviour.

### Agent-to-agent handoff

`ask_agent` accepts a reference such as `from: {label, turn}` that the hub expands
into the target prompt from the source transcript, within the existing prompt cap,
with a pointer to the full transcript for anything longer.

### Phase 0

Before building: run the live check of approach A (Claude Agent provider; ChatGPT
models) and of each adapter's resume capability (`claude-agent-acp@0.101.0`,
`codex-acp@2.6.0`). Record results in `docs/benchmarks/`. A missing resume capability
changes only how goal 1 is met for that agent, not the design.

## Acceptance (live, on this machine)

1. From OpenCode, start a labelled Claude session and a labelled Codex session on
   different repos; close and reopen OpenCode; list both; continue each with a
   follow-up that depends on the earlier turn.
2. During a long background turn, `job_status` shows the current tool and recent
   text; afterwards `session_log` shows the conversation.
3. Cancel a running turn; the session stays usable for the next prompt.
4. Under `ask`, a permission request reaches the owner, a refusal is honoured and
   audited, and an unanswered one times out as refused — for each adapter that sends
   requests; adapters that do not are documented as such.
5. Two writers on one repo: the second is placed in a worktree; neither blocks.
6. Hand Codex's review to Claude by reference; Claude's answer addresses it.
7. No credential appears in transcripts, registry or audit log (grep check).
8. Existing hub tests still pass.

## Left to the builder

File names and layout under `results/`, registry format, transcript record schema and
truncation limits, pagination sizes, label rules, exact tool schemas, and how the
registry is locked against two OpenCode windows writing at once.
