# Decisions

STATUS: active

The standing decisions behind the hub, newest first. Each says what was decided and
what it left out. Old surveys of the alternatives are not kept in the tree; they are
in git history.

## 2026-11-10 — AgentHub stays the orchestrator and the governance layer

- **OpenRig is not adopted.** It was evaluated as a replacement orchestrator and
  dropped. Orchestration stays in the hub (`router`, `fanout`, `tasks`, `handoff`).
- **No model gateway.** The quota problem it would have solved is covered by the
  router's `agentFallbacks` chain (`claude → codex → opencode`), which passes the
  tree's context along. If a single agent ever needs per-request provider switching,
  revisit.
- **Retired:** the VS Code BYOK bridge, claude-mem, the PowerShell/CLI fallback
  (`hub.ps1`, `fanout.ps1`), Hermes as a worker and StarNet. They were dormant or
  redundant; ACP is the only transport.

## 2026-11-09 — Limits are enforced, not described

`consent.json` carries machine-readable `limits` (`maxPermission`, `writeTrees`,
`maxBudgetUsd`, `maxDailyUsd`) that the hub checks against each request. Prose scope
is documentation, never the control. Codex reports no cost, so its daily cap counts the
estimated cost of the sessions the hub started (`acp/spend-estimate.mjs`).

## 2026-11-08 — The hub is canonical on Windows

Claude and Codex credentials live there; OpenCode runs natively (or from WSL through the
Windows Node process registered as its MCP server). Windows/WSL path spelling is
centralised in `acp/paths.mjs`.

## 2026-11-01 — OpenCode is the daily surface

Talking to a model directly through OpenCode beats VS Code's Copilot session target,
which relays prompts through its own SDK with capped context and extra latency. The hub
is the consent gate, audit log and MCP server behind that surface; Claude Code and
Codex are reached through it.

## Standing rules

- One writer per working tree; parallel agents get worktrees.
- Never widen a consent grant to make something work: ask.
- No secrets in a transcript; credentials are read inside a process and passed on.
