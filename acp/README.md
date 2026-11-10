# acp — Agent Client Protocol transport

STATUS: active

The hub's ACP path: instead of each worker getting its own bespoke CLI
wrapper, the hub acts as an **ACP
Client** and every managed agent runs as an **ACP Agent** subprocess over
stdio. One independent session per agent; ACP itself has no concept of
multi-agent coordination, so routing and fan-out are the hub's own work —
`fanout-acp.mjs` does the mechanical parallel dispatch, `router.mjs` picks
one worker per task by cost/complexity (see Routing below).

This implements the ACP half of the hub design: the hub is the Client,
each managed agent is an Agent subprocess over stdio, and every session
is 1:1. On top of that it adds the hub-side pieces ACP deliberately does
not provide: parallel fan-out (with an optional synthesis turn) and a
health/cost-aware router.

Spec: <https://agentclientprotocol.com> — **v1 is pinned**. v2 exists only
as a draft; the client refuses to talk to an agent that answers with any
other major version instead of silently drifting.

## Layout

    acp/
      acp-client.mjs    stdio transport, JSON-RPC dispatch, permissions
      hub-acp.mjs        CLI: consent -> spawn -> initialize -> session -> prompt
        hub-env.mjs        paths, limits and AGENT_HUB_* overrides
        hub-args.mjs       usage text, argument parsing, prompt input
        registry.mjs       agent registry and MCP server config
        run-record.mjs     audit line, in-flight file, salvage record
      fanout-acp.mjs     CLI: N agents in parallel, one merged result
      router.mjs         CLI + facade (re-exports the router-* modules): pick one worker by cost/complexity, hand off to hub-acp.mjs
      router-config.mjs  paths and thresholds shared by the router modules
      router-stats.mjs   24 h audit-log stats per routing target
      router-decide.mjs  routing rules: prompt signals, health overlay, model pick
      router-failover.mjs agent and model fallback chains, quota detection
        quota.mjs          the one definition of "out of quota"
        handoff.mjs        relay prompt (git state, recent runs, the task)
      consent.mjs        grant, limits and today's spend
      spend-estimate.mjs Codex cost estimate counted against its daily cap
      agents.json        registry: launch command per agent, per platform
      README.md

Zero dependencies — Node's own `child_process`, `readline`, and `fs` are
the whole transport. No SDK, nothing to install.

## Use

From Windows, where all three agents run natively:

    node agent-hub/acp/hub-acp.mjs --list

    node agent-hub/acp/hub-acp.mjs --agent opencode \
      --model opencode-go/deepseek-v4.1-flash \
      --prompt "Reply with exactly: ACP_OK"

    node agent-hub/acp/hub-acp.mjs --agent claude --prompt -
      # reads the prompt from stdin when - is given or stdin is piped

    node agent-hub/acp/hub-acp.mjs --agent claude --probe --verbose

Options that matter:

| Option | Meaning |
|---|---|
| `--agent NAME` | registry entry (required unless `--list`) |
| `--cwd DIR` | session working directory; translated to a WSL path when the agent runs there |
| `--load SESSION_ID` | resume via `session/load` — replays history first; requires `loadSession` |
| `--resume SESSION_ID` | resume via `session/resume` — no replay; requires the `resume` capability |
| `--mcp FILE` | MCP servers to pass at `session/new` (see below) |
| `--permission` | `deny` (default), `allow-reads`, `allow-all` |
| `--budget USD` | cancel when the reported cost crosses this (default 0.50, `0` disables) |
| `--timeout MS` | prompt-turn timeout (default 300000) |
| `--config ID=VALUE` | set any session config option; `--model` is shorthand for `--config model=...` |
| `--json` | one machine-readable result object on stdout |
| `--probe` | initialize + `session/new`, print capabilities/options, no prompt |

Exit codes: `0` answered, `1` denied/rejected/failed,
`2` timed out.

### Session resume

    node agent-hub/acp/hub-acp.mjs --agent opencode --resume ses_... --prompt "..."
    node agent-hub/acp/hub-acp.mjs --agent opencode --load   ses_... --prompt "..."

