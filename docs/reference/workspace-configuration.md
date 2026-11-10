# Workspace configuration

STATUS: active

The repository toolkit (`repos/`) requires Node.js and Git. Its default scan root
is the AgentHub checkout's parent. `--root DIR` overrides `AGENTHUB_WORKSPACE_ROOT`,
which overrides that default. `AGENTHUB_GITHUB_USER` sets local fork ownership;
`AGENTHUB_AUTHOR` sets the heatmap author (overridden by `--author`). Identity
defaults retain this workspace owner's values.

PowerShell: `$env:AGENTHUB_WORKSPACE_ROOT = 'E:\Projects'`, then
`node repos/cli.mjs build`. POSIX:
`AGENTHUB_WORKSPACE_ROOT="$HOME/Projects" node repos/cli.mjs build`.

Internal toolkit paths derive from source locations. Rebuild inventories after a
move. The agent hub needs the agent executables you intend to use (Claude Code,
OpenCode, Codex) and, if you run OpenCode in WSL, a WSL distribution. External MCP
registrations (`.mcp.json`, `opencode.json`, `.vscode/mcp.json`) hold absolute or
repo-relative paths and need adjusting after a move.

Local, git-ignored configuration the hub reads: `agent-hub/consent.json` (copy
`consent.example.json`) and `agent-hub/acp/agents.json` (copy
`agents.example.json`). `hubctl doctor` reports what does not add up.

Use separate worktrees for simultaneous writers. Direct ACP calls can bypass a
conflict with `--allow-concurrent-write`; conflicts remain audited. Agents started
outside the hub do not take its tree lock.
