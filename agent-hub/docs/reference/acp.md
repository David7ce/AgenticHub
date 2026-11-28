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
      config.mjs        shared runtime path resolution for execution and diagnostics
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

Zero dependencies — Node's own `child_process`, `readline`, and `fs` are
the whole transport. No SDK, nothing to install.

## Use

From Windows, where all three agents run natively:

    node acp/hub-acp.mjs --list

    node acp/hub-acp.mjs --agent opencode \
      --model opencode-go/deepseek-v4.1-flash \
      --prompt "Reply with exactly: ACP_OK"

Options that matter:

| Option | Meaning |
|---|---|
| `--agent NAME` | registry entry (required unless `--list`) |
| `--cwd DIR` | session working directory; translated to a WSL path when the agent runs there |
| `--load SESSION_ID` | resume via `session/load` — replays history first; requires `loadSession` |
| `--resume SESSION_ID` | resume via `session/resume` — no replay; requires the `resume` capability |
| `--continue SESSION_ID` | whichever of the two the agent advertises (resume preferred); what a follow-up should use |
| `--mcp FILE` | MCP servers to pass at `session/new` (see below) |
| `--permission` | `deny` (default) and `allow-reads` currently fail closed; `allow-all` is write-capable and requires a grant |
| `--budget USD` | cancel when the reported cost crosses this (default 0.50, `0` disables) |
| `--max-context N` | cancel when the reported context window crosses N tokens; the grant's `maxContextTokens` is a ceiling this can only tighten |
| `--timeout MS` | prompt-turn timeout (default 300000) |
| `--config ID=VALUE` | set any session config option; `--model` is shorthand for `--config model=...` |
| `--json` | one machine-readable result object on stdout |
| `--probe` | initialize + `session/new`, print capabilities/options, no prompt |

Exit codes: `0` answered, `1` denied/rejected/failed,
`2` timed out.

### ACP permission safety

Claude Code, Codex and OpenCode each executed a write during live `allow-reads`
tests without sending an ACP permission request. Consequently the hub now
**rejects `deny` and `allow-reads` dispatches for every adapter before startup**,
including probes. This is a fail-closed mitigation, not read-only support.
An `allow-all` run remains possible only within the existing consent grant and
must be treated as write-capable; it is not read-only access.

The hub's permission handler can respond only to requests an agent actually
sends. Do not assume it or the working directory is an OS sandbox, and do not
assume other adapters enforce read-only behavior without independent tests.

### Requested native mode

`--config mode=plan` requests an adapter's native mode; available mode IDs
and their behavior depend on the adapter and its configuration. A registry
default `mode` is treated the same way; the last explicit config wins.
MCP `ask_agent` accepts the same native ID via its optional `mode` parameter
for both foreground and background jobs; results show the requested and
reported values. On a follow-up, the hub reapplies the mode requested in the
latest successful audit record for the same agent, session and working directory,
unless a mode is explicitly supplied. An explicit mode takes precedence.
If that latest record has no requested mode, or no matching record exists, no
mode is recovered from earlier records or inferred from what the agent reported;
registry defaults may still apply. Recovered modes are checked before the prompt
just like explicit requests, including when running a probe.
Results and audit records include `modeSource`: `explicit` for a caller's
choice, `restored` for a prior successful turn, `registry` for a registry
default, or `null` if no mode was requested. A successful MCP answer also
shows `none`/`unknown` when neither value is available; unknown is not a
confirmation.
After creating or reopening a session, the hub requires the response to the
mode-setting request to report the requested value before sending a prompt.
Missing or different values fail the run. The audit and JSON result distinguish
`requestedMode` and `reportedMode`; a matching value is the agent's report,
not independent verification of its permissions. When no mode was requested,
the hub records the mode reported by the adapter (or `null` if unknown), and
warns on resume; it does not select or enforce that mode.

During a turn, a reported mode change triggers cancellation, a bounded wait for
the turn to end or process to exit, and a failed result. If cancellation is not
acknowledged, the hub terminates the agent process and warns that the tree may
still be changing. Cancellation is not instantaneous and the agent might already
have acted; agents may also change behavior without reporting it.
Session creation, startup hooks, MCP services and resumed history occur before
the mode check. Native Plan is not an OS sandbox, does not protect credentials,
and does not change the permission gate above.

