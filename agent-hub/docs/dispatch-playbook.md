# Dispatching work without getting stuck

Written 2026-11-03 after a Claude Code session in this workspace deadlocked
itself with four `ask_agent` calls plus an unanswered question. Everything
below was checked against the code at that moment, not remembered.

## The three facts that cause most of the pain

**1. `ask_agent` calls are serialized per working tree, not per hub.**

`mcp/server.mjs` keeps one queue per resolved `cwd` (`treeQueues`). Two calls
on the same tree run one after the other; calls on different repos run in
parallel; reads (`status`, `agents`, `route` without `run`) never queue at all.

That was not always true. Until 2026-11-03 there was a single global promise
chain, so four `ask_agent` calls in one turn were a four-deep line, each
burning its own timeout while the rest waited. That is the failure this page
came from. `fanout` is still the cheaper way to send one prompt to several
agents — it spawns them together and can give each its own worktree.

**2. A timeout cancels the turn, and says whether the cancel was acknowledged.**

`hub-acp` sends `session/cancel` and then waits (`HUB_CANCEL_WAIT_MS`, default
8000 ms) for the turn to end or the process to exit. The audit line carries
`cancelAck`:
- `true` — the callee confirmed by ending the turn. The tree is yours.
- `false` — nothing confirmed. The tree may still be changing, and the tool
  result says so.

`false` is not paranoia: OpenCode's work runs inside the shared
`opencode serve` daemon even when the hub launches it natively
(`opencode.cmd acp`), so killing the client does not necessarily stop the
session. Verified on 2026-11-03 — a call on one repo recorded `timeout` at
23:27:18 and its session kept editing `figure/*.kt` at 23:34-23:35 and running
Gradle at 23:37.

**3. A running turn is visible while it runs.**

`workspace-panel/logs/runs.jsonl` only gets its line when the turn ends. In the meantime each
run writes `results/inflight/<pid>.json`, and `hubctl status` (and the MCP
`status` tool) shows it on the `running` line: agent, repo, age, last tool.
That line is the answer to "what is happening right now".

## Rules

1. **Ask first, dispatch second.** Never put an `AskUserQuestion` in the same
   turn as long agent calls. The question renders behind the running tools, and
   typing a reply just enqueues it (`queue-operation enqueue`) while the turn
   stays blocked on the tools. Decide the scope, *then* dispatch.
2. **Parallel across repos, serial within one.** N repos at once is fine since
   2026-11-03; two calls on the same `cwd` still wait for each other, so don't
   aim two agents at one tree. When in doubt, `fanout --worktree`.
   **Native GUI exception (verified 2026-11-08):** separate repositories do not
   isolate the Windows desktop. Serialize tests that move the real pointer or
   claim window focus; simultaneous native smoke runs in two projects lost clicks.
   Build/code sessions may overlap, but final mouse/keyboard verification must
   run one app at a time. Headless browser checks can remain independent.
3. **Size the timeout to the job, and use a background job for the long ones.**
   A repo-sized task needs 30-40 minutes of wall time, and a foreground tool
   call blocks the chat for exactly that long. `ask_agent({background: true})`
   returns a job id immediately; `job_status` polls it, `job_result` collects
   it. That is the shape to use for anything over a couple of minutes:
   ```
   ask_agent(agent=opencode, cwd=..., permission=allow-all, background=true, prompt=...)
   job_status(job_ab12cd34)     # running, 6m, last tool: patch ...
   job_result(job_ab12cd34)     # the answer, or "not ready yet"
   ```
   The same thing from a terminal, without MCP:
   ```bash
   node acp/hub-acp.mjs --agent opencode --prompt "..." --timeout 2400000 --json
   # then, from the Windows side where loopback works:
   hubctl status
   ```
4. **After a timeout, read `cancelAck` before touching the tree.** `false`
   means the callee never confirmed it stopped. Check `git -C <repo> status
   --short`, `git log -3`, and the tail of `workspace-panel/logs/runs.jsonl`.
