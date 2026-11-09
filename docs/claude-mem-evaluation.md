# claude-mem: evaluation for cross-harness memory

Status: **installed Windows-only 2026-10-30** as a pilot (Claude Code +
Hermes); **not installed in WSL**. Checked 2026-10-29 against the public repo
and docs; the WSL side remains uninstalled by design.

Source: <https://github.com/thedotmack/claude-mem> — Apache-2.0,
TypeScript, v15.6.0, 104,562 stars, last push 2026-10-29.
Docs: <https://docs.claude-mem.ai/>.

## Verdict

Not a drop-in fix for "Claude, Hermes and OpenCode share one memory" on
this machine. Harness support is broad and real; the blocker here is the
Windows/WSL split, not the agent list. Worth a narrow, reversible pilot on
**one side** first, with the existing `AGENTS.md`/`HANDOFF.md` baton kept
as the source of truth for the next action.

## Pilot install (2026-10-30)

Windows-only, as recommended. Details that matter later:

| Item                 | Value                                                                          |
|----------------------|--------------------------------------------------------------------------------|
| Version              | 15.6.0                                                                         |
| Provider             | `claude` (local subscription; **no** claude-mem account, no hosted trial)      |
| Auth                 | Claude Code OAuth token, read from the credential store when the worker spawns |
| Cloud sync           | off                                                                            |
| Telemetry            | disabled (`~/.claude-mem/telemetry.json`)                                      |
| Redaction            | `CLAUDE_MEM_REDACT_ENABLED=true`                                               |
| Cross-source context | `CLAUDE_MEM_SESSION_START_INCLUDE_ALL_SOURCES=true`                            |
| IDEs                 | `claude-code`, `hermes`                                                        |
| Worker               | `127.0.0.1:37777`, started manually (`npx claude-mem start`), not at logon     |
| Data                 | `C:\Users\<you>\.claude-mem` (SQLite + WAL)                                       |
| Bun / uv             | Bun upgraded 1.2.15 → 1.4.4 for the hook launcher; uv 0.12.17 already present  |

The installer warned that Bun 1.2.15 was below the launcher's 1.2.16 floor;
after `bun upgrade`, the re-install placed the launcher. Its directory
(`%LOCALAPPDATA%\claude-mem\bin`) is on the user PATH, but processes started
before the install — including an open Claude Code/VS Code — need a restart to
see it.

`npx claude-mem doctor` now reports the plugin, runtime, tree-sitter, Claude
Code version and Git Bash as healthy. The two remaining doctor rows are
expected: the launcher PATH check is stale in the current shell, and the worker
is started manually rather than auto-started.

Not yet verified: capture quality, compression cost per session, and whether
the WSL/Windows checkouts resolve to the same project key (WSL is still
uninstalled).

### Pilot result (2026-10-30)

Two short Claude Code sessions in a throwaway repo
(`agent-hub/results/mem-pilot`):