On 2026-11-16, live, grant-checked tests in separate temporary directories
confirmed the reported mode and a no-tools response both on a new session and
on resume, **reapplying the mode each time**: OpenCode 2.3.0 `plan`, Claude ACP
0.101.0 `plan`, and Codex ACP 2.6.0 `read-only`. They used `allow-all`, not an
enforced read-only policy, and did not test actual file access or mode changes
during a turn. Codex could not resume a probe-only session; resuming a session
after a prompt succeeded but displayed a warning about a possible model change
from `gpt-6.1-terra` to `gpt-6.1-sol`. The hub audit recorded the adapter's
reported model as `gpt-6.1-terra` for both turns; that does not independently
establish the model actually used. The warning needs separate investigation.
In a later probe of those same sessions, with no mode requested, OpenCode and
Claude reported `plan`, while Codex reported `agent`, not `read-only`. These
observations are specific to the tested sessions and versions. For Codex,
request `mode=read-only` when that behavior is wanted; on a follow-up the hub
reapplies it only if a matching successful audit record is available.

On 2026-11-17, one owner-authorized Claude ACP 0.101.0 test used `allow-all`
in a temporary working directory and requested a fictional plan and
`ExitPlanMode`. The adapter reported a change from `plan` to `default` during
the turn; the hub marked the run failed and reported cancellation
acknowledged. **Before cancellation, Claude wrote a plan in its normal home
plan directory and used ToolSearch despite the bounded prompt.** The plan
approval had already been allowed under the grant. This one observation does
not establish that other mode changes or adapters notify correctly, or that
cancellation prevents prior actions. No project files were targeted, and the
created plan was retained.

Probe output remains JSON on stdout even if the adapter emits a message during
resume; such messages are sent to stderr.

Code inspection explains a plausible timing difference, not the warning's
proven cause: the hub restores the model from the audit **after** `session/resume`
returns and before sending the prompt. In the installed Codex ACP 2.6.0,
`thread/resume` is called without an explicit model; the adapter then takes its
session's current model when constructing the `turn/start` request. The audit
therefore supports what the adapter reported before the prompt, but is not an
independent provider-side record of the model served.

On 2026-11-17, a separate real Codex ACP 2.6.0 session in a temporary
directory, within an existing `allow-all` grant, answered a no-tools prompt in
`read-only`, resumed with an explicit `agent` mode and recalled a synthetic
marker, then resumed again with `agent` restored and recalled the marker.
Both changes were reported by the adapter; this demonstrates this small
continuity flow, not a security boundary or a change during an active turn.
The model-resume warning appeared again.

