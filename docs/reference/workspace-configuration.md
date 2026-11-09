# Workspace configuration

STATUS: active

The repository toolkit requires Node.js and Git. Its default scan root is the
AgentHub checkout's parent. `--root DIR` overrides `AGENTHUB_WORKSPACE_ROOT`,
which overrides that default. `AGENTHUB_GITHUB_USER` sets local fork ownership;
`AGENTHUB_AUTHOR` sets the heatmap author (overridden by `--author`). Identity
defaults retain this workspace owner's values.

PowerShell: `$env:AGENTHUB_WORKSPACE_ROOT = 'E:\Projects'`, then
`node repos/cli.mjs build`. POSIX:
`AGENTHUB_WORKSPACE_ROOT="$HOME/Projects" node repos/cli.mjs build`.

Internal toolkit paths derive from source locations. Rebuild inventories after
a move. PowerShell wrappers require PowerShell; WSL adapters require WSL and
configured Linux workers. External MCP registrations need separate adjustment.

Use separate worktrees for simultaneous writers. Direct ACP calls can bypass
a conflict with `--allow-concurrent-write`; conflicts remain audited. External
agents and CLI fallback workers do not participate in ACP's local lock.
