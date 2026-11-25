# Working with agents in this workspace

A short guide for the person at the keyboard. The rules agents must follow are in
[`docs/reference/agent-contract.md`](agent-contract.md); this page is how to *use* them well.

## Pick the agent

| Need | Use | Why |
|---|---|---|
| Daily work, edits, volume | **OpenCode** | Cheapest per task; the surface the hub plugs into |
| Hard reasoning, risky changes, review | **Claude Code** | Strongest; its quota is the scarce one, so spend it where it matters |
| A second strong opinion, or Claude is out of quota | **Codex** | Independent model family; runs commands under a sandbox |

Per-model detail and the routing rules: [`docs/routing.md`](../routing.md).
Tool references: [Claude Code](claude-code-reference.md) ·
[Codex](codex-reference.md) · [OpenCode](opencode-reference.md).

## The three habits that prevent most damage

1. **One writer per tree.** Two agents editing the same checkout overwrite each
   other. Give a parallel agent its own worktree (`--worktree`).
2. **Say where it may write.** The hub refuses `allow-all` outside the grant's
   `writeTrees`. Widening a grant is a decision for the owner, not for an agent.
3. **Leave a baton.** Chat history is not shared between agents. Before stopping,
   write what was done and the exact next step where the next session will read
   it ([session continuity](session-continuity.md)).

## Calling another agent

```bash
# one agent, through the consent gate
node acp/hub-acp.mjs --agent codex --prompt "..." --cwd <repo> --permission allow-all

# hand a tree to another agent when one runs out of quota
node hubctl/hubctl.mjs handoff codex --cwd <repo> --note "what to do next"
```

From inside a chat, the same thing is the MCP tools `ask_agent`, `fanout` and
`route`. Everything is logged to `projects/logs/runs.jsonl`.

## When something looks wrong

| Symptom | First check |
|---|---|
| An agent was refused | `hubctl doctor` — consent expired, path outside `writeTrees`, daily cap |
| Costs look off | `hubctl spend` and `hubctl usage` |
| End of a session: draft the JOURNAL entry | `hubctl wrap` prints it; `--write --yes` files it and moves the marker; `--mark` moves only the marker |
| Did we already hit this before | `hubctl search "text"` (runs, notes, git; `--since`, `--source`; index `projects/logs/index.db` rebuilds itself) |
| Verify a diff an agent could not test | `hubctl verify <worktree>` (runs the repo's own tests; `--cmd` overrides) |
| Start of a session: what is the state | `hubctl brief` (≤40 lines; `--json`; watch more repos in `projects/working/repos-vigilados.txt`) |
| Which agent is working right now | `hubctl live` |
| Leftover checkouts and old backups | `hubctl clean` (dry run) |
| Too many old conversations | the `/chats` panel in OpenCode |
| Several agents side by side | `node tools/herdr-layout.mjs` (needs Herdr) |

## What does not belong here

Personal state (the owner's roadmap, handoff and journal) lives in the git-ignored
`projects/working/` folder, so a fork gets a clean, generic repo. General notes and research
live in the external knowledge vault, not in this repository.