- **Session 1** read a note containing a launch code. claude-mem stored one
  observation (#1, typed `sensitive`), one prompt, and synced it to Chroma.
- **Session 2**, without reading any file, saw the observation index at session
  start — injection works. It declined to call `get_observations` for the
  sensitive-flagged value, which is the intended guardrail, not a failure.
- The worker logged `quota:seven_day utilization 99.0% >= 93%` and paused its
  generator. Compression shares the Claude plan, so on a nearly exhausted week
  it throttles rather than spending more.

Verdict: capture and injection are verified. Detail recall is deliberately
gated behind an explicit tool call for sensitive observations. The operational
constraint is plan quota, not the software.

### Decision (2026-10-30)

**Keep it installed and running.** It is local-only, account-free, and its own
quota guard pauses compression at 93% of the seven-day window, so it cannot
run away with the plan. During a quota-tight week, stop the worker with
`npx claude-mem stop`; restart with `npx claude-mem start`. If it ever stops
earning its keep, `npx claude-mem uninstall` removes the hooks and data.

## What it does

A host integration (hooks for Claude Code, a plugin for OpenCode, a
provider for Hermes) records prompts and tool calls. A local worker
compresses them with an AI model into observations and session summaries.
Later sessions get relevant context injected at start, and the agent can
search the history through MCP tools.

```
host hook/plugin → HTTP worker → AI compression → SQLite (FTS5, optional Chroma)
                                      ↓
              SessionStart / prompt context ← search · timeline · get_observations
```

Components, from the repo and docs:

- **Worker**: Express HTTP service run by Bun. Default port
  `37700 + (uid % 100)`, bound to `127.0.0.1`. Override with
  `CLAUDE_MEM_WORKER_PORT` / `CLAUDE_MEM_WORKER_HOST` in
  `~/.claude-mem/settings.json` or the environment.
- **Database**: SQLite at `~/.claude-mem/claude-mem.db`, WAL mode, FTS5.
  Chroma is optional and only adds semantic search.
- **Search**: three-step token-saving workflow — `search` (index),
  `timeline` (context), `get_observations` (details), plus
  `get_tool_uses` for raw I/O. Exposed by the `mem-search` skill and by
  `plugin/scripts/mcp-server.cjs`.
- **Providers**: Claude plan (`--provider claude`), Gemini, OpenRouter,
  or any OpenAI-compatible endpoint; default compression model is
  `claude-haiku-4-5`.
- **Privacy**: `<private>` tags are stripped before storage; auto-redaction
  of common secrets is opt-in (`CLAUDE_MEM_REDACT_ENABLED=true`).
  Telemetry is on by default with an opt-out.

## Cross-harness sharing: what is actually shared

The worker is harness-agnostic and ships first-party integrations for
Claude Code, OpenCode, Hermes, Codex CLI, Cursor, Windsurf, Kimi,
Antigravity, Pi, DeepSeek Harness, OpenClaw and others.

One memory per **project**, resolved from the session's working directory
(git root / worktree) the same way for every harness. Hermes's docs state
plainly that a Hermes session and a Claude Code session in the same
checkout read and write the same project memory. Session-start context
can include observations from every harness with:

```json
{ "CLAUDE_MEM_SESSION_START_INCLUDE_ALL_SOURCES": "true" }
```

So the **software** supports the goal. Two conditions have to hold on this
machine:

1. every harness must reach the **same worker** and data directory, and
2. they must resolve the **same project key** from the checkout.

## The Windows/WSL problem

This workspace runs Claude Code and Hermes on Windows, and OpenCode inside
WSL2 Ubuntu. Today those are two different machines from claude-mem's
point of view:

|                  | Windows                        | WSL                  |
|------------------|--------------------------------|----------------------|
| Data dir default | `%USERPROFILE%\.claude-mem`    | `~/.claude-mem`      |
| Default port     | per-user `37700 + (uid % 100)` | `37800` (`uid` 1000) |
| Worker bind      | `127.0.0.1`                    | `127.0.0.1`          |

An install on each side gives **two independent memories**. Nothing is
shared, even for the same checkout.

Options, in order of preference:

1. **Windows-only install.** Claude Code and Hermes share one store; WSL
   OpenCode stays separate. Simplest, no network exposure, solves 2 of 3
   agents. This is the pilot worth doing.
2. **WSL mirrored networking.** With `networkingMode=mirrored` in
   `.wslconfig`, WSL can reach services bound to Windows loopback. Then
   keep the Windows worker on `127.0.0.1`, give both sides the same
   `CLAUDE_MEM_WORKER_PORT`, and let the WSL plugin use it. Requires a WSL
   restart and verification; not tested here.
3. **Non-loopback bind.** `CLAUDE_MEM_WORKER_HOST=0.0.0.0` lets WSL reach
   the Windows worker, but the worker has **no request authentication**;
   the loopback bind is its only defence. The docs warn that binding
   non-loopback without `CLAUDE_MEM_TV_TOKEN` exposes the full API,
   including provider keys via `GET /api/settings`. The TV token only
   exposes the read-only TV routes, not the API the plugins need.
   Not recommended on a LAN.
4. **Shared database on `/mnt/d`.** Point both installs at one
   `CLAUDE_MEM_DATA_DIR`. Rejected: two Bun processes writing one SQLite
   WAL database across the Windows/DrvFs boundary is a locking and
   corruption risk, and it is slower.

The OpenCode plugin itself is fine: OpenCode v2.2.2 in WSL is above the
1.3.4 minimum, and one plugin file supports both v1 and v2 contracts.
The issue is purely which worker it talks to.

## Fit with agent-hub

Two different jobs, easy to confuse:

- **Baton (today).** `AGENTS.md` + `docs/agent/HANDOFF.md` +
  `JOURNAL.md`. Explicit, deterministic, free, reviewable in git. It
  answers "what is the next action and what is already done".
- **claude-mem (proposed).** Automatic recall of past work: decisions,
  bugfixes, files touched, narratives. It answers "what did we learn
  three weeks ago", including work that never made it into a handoff.

They are complementary, not substitutes. If adopted, the baton stays
authoritative; memory is a searchable archive behind it.

Integration paths:

- **Capture** needs the per-harness plugin/hooks. There is no central
  capture point in the hub.
- **Recall** can be added without the plugin: pass
  `plugin/scripts/mcp-server.cjs` to agents through
  `hub-acp.mjs --mcp FILE`. ACP already forwards MCP servers at
  `session/new`; paths resolve inside the agent's environment, so a
  Windows-hosted worker must be described with Windows paths when driving
  WSL OpenCode.
- The MCP server auto-starts a worker if none is running, which is
  convenient locally but means a hub run can start a background process
  outside the consent gate. That needs an explicit decision if the hub is
  to stay the only launcher.

## Cost and operational footprint

- Every recorded tool call is compressed by a model. On `--provider
  claude` that spends the same Claude plan the workers already use; the
  docs sell the hosted observer as "off-plan" precisely because
  compression is not free.
- Default install is interactive and **pre-selects CMEM Pro**, the hosted
  memory service with a 30-day trial. `--provider claude`, `--provider
  host`, or `CLAUDE_MEM_ONLINE_OPTIN=false` avoids the account path.
- `npx claude-mem install` may install **Bun** and **uv** if missing. In
  WSL both are absent today (Node v24 is present). On Windows, Node
  v26.12.1 is present; Bun was not checked.
- A long-running worker must be kept alive (Bun process manager). It is
  another background service to supervise, log and stop.
- Apache-2.0 is permissive and compatible with this workspace.

## Recommendation

1. **Do not install both sides ad hoc.** Two stores that look like one is
   worse than no memory.
2. **If piloting, start on Windows only**, where Claude Code and Hermes
   already live, with:
   - `--provider claude`, not the hosted trial;
   - telemetry out, auto-redaction on;
   - `<private>` used for anything credential-shaped;
   - one real project, checked across two sessions and two harnesses.
3. **Then decide WSL.** Try mirrored networking first. Never open the
   worker to the LAN to bridge the gap.
4. **Keep the baton.** Do not let automatic summaries replace
   `HANDOFF.md`; the handoff is what the next harness reads first.
5. **Re-evaluate after the pilot** with measured cost per session and
   whether recall actually beat `grep`/the handoff.

## Not verified here

- Actual capture quality or compression cost on this machine.
- Whether the WSL and Windows checkouts resolve to the same project key
  (same git root name, different path syntax).
- Whether mirrored networking reaches a Windows loopback worker.
- Windows Bun availability and the installer's behaviour on Windows.
- Upgrade/migration safety across claude-mem versions.
