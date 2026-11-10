# agent-hub — read this first

Entry point for any AI agent working in this directory: what the hub is, how to
call it, and the rules that are not negotiable. The live state of a particular
workspace is in `../working/HANDOFF.md` when that local file exists (personal,
git-ignored); this file is the map.

## What this is

One backend that lets any agent call any other agent on this machine, behind a
consent gate and with an audit line for every run. It is not a UI: **OpenCode is
the daily surface** (decided 2026-11-01: talking to a model directly beats VS Code's
Copilot session target, which relays prompts through its own SDK with capped context
and extra latency). The hub is what that surface calls; Claude Code and Codex are
reached through it.

```
OpenCode ── MCP "agent-hub" ──> consent.json ──> runs.jsonl
   │                                              │
   └── Claude / Codex / Go models                 └── claude · opencode · codex
```

## The one rule

**One orchestrator per working tree.** The hub runs agents in a `--worktree`
checkout; Claude Code and OpenCode work in place. Never point two at the same tree
at the same time. Native UI verification (mouse, keyboard, focus) shares the Windows
desktop even across repos: serialize it. Code and build work may overlap on separate
trees.

## Map

| Path | What it is |
|---|---|
| `acp/` | ACP v1 client, registry (`agents.json`, from `agents.example.json`), consent gate, router with failover, fan-out, handoff prompt, spend estimate, path policy |
| `mcp/` | The hub as an MCP server (`ask_agent`, `fanout`, `route`, `agents`, `status`, `brief`, `search`, `job_*`) |
| `hubctl/` | Control room: status, live, report, spend, usage, doctor, run, handoff, tasks, clean, verify, worktree (one module per command in `commands/`) |
| `chatmgr/` | OpenCode TUI plugin: every agent's conversations in one list, filtered batch delete |
| `models.json` | Local catalogue: providers, tiers, estimated cost, retention, capabilities |
| `bench/` | The internal benchmark and its versioned baseline; `collab.mjs` is its offline cooperation check |
| `tools/` | Egress posture, consent reminder, `check.mjs`, `herdr-layout.mjs` (Herdr workspace: OpenCode, Codex, Claude and `hubctl live`) |
| `docs/` | Start at `docs/README.md`; it says which document is current |

## How to call an agent

```bash
# One agent, through the consent gate (writes one line to logs/runs.jsonl)
node agent-hub/acp/hub-acp.mjs --agent opencode --prompt "..." --json

# Let the router pick (same prompt rules and health overlay as router.mjs)
node agent-hub/acp/hub-acp.mjs --agent auto --prompt "..." --json

# Judge a diff produced by an agent that cannot run tests (Codex: spawn EPERM)
node agent-hub/hubctl/hubctl.mjs verify <worktree>

# Parallel, with per-agent worktrees so edits cannot collide
node agent-hub/acp/fanout-acp.mjs --agents opencode,claude --worktree --prompt "..."

# Hand a tree to another agent when one runs out of quota
node agent-hub/hubctl/hubctl.mjs handoff codex --cwd <repo> --note "..." [--dry-run]

# Queue work: one SQLite file, one worktree per task, the audit carries taskId
node agent-hub/hubctl/hubctl.mjs tasks add --repo <dir> --agent opencode --prompt "..."
node agent-hub/hubctl/hubctl.mjs tasks run --parallel 2
node agent-hub/hubctl/hubctl.mjs tasks done <id> --evidence <diff-or-test>

# From inside a chat: the MCP tools, registered in .mcp.json (Claude Code),
# .vscode/mcp.json (VS Code) and the global OpenCode config.

# Everything, checked
node agent-hub/tools/check.mjs
```

`.github/workflows/checks.yml` repeats the checks on push, but nothing has been
pushed yet; locally `.githooks/pre-commit` is the guard. Enable it once per clone
with `git config core.hooksPath .githooks`.

