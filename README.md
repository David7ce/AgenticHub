# agent-hub

STATUS: active

**New here? Read [`AGENTS.md`](AGENTS.md) first** — the one-page map: what the hub
is, how to call it, and the rules that are not negotiable.

A local control room that lets any coding agent call any other agent on this
machine, behind one consent gate and one audit log. Windows 11 + WSL2.

- **Agents:** Claude Code, OpenCode and Codex, each over ACP (Agent Client Protocol).
- **Surface:** OpenCode is the daily chat surface; the hub is what it calls through MCP.
- **Governance:** `consent.json` (who may run, where they may write, how much they may
  spend), `logs/runs.jsonl` (one line per attempt), `hubctl doctor` (does it all agree).

Who does what, and why: [`docs/routing.md`](docs/routing.md). Which document is
current: [`docs/README.md`](docs/README.md).

## Setup

1. `consent.example.json` → `consent.json`, then edit (local, git-ignored).
2. `acp/agents.example.json` → `acp/agents.json`, then set your agent paths (local, git-ignored).
3. `node agent-hub/hubctl/hubctl.mjs doctor` — it says what does not add up.

The hub runs on **Windows**. OpenCode may run natively or in WSL; the project-level
`opencode.json` points its `agent-hub` MCP entry at the Windows Node process:

```json
["cmd.exe", "/c", "node", "<repo>\\agent-hub\\mcp\\server.mjs"]
```

## Use

```bash
# one agent, through the consent gate
node agent-hub/acp/hub-acp.mjs --agent opencode --prompt "..." --json

# several agents in parallel, each in its own checkout
node agent-hub/acp/fanout-acp.mjs --agents opencode,claude --worktree --prompt "..."

# cost/health-aware pick; walks the agentFallbacks chain when a pool is out of quota
node agent-hub/acp/router.mjs --prompt "..."

# the control room
node agent-hub/hubctl/hubctl.mjs status | live | report | spend | usage | doctor
node agent-hub/hubctl/hubctl.mjs run <agent> [--worktree]
node agent-hub/hubctl/hubctl.mjs handoff <agent> --note "..."   # relay a tree when a pool runs out
node agent-hub/hubctl/hubctl.mjs tasks add|list|run|done        # the thin work queue
```

Answers are saved under `results/` (git-ignored). Parallel agents that may edit
files must use `--worktree`: **one writer per tree**.

## Parts

| Path | What it is |
|---|---|
| [`acp/`](acp/README.md) | ACP v1 client, agent registry, consent gate, router (with `agentFallbacks`), fan-out, path policy |
| [`mcp/`](mcp/README.md) | The hub as an MCP server: `ask_agent`, `job_*`, `fanout`, `route`, `agents`, `status` |
| [`hubctl/`](hubctl/README.md) | The control room; one module per subcommand under `commands/` |
| [`chatmgr/`](chatmgr/README.md) | OpenCode TUI plugin: one list of every agent's conversations, with batch delete |
| [`bridge/`](bridge/README.md) | Loopback OpenAI-compatible endpoint for VS Code's Custom Endpoint: Claude, Codex and OpenCode through their own logins, with token, per-model context windows and real usage |
| `bench/` | The internal benchmark and its versioned baseline |
| `tools/` | Egress posture check, `check.mjs` (the whole test run), and `run-bridge.ps1` / `register-bridge-task.ps1` to keep the bridge running |
| `models.json` | Local catalogue: providers, tiers, cost, retention, capabilities |
| `docs/` | Routing, architecture, history |

## Consent gate and audit log

Every call — including denied ones — is checked against `consent.json` first: the
agent must be `enabled`, `overseerAck`-ed and unexpired, and the request must fit
its `limits` (`maxPermission`, `writeTrees`, `maxBudgetUsd`, `maxDailyUsd`, and
`maxDailyTokens` for flat subscriptions such as Codex).
Otherwise nothing runs. Every attempt appends one JSON line to `logs/runs.jsonl`
(rotated past 10 MB). Revoke an agent by setting `enabled` to `false`.

## Tests

```bash
node agent-hub/tools/check.mjs          # unit tests + bench dry-run
node --test agent-hub/hubctl/tests/*.mjs agent-hub/acp/tests/*.mjs agent-hub/mcp/tests/*.mjs agent-hub/chatmgr/test/*.mjs
```

`.githooks/pre-commit` scans staged files for credential shapes
(`tools/secret-scan.mjs --history` audits the existing commits), then runs the fast
half; enable it once per clone with
`git config core.hooksPath .githooks`. `.github/workflows/checks.yml` repeats the
full run on push (nothing pushed yet).
