# Codex CLI — working reference

What you need to drive OpenAI's Codex CLI from a terminal, from a script, and
through the hub. Companion to [`claude-code-reference.md`](claude-code-reference.md)
and [`opencode-reference.md`](opencode-reference.md); the generic ideas (context,
memory, MCP, the agent loop) are in [`AI-Agent-Basics.md`](AI-Agent-Basics.md).

Checked against the installed CLI (`codex --help`, `codex exec --help`) on
2026-11-10, Codex 0.167.0. Flags move between versions: when something here
disagrees with `codex --help`, the help wins.

## Run it

| Goal                                | Command                                                                  |
|-------------------------------------|--------------------------------------------------------------------------|
| Interactive session                 | `codex` (optionally `codex "first prompt"`)                              |
| One prompt, no UI                   | `codex exec "prompt"` (alias `codex e`); `-` reads the prompt from stdin |
| Machine-readable events             | `codex exec --json "prompt"` (JSONL on stdout)                           |
| Final answer shaped as JSON         | `codex exec --output-schema schema.json "prompt"`                        |
| Code review of the current repo     | `codex review` or `codex exec review`                                    |
| Continue an earlier session         | `codex resume` (picker) or `codex resume --last`                         |
| Branch an earlier session           | `codex fork` / `codex fork --last`                                       |
| Health of the install, config, auth | `codex doctor`                                                           |
| Update                              | `codex update`                                                           |

## Subcommands worth knowing

| Subcommand             | What it does                                                    |
|------------------------|-----------------------------------------------------------------|
| `exec`                 | Non-interactive run; the one scripts use                        |
| `review`               | Non-interactive code review                                     |
| `resume`, `fork`       | Reopen or branch a saved session                                |
| `archive`, `unarchive` | Hide or restore a saved session by id or name                   |
| `delete`               | Permanently delete a saved session (`--force` skips the prompt) |
| `queue`                | Queue a message for an existing session                         |
| `apply`                | Apply the latest diff Codex produced as a `git apply`           |
| `mcp`                  | Manage the external MCP servers Codex can call                  |
| `sandbox`              | Run a command inside Codex's own sandbox                        |
| `features`             | Inspect feature flags                                           |
| `login`, `logout`      | Authentication                                                  |

## Flags that matter

| Flag                                         | Meaning                                                                         |
|----------------------------------------------|---------------------------------------------------------------------------------|
| `-m, --model`                                | Model for this run                                                              |
| `-C, --cd DIR`                               | Working root for the agent                                                      |
| `--add-dir DIR`                              | Extra directory that is writable next to the workspace                          |
| `-s, --sandbox`                              | `read-only`, `workspace-write` or `danger-full-access`                          |
| `-a, --ask-for-approval`                     | `on-request` (the model decides when to ask) or `never`                         |
| `-c, --config key=value`                     | Override any `config.toml` value for this run (TOML syntax, dotted paths)       |
| `-p, --profile NAME`                         | Layer `$CODEX_HOME/NAME.config.toml` over the base config                       |
| `--worktree`                                 | Run in a new managed git worktree                                               |
| `--ephemeral`                                | Do not persist the session files                                                |
| `--ignore-user-config`                       | Do not load `config.toml` (auth still uses `CODEX_HOME`)                        |
| `--skip-git-repo-check`                      | Allow running outside a git repository                                          |
| `--search`                                   | Enable live web search                                                          |
| `--dangerously-bypass-approvals-and-sandbox` | No prompts and no sandbox. Only inside an environment that is already sandboxed |

## Sandbox and approvals

Two independent controls decide what Codex may do on its own:

- **Sandbox** — where model-generated shell commands may write. `workspace-write`
  is the usual choice; `danger-full-access` removes the fence.
- **Approval policy** — when it must stop and ask. `never` means it never asks
  and a refused command is returned to the model as a failure.

For unattended work, `approval_policy = "never"` with a sandbox that still
fences writes is the combination to prefer over bypassing both.

## `~/.codex/config.toml`

```toml
approval_policy = "never"        # never stop to ask

[windows]
sandbox = "unelevated"           # see the Windows note below

[projects.'D:\path\to\repo']
trust_level = "trusted"
```

A project must be trusted before Codex honours its local configuration.

## Windows

- `sandbox = "elevated"` starts commands through the Secondary Logon service
  (`seclogon`). When that service is **disabled**, every command fails with
  `CreateProcessWithLogonW failed: 1058`, and the agent can answer text but
  cannot run anything.
- `sandbox = "unelevated"` keeps a restricted-token sandbox and does not need
  that service. Prefer it over re-enabling `seclogon` for the whole machine.

## Sessions

Each session is a rollout file under `~/.codex/sessions/YYYY/MM/DD/`. The first
line records the working directory and who started it (`originator`); later
lines carry the conversation and cumulative `token_count` events. That is the
only place Codex reports token usage locally, so spend tooling reads it from
there. A session that is open holds a lock in `thread-writer-locks/`.

## Models

Codex ships several tiers. This workspace's catalogue
([`models.json`](../../models.json)) names them by role:

| Role                       | Tier                    |
|----------------------------|-------------------------|
| Default, everyday          | a mid tier (Terra)      |
| Hard coding, long tasks    | a strong tier (Sol)     |
| Bulk, cheap                | a light tier (Luna)     |
| Exceptional, explicit only | a frontier tier (Astra) |

Prices in the catalogue are **estimates**, labelled as such, used only to size
spend and the daily cap.

## Through the hub (ACP)

Codex is not an ACP server by itself; the hub starts it through the maintained
adapter `@agentclientprotocol/codex-acp` (pinned in `acp/agents.json`). The older
`@zed-industries/codex-acp` cannot run the current model generation.

```bash
node agent-hub/acp/hub-acp.mjs --agent codex --prompt "..." --cwd D:\repo --permission allow-all
node agent-hub/hubctl/hubctl.mjs handoff codex --note "carry on"
```

The consent gate applies as for every agent: `allow-all` only inside the grant's
`writeTrees`, a per-call budget, and a daily cap. See
[`README.md`](../../README.md).
