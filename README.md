# AgenticHub

[![License: AGPL v3](https://img.shields.io/badge/license-AGPL--3.0--or--later-blue.svg)](agent-hub/LICENSE)

AgenticHub is the **control room** for an AI-agent workspace: a local hub that
lets coding agents (Claude Code, OpenCode, Codex) delegate to each other through
one consent gate and an audit log, plus a GTD-style panel with the inventory of
every repository in the workspace, AI usage and the roadmap. It is not a general
notes vault: domain documentation lives in the author's external knowledge vault,
project state lives in each project repository, and scripts live in a toolbox.

## Layout

| Path                                 | What it is                                                                                                                          |
|--------------------------------------|-------------------------------------------------------------------------------------------------------------------------------------|
| [`agent-hub/`](agent-hub/)           | Swarm dispatcher, consent gate, MCP server, ACP adapters, routing and audit log                                                     |
| [`workspace-panel/`](workspace-panel/) | The workspace dashboard: repositories, AI usage and roadmap                                                                        |
| [`agent-hub/docs/`](agent-hub/docs/) | Hub docs; `docs/reference/` has the agent references and the session-continuity convention                                          |
| [`workspace-panel/logs/`](workspace-panel/logs/) | Agent audit log and final task evidence (local, ignored)                                                                  |
| `workspace-panel/working/`           | The owner's roadmap and `HANDOFF`/`JOURNAL` notes: a **separate private repo**, ignored by this public one                         |
| `workspace-panel/local/`, `opencode.json` | Machine-specific config (accounts, paths, MCP servers): ignored, with a README or `*.example` to copy from                      |

General documentation, AI working habits and research notes live outside this
repo, in the author's knowledge vault; scripts and installers live in a separate
toolbox repo. Neither is required to run the hub. Design notes for the hub live in
[`agent-hub/docs/`](agent-hub/docs/README.md); the panel is documented in
[`workspace-panel/README.md`](workspace-panel/README.md).

## Public code, private data

This repository is public and holds **code and documentation only**. Everything
personal or machine-specific is ignored and never reaches it:

| Private                                                     | Where                          | Why it stays out                                  |
|-------------------------------------------------------------|--------------------------------|---------------------------------------------------|
| Roadmap, `HANDOFF`, `JOURNAL`, AI costs (`COSTS.md`, `costs.json`) | `workspace-panel/working/`     | A separate repo with a private remote             |
| Accounts, workspace paths, overrides, tokens                | `workspace-panel/local/`      | Per-machine config, read by the panel             |
| Consent grants and agent executables                        | `agent-hub/consent.json`, `agent-hub/acp/agents.json` | Per-machine; `*.example.json` to copy from |
| MCP servers of this machine                                 | `opencode.json`                | Per-machine; `opencode.example.json` to copy from |
| Audit log and the generated panel                           | `workspace-panel/logs/`, `workspace-panel/dist/` | Generated from this machine              |

The pre-commit hook and CI scan every tracked file for credentials
(`agent-hub/tools/secret-scan.mjs`); tests that need the private notes are skipped
in a public clone.

## The generated page

`workspace-panel/dist/index.html` opens offline — no server, no ports —
generated from *this* machine's repositories: a calendar of your commits above
one table with the state of every repo (pending work, VS Code links, your
commits); picking a period on the calendar narrows the table to it. It is
machine-specific and reproducible, so git ignores it; `agent-hub/` never sees it.

Regenerate with `node workspace-panel/tool/cli.mjs build`. The machine-readable list is
`workspace-panel/dist/repos.json`. Avatars fall back to a generic mark offline.

## Getting started

Open a terminal here (or in any project repository) and run an AI coding agent —
Claude Code is the reference implementation, not a requirement. Describe what
you want; the agent places the result in the matching project, or in the
AI-vault when it is general documentation.

Setting it up on your machine: copy `opencode.example.json` to `opencode.json`,
then follow [Getting started](agent-hub/docs/getting-started.md) for the hub's
consent and agent configuration.

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
- `workspace-panel/` — a live inventory of every repository under `D:\Workspaces`,
  regenerated from the filesystem rather than hand-maintained.
- Toolbox examples (a separate repo): desktop setup,
  RGB/cooler troubleshooting, OMR and other machine-level work; their
  constraints live with their task docs, not here.