`hubctl status` is the health snapshot; `hubctl live` is "who is working now"
(inflight heartbeat, tree locks, file activity, external agent processes; `--once
--json` for scripts). `hubctl doctor` says whether config, consent and docs agree.
`hubctl spend` / `usage` show cost (Go reports 0, so its tokens are priced against
the published table; Codex tokens come from its rollouts, priced with the catalogue's
estimates; Claude's cost comes from the audit log). `hubctl clean` is a dry-run tidy
of clean worktrees, old backups and orphaned inflight records. `hubctl path <p>`
prints both spellings of a path.

## Consent and audit — the contract

- `consent.json` is the gate: `enabled`, `overseerAck`, unexpired `expires`, and
  `limits` (`maxPermission`, `writeTrees`, `maxBudgetUsd`, `maxDailyUsd`, and for flat subscriptions like Codex `maxDailyTokens`) checked
  against the exact request. No grant, no run — including `--probe`. It is local and
  ignored: copy `consent.example.json` and edit it. Never widen a grant to make
  something work. Ask.
- Every attempt, denied or not, appends one JSON line to `../logs/runs.jsonl`. Past
  10 MB it rotates to `runs-<timestamp>.jsonl`; nothing is deleted.
- An `allow-all` run checks `acp/tree-lock.mjs` for another live write run on the
  same cwd. Conflicts reject unless the caller passes `--allow-concurrent-write`;
  the conflict is audited. Agents started outside the hub do not take this lock.
- A timed-out turn is cancelled, not abandoned: `session/cancel` is sent and the hub
  waits (`HUB_CANCEL_WAIT_MS`, default 8 s). `cancelAck: false` means the callee never
  confirmed: treat its tree as live, because a daemon-backed agent (OpenCode) can keep
  going after the client is killed.
- A run still going has no audit line yet; it is `results/inflight/<pid>.json` and
  shows in `hubctl status`. Never write to a tree that line names.
- The daily dollar cap counts the audit log's reported cost plus, for Codex (which
  reports none), the estimated cost of the sessions the hub started.

## Models

| Role | Model |
|---|---|
| Default (OpenCode) | `opencode-go/deepseek-v4.1-flash` |
| Volume / subagents | `opencode-go/mimo-v2.6-flash` |
| Review / cheap second | `opencode-go/claude-haiku-5-5` or Claude `haiku` |
| Hard work | Claude Code `sonnet` (scarce quota) |
| Codex | `gpt-6.1-terra` default, Sol for hard code, Luna for bulk, via `@agentclientprotocol/codex-acp@2.6.0` |
| Exceptional, explicit only | Codex `gpt-6-astra`, Claude `opus` (`tier: frontier`, never routed automatically) |
| Emergency capacity | OpenRouter, disabled until there is credit |

**Quota failover.** When an agent reports exhaustion, `router.mjs` and the MCP `route`
tool walk the registry's `agentFallbacks` (`claude → codex → opencode`). With `--cwd`,
the next agent also gets the tree's git state, recent runs and the original task
(`--no-context` sends the bare prompt; `--no-failover` turns it all off). Detection is
one shared definition in `acp/quota.mjs`.

**Inside OpenCode the ladder is `modelFallbacks`.** The paid `deepseek-v4.1-flash` is
the default by the owner's instruction; on exhaustion the hub tries the free variant of
the same weights, then `claude-haiku-5-5`, `mimo-v2.5`, `beam-free`. Each attempt is its
own audit line; an explicit `--model` is never substituted. Order and prices:
`docs/routing.md`. `muse-spark-*` is allowed only where the session cannot read `.env`
or another tool's memory store.

## Paths

`acp/paths.mjs` is the only place that knows how Windows and WSL spell one file
(`toWsl`, `toWindows`, `translate`, `describe`). A test fails if another module
re-implements drive-letter translation. Do not add one.

## The bench

`bench/run.mjs` stubs functions (or ships a hidden test) and lets the repo's own tests
decide. `bench/baseline.json` is the reference; a run below it is a regression, not
noise. The dry run (`--dry-run`) proves every task is broken and every fixture parses;
it writes nothing.

```bash
node agent-hub/bench/run.mjs --dry-run
node agent-hub/bench/run.mjs --agent codex --model gpt-6.1-terra
node agent-hub/bench/collab.mjs        # offline: fan-out, handoff, conflict, stall
```

## Rules

1. **No secrets in a transcript.** `.env*` reads are denied in both harnesses. Read a
   credential inside a process and pass it on; never print it. The pre-commit hook
   scans staged files for key shapes (`tools/secret-scan.mjs`) before the tests.
2. **Escalate on scope or consequence**, not on perceived difficulty (the bench showed
   difficulty predicts nothing): a change spanning untested modules, or anything touching
   credentials, permissions, money or a public API.
3. **Verify before claiming.** Re-fetch, re-run, re-read. A tool saying "ok" is not
   evidence.
4. **Never delete a consent grant, a run line or a worktree with changes** without asking.

## Current state

Done and verified: ACP path, fan-out with worktrees, MCP server, consent/audit with
enforced limits, quota failover and `handoff`, path policy, bench (Codex and OpenCode
both 14/14 on 2026-11-10), conversation manager. Open: the Claude arm of the bench
after the quota reset, and a real end-to-end failover test.
