# Workspace instructions for coding agents

Read [the hub instructions](<__HUB_DIR__/AGENTS.md>) before changing the hub.
When working in another repository, read that repository's own AGENTS.md first.

Call the hub MCP `brief` tool when available to inspect local state. Do not launch
an agent without a task. Optional personal handoff and roadmap files live under
`workspace-panel/working/`; absence of those files is normal in a new workspace.

One writing orchestrator per working tree. Give simultaneous writers separate
worktrees; do not edit a tree while a delegated write run is active. Never widen
or bypass a consent grant, print secrets, or delete audit lines or changed
worktrees without asking. Verify changes before claiming completion.

Human documentation belongs in the owning repository's `docs/` folder. Use links
instead of duplicate READMEs in each subdirectory. Keep machine-specific state
out of the hub's tracked files.