`--resume` reconnects without replaying the conversation; `--load` replays
it first (those replay updates are counted and suppressed, so the answer
is only the new turn). Both need the agent's matching capability — all
three agents advertised `loadSession` and `sessionCapabilities.resume`
on 2026-10-29. Use the same `--cwd`, and pass `--model`/`--config` again
if the session doesn't retain its config. Session ids are in each result
header and in `logs/runs.jsonl`.

## Registry

[`agents.json`](agents.json) maps a worker name to an ACP launch command.
Entries can override `command`/`args` per platform, because the agents do
not all live in the same environment:

- **opencode** — `opencode acp` natively on Windows (`opencode.cmd acp`)
  since 2026-11-09; the WSL launcher and its `pathStyle` were retired because
  OpenCode 2.2.6 is installed natively.
- **claude** — Claude Code is not itself an ACP server; the first-party
  adapter `@agentclientprotocol/claude-agent-acp` wraps the Claude Agent
  SDK. It needs Claude credentials in the environment that runs it.
- **hermes** — removed from the registry on 2026-11-08. The binary remains
  installed as a manual experiment; its free models answer text but their
  tool use is not dependable.

`--list` reports whether the launcher resolves on this platform. For
`npx`-based entries that means the launcher exists, not that the package
is cached yet.

## Fan-out

    node agent-hub/acp/fanout-acp.mjs --agents opencode,claude \
      --config opencode:model=opencode-go/deepseek-v4.1-flash \
      --prompt "..."

Each selected agent runs through `hub-acp.mjs` in its own child process,
so it gets exactly the same consent gate, audit line, permission policy,
budget, and per-agent result file as a single run. All children are
started before any is awaited, so the agents actually overlap; one
failure does not abort the rest.

`--config NAME:ID=VALUE` targets a single agent (`--config ID=VALUE`
applies to every agent). By default the merged result is Markdown with a
status/stop/time/cost table and one section per agent, saved as
`results/<stamp>-fanout-acp.md`. `--synthesize AGENT` adds one extra turn
that merges the successful answers into a **Synthesis** section while
keeping every source answer below it visible; it needs at least two
successful answers, uses the same per-agent config as that agent, and
runs with a larger prompt ceiling (24k chars) because it carries the
answers. It is still not a free operation — one more model call.

`--json` returns the same data, including the `synthesis` object when
requested.

`--worktree` isolates parallel editors. Before any agent starts, each one gets
its own `git worktree add --detach` checkout under
`<git-dir>/agent-worktrees/<stamp>-<agent>`, and its session `--cwd` points
there, so two agents cannot overwrite each other's files. After the run, a
worktree with changes is **kept** and reported (JSON `worktree` /
`worktreeKept`, a "Kept worktrees" section in the merged file, stderr, and
`logs/runs.jsonl`); a clean one is removed. Worktrees start from `HEAD`, so
uncommitted changes in the main working tree are not copied in, and the
starting cwd must be inside a git repository. Without the flag, behaviour is
unchanged: every agent shares the cwd it was given.

Exit: `0` if at least one agent answered, `2` if every agent timed out,
`1` otherwise. A failed synthesis does not fail the fan-out if at least
one agent answered; the synthesis section shows the error and the sources
remain.

## Routing

    node agent-hub/acp/router.mjs --prompt "..."                # decide + run
    node agent-hub/acp/router.mjs --prompt "..." --explain       # decide only, no call, no cost
    node agent-hub/acp/router.mjs --prompt "..." --force claude  # skip the heuristic

Two workers are routing targets: `opencode` (cheap, fast) and `claude`
(expensive, strongest reasoning). Hermes was removed from the registry;
Codex is blocked by its adapter. The hub itself is the orchestrator — no
registered agent decomposes tasks.