5. **One orchestrator per tree.** Not just a hub rule: a `running` line or a
   dirty tree from a previous attempt means the tree is already somebody's.
6. **Let the chain pick the model; name one only to pin it.** The paid Go
   DeepSeek is the default; when its pool reports exhaustion the hub drops to
   the free variant (same weights), then to the cheaper paid models. If you
   pass `model`, you get that model or an error — which is right for a
   benchmark, wrong for delegating work.
7. **One commit-sized outcome per delegation.** The prompts that timed out on
   2026-11-03 asked for three features, a screenshot and a report in one call.
   Split by outcome ("river bank colour + verify + commit") and each call
   finishes inside its budget with something to show. A prompt that needs a
   discursion to answer is two prompts.
8. **Raise `budgetUsd` for anything bigger than a quick question.** `ask_agent`
   and `route(run=true)` cancel the turn once reported cost crosses this many
   dollars — default **3**, which is already a deliberate raise from hub-acp's
   own CLI default of 0.5 (sized for an ad hoc terminal question, not a
   dispatch). Three real one-commit dispatches on 2026-11-04 (a Godot physics
   tune, a Kotlin figure plus tests, a lighting bugfix) cost $0.51-$1.48 each —
   comfortably inside 3, but not inside 0.5. A budget cut ends the turn cleanly
   (not a crash, `stopReason` still reports normally) and, with
   `permission: allow-all`, leaves the same salvage file a timeout does — read
   it the same way, per rule 4.
9. **A dispatched task that touches a web UI verifies with `agent-browser`,
   not by trusting the diff.** `ask_agent`/`startJob` pass no `mcpServers` by
   default (`hub-acp.mjs --mcp` is opt-in, nobody sets it), so a dispatched
   session has none of this orchestrator's MCP tools — no Playwright, nothing
   — only its own Bash and whatever is on PATH. `npx agent-browser open
   <url>`, `snapshot -i`, `click @ref` (vercel-labs/agent-browser: a Rust CLI,
   accessibility-tree snapshots with refs, no screenshots) needs nothing
   wired in and gives that session an actual way to open the page it just
   built and look at it, matching this repo's own rule for UI work ("start
   the dev server and use the feature in a browser before reporting done").
   Put it in the prompt's definition of done, e.g. "...then `agent-browser
   open http://localhost:PORT`, confirm X renders, close it, commit." Not
   a fit for `agent-desktop` (same vercel-labs family, native desktop apps):
   nothing here is dispatching work that drives a native app's UI yet.

## Recovering a turn that is stuck on pending tools

Symptom: the chat shows running tools forever, typed messages disappear, and
the transcript shows tool calls with no `tool_result`.

1. Look at `hubctl status` — the `running` line names the agent, the repo and
   the last tool. That is what the chat is waiting on (and, since 2026-11-03,
   the only place that shows it: `runs.jsonl` stays silent until the end).
2. Stop the turn in the panel (Stop button / `Esc`). The queued message then
   fires — check what it was before it does, cancel it if it was only an
   attempt to unblock.
3. If a run is still listed after the panel is idle, it is a live `hub-acp`:
   leave it to finish (it will write its audit line and clean its inflight
   record) or kill that PID, not "all node".
4. Inspect the target repos for uncommitted work (rule 4) before anything else
   touches them.
5. If the answer to the stuck question was simply "yes, proceed", do the
   irreversible step **yourself** rather than waiting on the card — a tag push
   or a release does not need an orchestration session alive.

## The 2026-11-03 case, as numbers

- 23:06:46-23:07:08 — four `ask_agent` calls (four different repos,
  opensidian) with `timeoutMs=600000`, plus one `AskUserQuestion`, all in one
  turn.
- 23:17 and 23:27 — first two calls time out at ~600 s. Calls 3 and 4 had not
  even started yet.
