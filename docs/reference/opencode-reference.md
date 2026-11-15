# OpenCode — working reference

What you need to drive OpenCode from a terminal, from a script, and through the
hub. Companion to [`claude-code-reference.md`](claude-code-reference.md) and
[`codex-reference.md`](codex-reference.md); the generic ideas (context, memory,
MCP, the agent loop) are in [`AI-Agent-Basics.md`](AI-Agent-Basics.md).

Checked against the installed CLI (`opencode --help`, `opencode run --help`) on
2026-11-10, OpenCode 2.2.6. When this disagrees with `--help`, the help wins.

## Run it

| Goal                              | Command                                          |
|-----------------------------------|--------------------------------------------------|
| Interactive UI in a folder        | `opencode [directory]`                           |
| One message, no UI                | `opencode run "message"`                         |
| Machine-readable output           | `opencode run --format json "message"`           |
| Continue the last session         | `opencode -c` / `opencode run -c "next message"` |
| A specific session                | `opencode -s SESSION_ID`                         |
| Branch before continuing          | `opencode run -s SESSION_ID --fork "message"`    |
| A session in its own git worktree | `opencode run -w [name] "message"`               |
| Minimal interface                 | `opencode mini`                                  |
| Update                            | `opencode upgrade`                               |

## `opencode run` flags

| Flag                                 | Meaning                                                              |
|--------------------------------------|----------------------------------------------------------------------|
| `-m, --model provider/model#variant` | Model for this run                                                   |
| `--agent NAME`                       | Which OpenCode agent to use                                          |
| `-f, --file PATH`                    | Attach a file to the message                                         |
| `--title TEXT`                       | Session title                                                        |
| `--archived`                         | Create the session archived so it stays out of lists (scripted runs) |
| `--thinking`                         | Show thinking blocks                                                 |
| `--auto`                             | Auto-approve permissions that are not explicitly denied              |
| `--standalone`                       | Use a private server instead of the background service               |
| `--server URL`                       | Connect to a given server instead of the background service          |

`--auto` is the unattended switch; it still honours explicit denials.

## Subcommands worth knowing

| Subcommand                                   | What it does                                                      |
|----------------------------------------------|-------------------------------------------------------------------|
| `acp`                                        | Start an Agent Client Protocol server (how the hub talks to it)   |
| `models`                                     | List every model available to you                                 |
| `session list \| delete \| export \| import` | Manage sessions; `delete` also removes child sessions             |
| `mcp`                                        | Manage MCP servers (`opencode mcp list` shows what is connected)  |
| `plugin`                                     | Manage plugins, including TUI plugins                             |
| `auth`                                       | Manage integrations and credentials                               |
| `stats`                                      | Shareable usage statistics (tokens per model)                     |
| `service`, `reload`                          | The background server, and re-reading configuration               |
| `serve`, `pair`                              | The API/web server and one-time links to connect a browser or app |

## Models

Models are named `provider/model`, with an optional `#variant`. Providers
include OpenCode's own gateways (for example a paid and a free namespace for the
same weights). `opencode models` is the authority on what your install can use.
The hub keeps a ladder of fallbacks per agent (`modelFallbacks` in
`acp/agents.json`): when one model reports exhaustion, the next one answers.
An explicit `--model` is never substituted.

## Configuration

OpenCode reads a global config plus a project-level `opencode.json`. The
project file in this repo registers the hub as an MCP server so any OpenCode
session opened here can call the other agents:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": { "servers": { "agent-hub": {
    "type": "local",
    "command": ["cmd.exe", "/c", "node", "<repo>\\agent-hub\\mcp\\server.mjs"]
  } } }
}
```

Check it with `opencode mcp list`. The project config is watched and reloaded
without restarting.

## Sessions and data

Sessions live in a local SQLite database (`opencode.db`, under
`~/.local/share/opencode/`). Each message records its model and token counts, so
usage can be summed per model and project without any provider API. A session
marked busy and never idled (a dirty exit) stays "running" until it is cleaned
up, so tools that delete sessions refuse to touch it.

## Windows and WSL

OpenCode runs natively on Windows. If you run it in WSL instead, the two sides
have different `localhost` and different file paths, and the hub's MCP entry must
point at the Windows Node process (`cmd.exe /c node ...`), which works from both.
Path translation between the two spellings is centralised in `acp/paths.mjs`.

## Through the hub (ACP)

```bash
node agent-hub/acp/hub-acp.mjs --agent opencode --prompt "..." --cwd D:\repo --permission allow-all
node agent-hub/hubctl/hubctl.mjs run opencode --worktree --prompt "..."
```

OpenCode executes its own built-in tools without asking, so the hub's permission
policy only sees what the agent chooses to raise. The real fence is the consent
grant: `limits.writeTrees`, the budget, and one writer per tree.