The pick starts as a fixed rule list against the prompt text, not a model
call: escalate to `claude` on a **scope** signal (multi-file, breaking
change, migration, refactor, public API, "rename/move/delete across",
"several/multiple files") or a **consequence** signal (security,
vulnerability, credentials/secrets/tokens/passwords, permissions,
payments/billing, production), or on a very large prompt (> 1200 chars);
otherwise default to `opencode`. A classifier call would add cost and
latency to *every* routed prompt, including the cheap ones — the thing
routing exists to avoid. The verified cost/speed difference between the
two (`opencode` ~$0.0006-0.0008 and ~5s; `claude` ~$0.23 and ~12-13s —
roughly 300-400x the cost for a slower call, measured 2026-10-26/27) informed the default.
These are historical measurements, not current pricing or performance guarantees;
remeasure after provider or model changes. The router defaults
cheap and only step up on an explicit signal, not to guess with another
paid call. `--force` bypasses the heuristic entirely for a manual pick.

Difficulty words were removed on 2026-10-31. The bench had put 15 attempts
through the cheap worker — module rebuilds, prose specs judged by a hidden
test, a two-module construct — with no failure, so "code review", "debug",
"explain", "why", "edge case" and "trade-offs" were escalating ordinary
work to the weekly Claude quota. Scope and consequence survived because
they are about what a mistake costs, not about how hard the ask looks.

On top of the prompt rules, `router.mjs` reads the last 24 h of
`logs/runs.jsonl`: an agent with recent failures/timeouts (15 min) is
skipped in favour of a healthy one, and a prompt that would escalate to
`claude` stays on `opencode` once claude's 24 h spend passes
`--cost-ceiling` (default $2.00; `--force claude` overrides). Live
concurrency is not observable — a run only gets a log record when it
finishes — so this is health/cost-aware, not true load-aware.
`--no-health` disables the overlay; `--log FILE` points it at another
audit log.

**Failover (2026-10-31).** A pool that is out of quota is not a failed task:
when `hub-acp.mjs` exits non-zero and its error text looks like exhaustion
(`429`, quota, rate limit, weekly/monthly limit, insufficient credits), the
router runs the same prompt on the other pool and says so. The MCP `route` tool
does the same when `run: true`. `--no-failover` turns it off; with `--cwd` the next agent gets the tree context too (`--no-context` disables that). The predicate is
`isQuotaError` in `router.mjs`; it deliberately does not fire on timeouts or
syntax errors, which a second pool would not fix.

Every `hub-acp.mjs` flag (`--cwd`, `--mcp`, `--permission`, `--budget`,
`--timeout`, `--config`, `--json`, `--no-save`, `--verbose`) passes
through unchanged — this file only owns the `--agent` choice. Verified
live 2026-10-27: a plain question routed to `opencode` and completed end
to end (`ROUTER_LIVE_OK`, 42.7s — slow because of an unrelated upstream
503 that OpenCode's own retry logic absorbed, not a router issue);
`--explain` escalated scope and consequence prompts to `claude` with no
agent call and no cost, and left difficulty prompts on `opencode` (the
rule list changed on 2026-10-31; see above). The health/cost rules are
covered by `tests/router.test.mjs` (synthetic audit logs, no model call).

Still not done: live load awareness (no signal for "busy right now"),
and true synthesis *inside* routing — combining answers is
`fanout-acp.mjs --synthesize`, below.

## MCP

MCP servers are passed to the agent in `session/new` — that is ACP's own
integration point, no hub-side bridge needed for this part. `--mcp` takes
either the ACP array or `{ "mcpServers": [...] }`:

```json
{
  "mcpServers": [
    {
      "name": "filesystem",
      "command": "/absolute/path/to/server",
      "args": ["--stdio"],
      "env": { "API_KEY": "..." }
    },
    { "type": "http", "name": "remote", "url": "https://…/mcp", "headers": [] }
  ]
}
```

Before creating the session the client checks the agent's advertised
`mcpCapabilities`: HTTP/SSE entries are refused when the agent didn't
advertise that transport. Stdio needs no capability (all agents must
support it). `env` accepts either ACP's `[{name,value}]` array or a plain
object, which is normalized.

MCP command paths are resolved **inside the agent's environment**, not the
hub's — use paths as that agent sees them (Windows paths when OpenCode runs
natively; WSL paths only for agents launched inside WSL).