- 23:29 — a message typed while blocked, enqueued, never consumed.
- 23:34 — still blocked: two `ask_agent` running/serialized, one question
  invisible.
- Cost: ~40 minutes of orchestrator time and two dirty working trees, for
  zero committed results.

## What changed because of it (2026-11-03, same day)

| Fix | Where | Test |
|---|---|---|
| Per-tree queues instead of one global chain; reads never queue | `mcp/server.mjs` | `mcp/tests/end-to-end.test.mjs` — "calls on different trees overlap", "status answers while a long turn is still running" |
| Timeout sends `session/cancel`, waits for the turn to end, records `cancelAck`/`cancelWaitMs`, tree-kills instead of killing one pid | `acp/hub-acp.mjs`, `acp/acp-client.mjs` | `acp/tests/cancel.test.mjs` — one agent that acknowledges, one that does not |
| A running turn is visible: `results/inflight/<pid>.json` + `hubctl status` `running` line | `acp/hub-acp.mjs`, `hubctl/hubctl.mjs` | `acp/tests/cancel.test.mjs`, `hubctl/tests/hubctl.test.mjs` |
| The trap is stated where the model will read it: the `ask_agent` tool description | `mcp/core.mjs` | `mcp/tests/core.test.mjs` (tools/list) |
| A timeout's tool result names the path and says the tree may still change | `mcp/core.mjs` | — |
| A pool that reports exhaustion is retried on the registry's `modelFallbacks` (paid DeepSeek → free, then the cheaper paid models); explicit `model` never substituted | `acp/router.mjs`, `mcp/server.mjs`, `agents.json` | `acp/tests/router.test.mjs` (incl. "the shipped registry puts the paid DeepSeek before the free one"), `mcp/tests/end-to-end.test.mjs` |
| A failed write run leaves a salvage file (HEAD, `git status`, diffstat) and the result points at it | `acp/hub-acp.mjs` | `acp/tests/cancel.test.mjs` — "a failed write run records what it left in the tree" |
| The tree-lock warning reaches the caller instead of only stderr | `acp/hub-acp.mjs`, `mcp/core.mjs` | — |
| Background jobs: `ask_agent({background:true})` + `job_status`/`job_result`/`job_cancel`, one tree at a time, cancelled with the same cancel-and-wait | `mcp/jobs.mjs`, `mcp/server.mjs`, `mcp/core.mjs` | `mcp/tests/jobs.test.mjs`, `mcp/tests/end-to-end.test.mjs` — "a background delegation returns an id", "a second job on a busy tree is refused" |
| A job carries its id into `results/inflight`, so `hubctl status` names the same job the chat is polling | `acp/hub-acp.mjs`, `hubctl/hubctl.mjs` | `mcp/tests/end-to-end.test.mjs`, `hubctl/tests/hubctl.test.mjs` |
| `job_cancel` waits for the process to exit and reports `ack`; unacknowledged means the tree may still change | `mcp/jobs.mjs`, `mcp/core.mjs` | `mcp/tests/jobs.test.mjs` — "a job that ignores the kill" |
| `budgetUsd` exposed on `ask_agent`/`route(run=true)`, default raised to 3 (hub-acp's own CLI default, 0.5, is never silently inherited) | `mcp/core.mjs`, `mcp/server.mjs` | `mcp/tests/end-to-end.test.mjs` — "budgetUsd raises or lowers the cap a caller actually gets", "a budget-exceeded run still names what it left in the tree" |
| A background job's pinned `model` no longer sends `--model` twice (base args built with `model: null`; only the per-attempt retry loop adds it) | `mcp/server.mjs` | `mcp/tests/end-to-end.test.mjs` — "a background job with an explicit model sends --model exactly once" |

The async job API landed on 2026-11-04 (`ask_agent({background:true})` plus the
three `job_*` tools), which is what makes rule 3 practical rather than
aspirational. Jobs live in the MCP server process on purpose: its death ends
them, while `hubctl status` keeps showing the run through the inflight file.