On 2026-11-17, a metadata-only check of that specific synthetic Codex session's
local rollout found two `turn_context` entries, both recording
`gpt-6.1-terra` and `low` effort. This corroborates the hub audit with Codex's
own local turn metadata; it is not an independent provider-side response or
proof of the warning's cause. A separate
[upstream Codex issue](https://github.com/openai/codex/issues/32061) describes
similar resume warnings and model-default behavior in other CLI versions; it
does not prove the behavior of this ACP integration.

### Session resume

    node acp/hub-acp.mjs --agent opencode --resume ses_... --prompt "..."
    node acp/hub-acp.mjs --agent opencode --load   ses_... --prompt "..."

`--resume` reconnects without replaying the conversation; `--load` replays
it first (those replay updates are counted and suppressed, so the answer
is only the new turn). Both need the agent's matching capability — all
three agents advertised `loadSession` and `sessionCapabilities.resume`
on 2026-10-29. Use the same `--cwd`, and pass `--model`/`--config` again
if the session doesn't retain its config. Session ids are in each result
header and in `workspaces-panel/logs/runs.jsonl`.

## Registry

`acp/agents.json` (see [setup](../getting-started.md)) maps a worker name to an ACP launch command.
Entries can override `command`/`args` per platform, because the agents do
not all live in the same environment:

- **opencode** — `opencode acp` natively on Windows (`opencode.cmd acp`)
  since 2026-11-09; the WSL launcher and its `pathStyle` were retired because
  OpenCode 2.2.6 is installed natively.
- **claude** — Claude Code is not itself an ACP server; the first-party
  adapter `@agentclientprotocol/claude-agent-acp` wraps the Claude Agent
  SDK. It needs Claude credentials in the environment that runs it.
- **hermes** — removed from the registry on 2026-11-08, registered again on
  2026-11-11 so it can be reached through the same pinned list. `hermes acp --check` is OK (0.23.0), its grant in
  `consent.example.json` is **disabled** and it is not a routing target: its free
  models answer text but tool use is not dependable, and Nous may train on what
  it receives.

`--list` reports whether the launcher resolves on this platform. For
`npx`-based entries that means the launcher exists, not that the package
is cached yet.

## Fan-out

    node acp/fanout-acp.mjs --agents opencode,claude \
      --config opencode:model=opencode-go/deepseek-v4.1-flash \
      --permission allow-all --worktree --prompt "..."

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

Write-capable fan-out requires `--worktree` and a starting cwd inside a Git
repository. Each run must also pass its agent's existing consent grant; do not
widen a grant to make it run. Restricted policies currently fail closed, so
the default `deny` cannot launch a fan-out.

`--worktree` separates parallel editors' working trees. Before any agent starts, each one gets
its own `git worktree add --detach` checkout under
`<git-dir>/agent-worktrees/<stamp>-<agent>`, and its session `--cwd` points
there, so two agents cannot overwrite each other's files. After the run, a
worktree with changes is **kept** and reported (JSON `worktree` /
`worktreeKept`, a "Kept worktrees" section in the merged file, stderr, and
`workspaces-panel/logs/runs.jsonl`); a clean one is removed. Worktrees start from `HEAD`, so
uncommitted changes in the main working tree are not copied in, and the
starting cwd must be inside a git repository. Worktrees are not OS sandboxes:
agents may be able to access other files and services. The synthesizer, if
requested, receives a separate temporary working directory, which is retained
and reported for inspection; that directory is also not a sandbox and does not
limit the synthesizer's filesystem access.

Exit: `0` if at least one agent answered, `2` if every agent timed out,
`1` otherwise. A failed synthesis does not fail the fan-out if at least
one agent answered; the synthesis section shows the error and the sources
remain.

## Routing

    node acp/router.mjs --prompt "..."                # decide + run
    node acp/router.mjs --prompt "..." --explain       # decide only, no call, no cost
    node acp/router.mjs --prompt "..." --force claude  # skip the heuristic

Two workers are routing targets: `opencode` (cheap, fast) and `claude`
(expensive, strongest reasoning). Hermes is registered but disabled and never
routed; Codex is blocked by its adapter. The hub itself is the orchestrator — no
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
`workspaces-panel/logs/runs.jsonl`: an agent with recent failures/timeouts (15 min) is
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
  `session/request_permission`. The handler can reject requests or allow
  selected tool kinds, but agents can act without sending a request. Thus
  `deny` and `allow-reads` dispatches are rejected before startup; `allow-all`
  is write-capable and picks `allow_once` for requests it receives. Neither
  the handler nor a working directory is a sandbox.
- **Consent gate.** The `../consent.json` check —
  enabled, overseer-acknowledged, unexpired — and it runs
  before anything spawns, including `--probe`.
- **Audit.** One JSON line per run in `workspaces-panel/logs/runs.jsonl` (shared
  by every entry point). Records include status, session id, stop reason,
  duration, cost when reported, permission decisions, and a truncated
  prompt/output. `workspaces-panel/logs/*.jsonl` and `results/` are gitignored.
- **Tokens per turn.** ACP reports `cost`, not a token breakdown, so `usage`
  in the audit line is the difference between two reads of the agent's own
  store, keyed by session id: Claude's transcript messages, OpenCode's
  `session_v2` row, Codex's rollout. `confidence` says how it was read —
  `exact`, `turn`, `delta`, `session-total`, `time-window` — or `unavailable` with a
  `reason`, never a silent zero. `context_peak`/`context_size` come from
  `usage_update`. Attribution only: the provider scan in
  `workspaces-panel/tool/lib/costs.mjs` remains the volume of record and the two join
  by `sessionId`; they are never added. See
  `acp/usage-capture.mjs`; `probe` runs record no `usage`.
- **Results.** Non-empty answers are saved to
  `results/` as `<stamp>-<agent>-acp.md`, with the
  session id and stop reason in the header. `--no-save` skips this.
- **Budget.** `usage_update.cost` is cumulative per turn; when it crosses
  `--budget`, the hub sends `session/cancel`. Agents that don't report
  cost can't be capped.
- **Context ceiling.** When `usage_update.used` crosses `--max-context` (or the
  grant's `limits.maxContextTokens`; the tighter wins), the same cancel path
  runs and the turn ends with `status: context`, `contextExceeded: true` and the
  peak it reached. Past that size every further tool step re-reads the whole
  prefix, so the cap stops the growth instead of paying for it. Only agents
  that report the window can be capped.
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
| OpenCode via `wsl.exe` (hub on Windows) | full turn, `WIN_WSL_ACP_OK`; cwd `D:\Workspaces\AgenticHub` → `/mnt/d/Workspaces/AgenticHub` |
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