**Baseline: none.** The hub passes no MCP servers unless `--mcp FILE` is
given. The agents already have their own MCP configuration, so a hub-wide
default would duplicate tool sets and credentials; per-task is the
deliberate default. Revisit if a task needs a server every agent should
see.

Verified end-to-end (2026-10-26): OpenCode connected to a throwaway stdio
MCP server passed through `--mcp` (`initialize` → `tools/list` →
`tools/call`), the model called its `hub_ping` tool, and the answer was
the tool's `HUB_MCP_OK`.

## Permissions, consent, audit

- **Permission requests.** ACP's baseline client method is
  `session/request_permission`. The hub answers from `--permission`
  instead of a human. `deny` picks `reject_once` (or `cancelled` if the
  agent offered no reject option); `allow-reads` allows only tool kinds
  `read`/`search`/`fetch`/`think`; `allow-all` picks `allow_once`
  (never `allow_always` on its own). OpenCode executes its own built-in
  tools without asking, so the policy only sees requests the agent
  chooses to raise — it is not a sandbox. The default stays `deny`.
- **Consent gate.** The `../consent.json` check —
  enabled, overseer-acknowledged, unexpired — and it runs
  before anything spawns, including `--probe`.
- **Audit.** One JSON line per run in `../../logs/runs.jsonl` (shared
  by every entry point). Records include status, session id, stop reason,
  duration, cost when reported, permission decisions, and a truncated
  prompt/output. `logs/*.jsonl` and `results/` are gitignored.
- **Results.** Non-empty answers are saved to
  [`../results/`](../results/) as `<stamp>-<agent>-acp.md`, with the
  session id and stop reason in the header. `--no-save` skips this.
- **Budget.** `usage_update.cost` is cumulative per turn; when it crosses
  `--budget`, the hub sends `session/cancel`. Agents that don't report
  cost can't be capped.
- **Timeout, cancel and model fallback.** On `--timeout` the hub sends
  `session/cancel` and waits up to `HUB_CANCEL_WAIT_MS` (default 8000) for the
  turn to end or the process to exit. The audit line records `cancelAck`
  (`true`/`false`) and `cancelWaitMs`; `false` means nothing confirmed the stop
  and the working tree may still be changing. `AcpClient.close()` then
  tree-kills on Windows (`taskkill /T /F`) rather than signalling a single pid,
  because the child is usually a wrapper (`cmd.exe`, `wsl.exe`). A
  daemon-backed agent (OpenCode via `opencode serve`) can still outlive that;
  `cancelAck: false` is the warning.
- **Models.** The audit line carries the `model` the agent reported. A free
  pool that reports exhaustion is retried on the registry's `modelFallbacks`
  (`router.mjs` and the MCP ask path), one audit line per attempt; an explicit
  `--model` is never substituted. See `docs/routing.md` for the price order.
- **In flight.** While a turn runs, `results/inflight/<pid>.json` carries the
  agent, cwd, start time, session id, model and last tool; it is deleted on
  exit. `hubctl status` renders it as the `running` line.
- **Salvage.** A failed or timed-out run with `--permission allow-all` writes
  `results/<stamp>-<pid>-<agent>-salvage.json` with the HEAD, branch,
  `git status --porcelain` and `git diff --stat` of the tree it was working in,
  and the tool result points at it.

**Not a sandbox (decided 2026-10-29).** The client advertises no `fs/*`
or `terminal/*` capabilities, so the hub does not proxy file or shell
access; each agent uses its own tools with `cwd` as its workspace. The
controls are the consent gate, the default-deny permission policy, and
the per-run budget. Enforcing a filesystem root would mean implementing
those capabilities (or running the agent in a container); not planned
until a task needs it.

## Verified 2026-10-26/27

