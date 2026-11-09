# agent-hub

STATUS: active

**New here? Read [`AGENTS.md`](AGENTS.md) first** — it is the one-page map:
what the hub is, how to call it, and the rules that are not negotiable.

The centralized hub for driving a swarm of AI agents from one interface --
sibling to `docs/`, `repos/`, and `logs/` because it's
infrastructure the whole workspace shares, not a task under one category.
OpenCode (WSL) is the daily chat surface, not just a worker the hub calls —
decided 2026-11-01 after VS Code's Copilot session target turned out to
relay every prompt through Copilot's own SDK (capped context, extra
latency), and the one thing VS Code had that OpenCode didn't (a built-in
browser/DOM view) turned out to be a missing MCP registration, not a real
gap: `@playwright/mcp` is now registered in OpenCode's global config next to
this hub, both `✓ connected`. This hub is the consent gate, audit log and MCP
server behind that surface; Claude Code is the hard-work path, reached
through the hub when something needs auditing or the strongest reasoning,
Hermes queda como experimento manual de texto, no como worker. Windows 11, PowerShell 5.1, WSL2
Ubuntu. Created 2026-10-23; moved here and given a consent gate 2026-10-24.

See [`docs/routing.md`](docs/routing.md) for who does what and the routing rules, and
[`docs/`](docs/) for the orchestration strategy and harness comparisons this
hub was designed against (start at [`docs/README.md`](docs/README.md) — it says
which document is current and which is only the trail that led here).

## Where the hub runs

The hub is canonical on **Windows** (decision 2026-11-08): Claude and
the loopback services live there, and OpenCode is spawned from there through
`wsl.exe`. OpenCode itself still runs in WSL, so [`../opencode.json`](../opencode.json)
overrides the global `agent-hub` MCP entry with the Windows Node process
(`cmd.exe /c node` works when launched from WSL and from Windows):

```json
["cmd.exe", "/c", "node", "D:\\Workspaces\\AgentHub\\agent-hub\\mcp\\server.mjs"]
```

`opencode mcp list` must show `agent-hub` and `playwright` connected. The
project config is watched and reloaded without restarting OpenCode. Codex is
registered through the maintained `@agentclientprotocol/codex-acp@2.6.0`
(the frozen `@zed-industries/codex-acp@0.16.0` could not run 6.x models);
its first probe is still pending. See [`docs/routing.md`](docs/routing.md).

## Use

Call one worker:

```
powershell -NoProfile -ExecutionPolicy Bypass -File hub.ps1 -Worker claude -Prompt "..."
```

Workers: `claude`, `opencode`. Options: `-WorkDir`, `-Transport acp|cli` (default `acp`), `-Permission deny|allow-reads|allow-all` (default `deny`), `-Model` (passed through to the selected worker; CLI mode: opencode only), `-Timeout`, `-BudgetUsd` (default 0.50). Exit code 0 answered, 1 denied/rejected/failed/empty, 2 timed out.

`-Transport acp` (the default) runs the Node client in [`acp/`](acp/) and gets ACP's per-session features (stop reason, reported cost, MCP servers, permission policy). `-Transport cli` keeps the original per-worker CLI adapters as a fallback.

Send the same prompt to several workers in parallel and merge:

```
powershell -NoProfile -ExecutionPolicy Bypass -File fanout.ps1 -Prompt "..." [-Workers claude,opencode]
```

Answers are saved under `results/` (gitignored). For parallel workers that may
edit files, add `--worktree` to the ACP fan-out so each agent gets its own
checkout:

```
node agent-hub/acp/fanout-acp.mjs --agents opencode,claude --worktree --prompt "..."
```

## ACP transport

A second, protocol-level path lives in [`acp/`](acp/): the hub acts as an
**ACP Client** and each agent runs as an **ACP Agent** over stdio, with
MCP servers handed to the agent at `session/new` (ACP has no separate
MCP bridge to build). It is the default path for `hub.ps1`, and adds a
health/cost-aware router, parallel fan-out with optional synthesis, and
zero-dependency tests. Verified 2026-10-26/29 against OpenCode (in WSL
and from Windows through `wsl.exe`) and the Claude ACP adapter.

```
node agent-hub/acp/hub-acp.mjs --list
node agent-hub/acp/hub-acp.mjs --agent opencode --prompt "..."
node agent-hub/acp/fanout-acp.mjs --agents opencode,claude --prompt "..."
node agent-hub/acp/router.mjs --prompt "..."   # picks opencode or claude by cost/health
```

It shares this folder's consent gate, `logs/runs.jsonl` audit trail, and
`results/` convention. [`acp/README.md`](acp/README.md) covers capabilities,
permission policy, MCP, routing, fan-out/synthesis, tests, and what is
still missing. The CLI adapters remain as `hub.ps1 -Transport cli`.

## Editor bridge (BYOK) — dormant

[`bridge/`](bridge/) is a loopback OpenAI-compatible endpoint for VS Code's
Custom Endpoint (BYOK) provider. It maps a stable model id to a real upstream
(`openai` or `anthropic` shape), forwards with that provider's own API key,
streams `choices[0].delta.content` back, and writes one audit line per request
to `logs/bridge.jsonl`. It does **not** reuse subscription login tokens.

It is **kept, not used**: VS Code Chat is the only surface here with browser and
DOM context, and this is what lets that surface use these models. It costs
nothing while stopped, so `hubctl status` only shows it when it is running.
Start it when VS Code Chat is the surface for a task, not before.

```
node agent-hub/bridge/server.mjs          # 127.0.0.1:3010 by default
node --test agent-hub/bridge/tests/bridge.test.mjs
```

