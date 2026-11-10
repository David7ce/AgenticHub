# Working with agents in this workspace

A short guide for the person at the keyboard. The rules agents must follow are in
[`../AGENTS.md`](../AGENTS.md); this page is how to *use* them well.

## Pick the agent

| Need | Use | Why |
|---|---|---|
| Daily work, edits, volume | **OpenCode** | Cheapest per task; the surface the hub plugs into |
| Hard reasoning, risky changes, review | **Claude Code** | Strongest; its quota is the scarce one, so spend it where it matters |
| A second strong opinion, or Claude is out of quota | **Codex** | Independent model family; runs commands under a sandbox |

Per-model detail and the routing rules: [`../agent-hub/docs/routing.md`](../agent-hub/docs/routing.md).
Tool references: [Claude Code](claude-code-reference.md) ·
[Codex](codex-reference.md) · [OpenCode](opencode-reference.md).

## The three habits that prevent most damage

1. **One writer per tree.** Two agents editing the same checkout overwrite each
   other. Give a parallel agent its own worktree (`--worktree`).
2. **Say where it may write.** The hub refuses `allow-all` outside the grant's
   `writeTrees`. Widening a grant is a decision for the owner, not for an agent.
3. **Leave a baton.** Chat history is not shared between agents. Before stopping,
   write what was done and the exact next step where the next session will read
   it ([session continuity](agent/README.md)).

## Calling another agent

```bash
# one agent, through the consent gate
node agent-hub/acp/hub-acp.mjs --agent codex --prompt "..." --cwd <repo> --permission allow-all

# hand a tree to another agent when one runs out of quota
node agent-hub/hubctl/hubctl.mjs handoff codex --cwd <repo> --note "what to do next"
```

From inside a chat, the same thing is the MCP tools `ask_agent`, `fanout` and
`route`. Everything is logged to `logs/runs.jsonl`.

## When something looks wrong

| Symptom | First check |
|---|---|
| An agent was refused | `hubctl doctor` — consent expired, path outside `writeTrees`, daily cap |
| Costs look off | `hubctl spend` and `hubctl usage` |
| Did we already hit this before | `hubctl search "text"` (runs, notes, git; `--since`, `--source`; index `logs/index.db` rebuilds itself) |
| Start of a session: what is the state | `hubctl brief` (≤40 lines; `--json`; watch more repos in `working/repos-vigilados.txt`) |
| Which agent is working right now | `hubctl live` |
| Leftover checkouts and old backups | `hubctl clean` (dry run) |
| Too many old conversations | the `/chats` panel in OpenCode |
| Several agents side by side | `node agent-hub/tools/herdr-layout.mjs` (needs Herdr) |

## What does not belong here

Personal state (the owner's roadmap, handoff and journal) lives in the git-ignored
`working/` folder, so a fork gets a clean, generic repo. General notes and research
live in the external knowledge vault, not in this repository.