| Agent | Result |
|---|---|
| OpenCode 2.1.4 (WSL) | full turn, `ACP_OK`, ≈$0.001; MCP tool round-trip |
| OpenCode via `wsl.exe` (hub on Windows) | full turn, `WIN_WSL_ACP_OK`; cwd `D:\Workspaces\AgentHub` → `/mnt/d/Workspaces/AgentHub` |
| OpenCode 2.2.6 (native Windows, 2026-11-09) | probe ok; full turn `OPENCODE_NATIVO_OK`, 12.2 s; `doctor` 14 ok / 0 fail |
| Claude adapter 0.97.0 (Windows) | **Full turn, 2026-10-27: `CLAUDE_ACP_RETEST_OK`, 12.9s, $0.2275.** The two earlier failures (23:32 `session limit · resets 12:50am`, 00:06 a 120s timeout still inside that same window) were the account's own session limit, not a transport bug — confirmed by retrying after the reset: same latency as the `hub.ps1` CLI path (11.6s), clean response. Likely self-inflicted by running several Claude-backed processes against the same account at once. |
| Hermes 0.22.5 (Windows, histórico) | full turn, `HERMES_ACP_OK`; se retiró del registro el 2026-11-08 |
| Fan-out: OpenCode + Hermes + Claude (Windows) | 2/3 answered in parallel (`FANOUT_OK`, 7s / 42s); Claude timed out at 120s; merged file written, exit 0 |
| Fan-out `--json` (OpenCode + Hermes) | both answers + statuses/costs parsed by the caller |
| `fanout --synthesize` (OpenCode + Hermes, 2026-10-29) | synthesis section produced (`SYNTH_OK`), both source answers kept below it, exit 0 |
| Session resume (`--resume` / `--load`, OpenCode, 2026-10-29) | remembered `417` across a new process in both modes; `sessionMode` recorded |
| Edit task (OpenCode, `-Permission allow-all`, scratch folder, 2026-10-29) | added `multiply` + its test, ran `node --test`; independent re-run 2/2 pass |
| Edit task (Claude, `-Permission allow-all`, scratch folder, 2026-10-29) | two edits, 5 permission requests (2 edit / 3 execute), 9 tool calls, $0.3041; independent re-run 2/2 pass |
| Edit task (Hermes, `-Permission allow-all`, scratch folder, 2026-10-29) | two edits, 2 edit permission requests, 8 tool calls, no reported cost; independent re-run 2/2 pass |
| `--worktree` fan-out (2026-10-29) | per-agent checkout created before start; clean one removed, changed one kept and reported |
| Test suite (2026-10-29) | 41 tests pass |

`--probe` is the cheap regression check; a full turn costs a model call.
OpenCode's free model can hit its provider's free-tier quota — pass
`--model` to use a paid model for a run.

## Tests

    node --test agent-hub/acp/tests/*.test.mjs

Zero dependencies, zero model calls: health/cost routing decisions against
synthetic audit logs, permission policies, Windows→WSL path conversion,
fan-out Markdown + synthesis-prompt rendering, and the worktree lifecycle
(create, detect changes, remove) against a throwaway git repo.

## Not done yet

- **CLI fallback stays (decided 2026-10-29).** All three agents now have a
  verified ACP edit path (OpenCode, Claude, Hermes), so the fallback no longer
  covers an unverified gap. It is kept as a recovery path if an ACP adapter
  (the `npx` Claude adapter, Hermes's ACP extra) breaks, but only OpenCode is
  verified through it: treat ACP as the supported edit path.
- **Live load.** Routing reads failures and spend from the audit log, but
  there is no signal for how busy an agent is *right now*, so true
  load-aware routing remains unbuilt.
- **Richer prompt content.** Only text blocks are sent; image, audio,
  and embedded resources are optional capabilities and not wired up.
- **Claude credentials.** This WSL environment has none; run the hub on
  Windows for the `claude` entry (as verified), or authenticate a WSL
  Claude install. Hermes has the same environment constraint.
