# AgenticHub

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

> The GitHub repository and this folder share a name;
> the older `AI-PC` name is retired.

AgenticHub is the **control room** for this machine's AI-agent workspace: the
local agent hub and the inventory of repositories under `D:\Workspaces`. It is
not a general notes vault. Domain documentation lives in the external
[AI-vault](file:///D:/Knowledge/Vault/Markdown-vault/AI-vault/), project state
lives in each project repository, and scripts live in the toolbox.

## Layout

| Path                       | What it is                                                                                                                              |
|----------------------------|-----------------------------------------------------------------------------------------------------------------------------------------|
| [`agent-hub/`](agent-hub/) | Swarm dispatcher, consent gate, MCP server, ACP adapters, routing and audit log                                                         |
| [`projects/`](projects/)         | Repository inventory and the generated Repos/Heatmap pages                                                                              |
| [`agent-hub/docs/`](agent-hub/docs/) | Hub docs; `docs/reference/` has the agent references and the session-baton convention                                                                      |
| [`projects/logs/`](projects/logs/)           | Agent audit log and final task evidence (local, ignored)                                                                                |
| `projects/working/`                 | Personal and local-only, ignored by git: `ROADMAP.md`, the `HANDOFF`/`JOURNAL` batons, backup notes and plans. A fork clones it empty   |

General documentation, AI working habits and research notes live outside this
repo, in the author's knowledge vault; scripts and installers live in a separate
toolbox repo. Neither is required to run the hub.

## The generated pages

Both are single self-contained HTML files — no server, no ports. They are
generated from *this* machine's repositories, so they are ignored by git:

- **Repos** — `projects/dist/repos.html`
- **Heatmap** — `projects/dist/heatmap.html`

Regenerate with `node projects/cli.mjs build` and `node projects/cli.mjs heatmap`.
Both pages share `projects/dist/repos.json`, so they report the same repository
inventory; rebuild them to refresh the snapshot. The repos page shows avatars
for owner, project and the repo's own account when it differs; the heatmap
keeps owner and project marks. Avatars fall back to a generic mark offline.

## Getting started

Open a terminal here (or in any project repository) and run an AI coding agent —
Claude Code is the reference implementation, not a requirement. Describe what
you want; the agent places the result in the matching project, or in the
AI-vault when it is general documentation.

New to AI coding agents? See the AI-vault's
[`ai-skills/`](file:///D:/Knowledge/Vault/Markdown-vault/AI-vault/ai-skills/)
for context, research, code-change, writing, visual-review and machine-change
habits.

## Platform

The documentation works on any OS. The repository toolkit requires Node.js and
Git; the agent hub also requires configured agent executables (Claude Code,
OpenCode, Codex), whose adapters have platform-specific prerequisites. See
[workspace configuration](agent-hub/docs/reference/workspace-configuration.md); the docs index
([`agent-hub/docs/`](agent-hub/docs/README.md)) starts with a guide to working with the agents.

## For agents

Read [`AGENTS.md`](AGENTS.md) — it is the operating contract: what belongs in
this control room, where documentation and scripts go, how to keep the handoff
current, and when to stop and ask.

## See it in action

- [`agent-hub/`](agent-hub/) — a working swarm: one prompt fanned out to Claude
  Code, OpenCode and Codex over ACP, with routing, quota failover, a consent
  gate with enforced limits, an MCP server and an audit log.
- `projects/` — a live inventory of every repository under `D:\Workspaces`,
  regenerated from the filesystem rather than hand-maintained.
- Toolbox examples (a separate repo): desktop setup,
  RGB/cooler troubleshooting, OMR and other machine-level work; their
  constraints live with their task docs, not here.
