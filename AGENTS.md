# agent-hub — read this first

Entry point for any AI agent working in this directory. It says what the hub
is, how to call it, and which rules are not negotiable. The live state of a
particular workspace lives in `../working/HANDOFF.md` when that local file
exists (personal, git-ignored); this file is the map.

## What this is

One backend that lets any agent call any other agent on this machine, with a
consent gate and an audit line for every run. It is not a UI: **OpenCode is
the daily surface** (decided 2026-11-01 — VS Code's Copilot session target
relays prompts through Copilot's own SDK, capping context and adding
latency that talking to a model directly does not hit; its browser/DOM edge
over OpenCode was just a missing MCP registration, fixed by registering
`@playwright/mcp` next to this hub in OpenCode's global config). Claude Code
is reached through the hub, not typed into directly as the default; the hub
is what that surface calls.

```
OpenCode ── MCP "agent-hub" ──> consent.json ──> runs.jsonl
   │                                              │
   └── Claude Agent / Go models                   └── claude · opencode · starnet
```

## The one rule

**One orchestrator per working tree.** The hub runs agents in a `--worktree`
checkout; Claude Code and OpenCode work in place. Never point two at the same
tree at the same time.

Native UI verification shares the Windows desktop even across different repos.
Serialize mouse/keyboard/focus-driven checks; parallel native smoke runs steal
focus and invalidate clicks. Code/build work may still overlap on separate trees.

## Map

| Path                    | What it is                                                                          |
|-------------------------|-------------------------------------------------------------------------------------|
| `acp/`                  | ACP v1 client, registry (`agents.json`, copied from `agents.example.json`), consent gate, router, fan-out, path policy |
| `mcp/`                  | The hub as an MCP server (`ask_agent`, `fanout`, `route`, `agents`)                 |
| `hubctl/`               | Control room: status/live/report/spend/usage/doctor/run/handoff/tasks (`commands/`)  |
| `chatmgr/`              | OpenCode TUI plugin: one list for OpenCode/Codex/Claude/Hermes conversations, filtered batch delete with backup |
| `models.json`           | Catálogo local: proveedores, tiers, coste, retención y capacidades                   |
| `bench/`                | The internal benchmark and its versioned baseline                                   |
| `tools/`                | Egress posture, `check.mjs`                                                         |
| `docs/`                 | Start at `docs/README.md`; it says which document is current                        |
| `chatmgr/`              | OpenCode TUI plugin: every agent's conversations in one list, batch delete           |

## How to call an agent

```bash
# One agent, through the consent gate (writes one line to logs/runs.jsonl).
node agent-hub/acp/hub-acp.mjs --agent opencode --prompt "..." --json

# Parallel, with per-agent worktrees so edits cannot collide.
node agent-hub/acp/fanout-acp.mjs --agents opencode,claude --worktree --prompt "..."

# Queue work: one SQLite file, one worktree per task, the audit carries taskId.
node agent-hub/hubctl/hubctl.mjs tasks add --repo <dir> --agent opencode --prompt "..."
node agent-hub/hubctl/hubctl.mjs tasks run --parallel 2
node agent-hub/hubctl/hubctl.mjs tasks done <id> --evidence <diff-or-test>

# From inside a chat: the MCP tools, registered in .mcp.json (Claude Code),
# .vscode/mcp.json (VS Code) and the global OpenCode config.
#   ask_agent(agent, prompt) · fanout(agents, prompt) · route(prompt) · agents() · status()

# Everything, checked.
node agent-hub/tools/check.mjs
```

The repo has no CI (no remote). `.githooks/pre-commit` runs the fast half on
every commit; enable it once per clone with
`git config core.hooksPath .githooks`. The full check adds the bench dry-run.

`hubctl status` is the health snapshot; `hubctl live` is the "who is working
now" view (inflight heartbeat, tree locks, file activity and external agent
processes; `--once --json` for scripts, `p` pauses). `hubctl path <p>` prints
both spellings of one path; `hubctl usage` estimates what each paid pool has
spent (Go reports cost 0, so it prices the tokens against the published table;
Claude's cost comes from the audit log); `hubctl worktree` lists the agent
checkouts kept after a fan-out and `--prune` removes the clean ones (`--force`
discards work).

## Consent and audit — the contract

- `consent.json` is the gate: `enabled`, `overseerAck`, unexpired `expires`.
  No grant, no run — including `--probe`. It is local and ignored: copy
  `consent.example.json` to `consent.json` and edit it.
- Every attempt, denied or not, appends one JSON line to `../logs/runs.jsonl`.
  Past 10 MB the live file rotates to `runs-<timestamp>.jsonl` next to it
  (`acp/log-rotation.mjs`); nothing is deleted, just renamed.
- An `allow-all` run checks `acp/tree-lock.mjs` for another live write run on
  the same cwd first. Conflicts reject unless direct ACP callers explicitly
  pass `--allow-concurrent-write`; the conflict is audited. External agents
  and CLI fallback workers do not participate in this local lock.
- A timed-out turn is cancelled, not just abandoned: `session/cancel` is sent
  and the hub waits (`HUB_CANCEL_WAIT_MS`, default 8 s) for the turn to end.
  `cancelAck: false` in the audit line means the callee never confirmed — treat
  its working tree as live, because a daemon-backed agent (OpenCode) can keep
  going after the client is killed.
- A run that is still going has no audit line yet; it appears as
  `results/inflight/<pid>.json` and in `hubctl status`'s `running` line. Never
  write to a tree that line names.
- `starnet` is registered **without** a grant on purpose.
- Never widen a grant to make a test pass. Ask.

## Models

| Role                   | Model                                            |
|------------------------|--------------------------------------------------|
| Default (OpenCode)     | `opencode-go/deepseek-v4.1-flash`                |
| Volume / subagents     | `opencode-go/mimo-v2.6-flash`                    |
| Review                 | `opencode-go/claude-haiku-5-5`                   |
| Hard work              | Claude Code `sonnet` (max) — weekly quota        |
| Review / cheap second | `opencode-go/claude-haiku-5-5` or Claude `haiku` |
| Codex default          | `gpt-6.1-terra` (Sol escalation, Luna bulk) via `@agentclientprotocol/codex-acp@2.6.0`; probe pending |
| Exceptional, explicit  | Codex `gpt-6-astra`, Claude `opus`; never routed automatically (`tier: frontier`) |
| Hermes                 | manual experiment only; free text, no tool use   |
| Emergency / capacity   | OpenRouter, disabled until credit                |

A pool that is out of quota hands the task to the other one: `router.mjs` and
the MCP `route` tool retry once when the error looks like exhaustion
(`--no-failover` disables it).

**Inside OpenCode, the ladder is the registry's `modelFallbacks` (2026-11-04):**
the default is the **paid** `opencode-go/deepseek-v4.1-flash` — the user's
instruction is to prefer it over the free variant always. If it reports
exhaustion the hub retries on `opencode/deepseek-v4.1-flash-free` (same weights,
no cost), then `claude-haiku-5-5`, then `mimo-v2.5`, then `beam-free`. First one
that answers wins. Each attempt is its own audit line with its `model`; an
explicit `--model` is never substituted. Change the order in `acp/agents.json`;
the reasoning and the prices are in `docs/routing.md`.

Copilot's free tier is a few tokens that run out immediately; its value is the
VS Code integration, not capacity. `iceman-contributor-free` is disabled in the
OpenCode config (trains on data, limited time, and redundant at 5.6% of the Go
allowance).
`muse-spark-*` is allowed only where the session cannot read `.env` or another
tool's memory store.

## Paths

`acp/paths.mjs` is the only place that knows how Windows and WSL spell one
file. `toWsl`, `toWindows`, `translate`, `describe`. A test fails if any other
module re-implements drive-letter translation — do not add one.

## The bench

`bench/run.mjs` stubs functions (or ships a hidden test) and lets the repo's own
tests decide. `bench/baseline.json` is the reference: 15/15. A run below it is a
regression, not noise.

```bash
node agent-hub/bench/run.mjs --dry-run        # prove every task is broken
node agent-hub/bench/run.mjs --model opencode-go/deepseek-v4.1-flash
hubctl bench --tasks paths-to-wsl --keep      # same thing, from the control room
```

## Rules

1. **No secrets in a transcript.** `.env*` reads are denied in both harnesses.
   Read a credential inside a process and pass it on; never print it.
2. **Escalate on scope or consequence**, not on perceived difficulty. The bench
   showed difficulty predicts nothing: a change spanning untested modules, or
   anything touching credentials, permissions, money or a public API.
3. **Verify before claiming.** Re-fetch, re-run, re-read. A tool saying "ok" is
   not evidence.
4. **Never delete a consent grant, a run line or a worktree with changes**
   without asking.
5. **Windows-first where it matters:** `hubctl` on Windows for loopback
   services; WSL cannot reach them.

## Current state

Done and verified: ACP path, fan-out with worktrees, MCP server, consent/audit,
path policy, bench with four tiers, quota failover (`agentFallbacks`) and
`hubctl handoff`. Open: the Claude arm of the bench after the quota reset.