See [`bridge/README.md`](bridge/README.md) for the VS Code
`chatLanguageModels.json` snippet, and
[`docs/copilot-bridge-assessment.md`](docs/copilot-bridge-assessment.md) for
what in the original sketch was kept, corrected, or rejected.

## One surface (MCP)

[`mcp/`](mcp/) exposes the other agents as **MCP tools**, so the agent already
open in the editor can call them instead of you switching apps:

```
node agent-hub/mcp/server.mjs      # stdio MCP server, no daemon
```

Tools: `ask_agent` (with `background: true` for long work), `job_status`,
`job_result`, `job_cancel`, `fanout`, `route`, `agents`, `status`. Each call
goes through `consent.json` and writes `logs/runs.jsonl`, same as every other
path. Registered for Claude Code in [`.mcp.json`](../.mcp.json). See
[`mcp/README.md`](mcp/README.md) and the decision behind it in
[`docs/history/alternatives-2026-10.md`](docs/history/alternatives-2026-10.md).

## Shared memory

[`docs/claude-mem-evaluation.md`](docs/claude-mem-evaluation.md) evaluates
[claude-mem](https://github.com/thedotmack/claude-mem) as a cross-harness
memory store: automatic capture, a local SQLite worker, MCP search, and
the Windows/WSL split that keeps Claude and OpenCode from sharing
one store today. It is **not installed**; `AGENTS.md` +
`private/HANDOFF.md` remain the source of truth for the next action.

## Consent gate and audit log

Every call to `hub.ps1` -- including denied and rejected ones -- is checked
against `consent.json` first: the worker must have
`enabled: true`, `overseerAck: true`, and an unexpired `expires` date, or the
run is denied before anything executes. The file is **local**: copy
[`consent.example.json`](consent.example.json) to `consent.json` and edit it.
Every attempt is appended as one
JSON line to `../logs/runs.jsonl` (the shared root log, not kept inside this
folder). Claude's call additionally passes `--permission-prompts none` and
`--max-budget-usd` so a run needing approval is denied rather than hanging
or overspending. Revoke an agent by setting its `enabled` to `false`.

This was ported from an earlier Node implementation (`hub.js`, now retired)
that had the governance model but was only verified for Claude; this script
had the other two workers proven first, so it kept its own logic and gained
the consent/logging contract instead of being replaced by it.

## Files

- `hub.ps1` - one-worker entry point: consent gate, audit log, ACP dispatch by default (CLI fallback), contract in its header
- `fanout.ps1` - parallel dispatch through `hub.ps1` and a merged result
- `run-opencode.sh` - runs OpenCode inside WSL with stdin closed
- `acp/` - ACP path: per-platform agent registry, zero-dependency ACP v1 client, `hub-acp.mjs`, `fanout-acp.mjs`, and `router.mjs` (cost/complexity routing between opencode and claude; same consent gate + audit log); `log-rotation.mjs` (keeps `runs.jsonl` from growing forever) and `tree-lock.mjs` (warns on two write-permission runs hitting the same tree) back the audit log and `hub-acp.mjs` respectively
- `bridge/` - loopback OpenAI-compatible endpoint for VS Code BYOK; per-provider API keys, SSE streaming, own audit log (dormant by decision; see `docs/copilot-bridge-assessment.md`)
- `tools/` - egress posture check: VS Code sandbox/network settings, bridge permission, consent expiry
- `hubctl/` - minimal read-only control room (`status`, `live`); reads files, `/proc` and loopback services, no daemon
- `mcp/` - the hub as an MCP server (`ask_agent`, `job_status`, `job_result`, `job_cancel`, `fanout`, `route`, `agents`, `status`), so one chat surface can drive the whole fleet
- `consent.example.json` - the grant template; copy it to `consent.json` (local, ignored) and edit (see above)
- `acp/agents.example.json` - the registry template; copy it to `acp/agents.json` (local, ignored) and set your own agent paths
- `docs/routing.md` - workers, roles, catálogo y reglas
- `docs/` - orchestration strategy, harness comparisons, the Copilot-bridge assessment, the Tetragon runtime-security notes, and the earlier design trail
- `docs/history/alternatives-2026-10.md` - why the surface is OpenCode + hub-mcp, and what was compared and rejected

## Verified 2026-10-23 (histórico)

En ese momento había tres workers. Cada uno respondió a un prompt "reply with
exactly ..." y un fan-out de tres devolvió respuestas correctas (claude 11.6 s,
opencode 5 s, hermes 19 s). Hermes ya no es worker; la comparación actual está
en [`bench/WORKFLOW.md`](bench/WORKFLOW.md).

## Gotchas found while building

- Scripts are blocked by the system execution policy; the `-ExecutionPolicy Bypass` flag applies to that process only and changes no setting.
- `$PSScriptRoot` is empty in `param()` defaults on this PowerShell; use `$MyInvocation` after the block.
- (Histórico) Hermes ignoraba el directorio de trabajo; ya no es worker.
- OpenCode prints a banner and tool lines; `hub.ps1` strips them from the saved answer.
- Workers run with write access in the repo. Fan-out prompts so far were read-only. Pass `--worktree` to `fanout-acp.mjs` before letting parallel workers edit: each agent then gets its own checkout, and any checkout it changed is kept for inspection.

## Not done yet

This list is for the `hub.ps1` CLI-adapter path. The ACP path
([`acp/`](acp/README.md)) records reported cost per run and has a verified
MCP round-trip, but it does not change these:

- Subscription usage per call is unmeasured on this path.
- No test of edit tasks or skills through the `-Transport cli` fallback. All
  three ACP agents now have an edit test; the CLI path stays as a recovery
  option and is verified for OpenCode only.
- `ai-config` has not been run to give every worker the same rules and skills.
