# Getting started

## Requirements and layout

Use Node.js 22+ and Git. The supported agent deployment is Windows, with optional
WSL chat clients. Install and sign in to the agent executables you intend to use;
the hub does not include their credentials. See the [agent integration notes](reference/README.md).

Run all commands below from this repository's root. The clone can have any name;
no surrounding repository or personal knowledge vault is required.

## Initialize

```bash
node hub.mjs init --dry-run
node hub.mjs init
```

This copies `consent.example.json` to `consent.json`, copies
`acp/agents.example.json` to `acp/agents.json`, and enables the pre-commit hook
when there is no existing hook configuration. Existing files are kept.

Edit the two local files. Grants start disabled: enable and acknowledge only the
agents you intend to call, with an expiry, permission, write-tree and budget/token
limits appropriate for your machine. Configure executable paths in the registry.
Never commit either local file. See the [ACP reference](reference/acp.md) and
[operating contract](reference/agent-contract.md) for the enforced rules.

```bash
node hub.mjs doctor
node hub.mjs ask opencode "Reply with exactly: HUB_OK" --permission deny --json
```

The second command makes a real model call and uses your provider allowance.
Choose another configured agent if needed. `--permission deny` prevents approved
write permissions through the hub; it does not remove the need for a valid grant.
Doctor also checks local optional integrations; investigate each finding rather
than enabling an unrelated integration just to silence it.

## Connect your chat client

To generate launcher files in the **parent folder of this clone**:

```bash
node hub.mjs init --workspace --dry-run
node hub.mjs init --workspace
```

Review the dry-run first: this also creates workspace README and agent instructions
if those files do not exist. Files come from `templates/workspace/`. MCP paths are
generated for this clone's actual location; no particular folder name is required.
Existing files are never overwritten. If your parent folder already has a client
configuration, merge the `agent-hub` entry into it yourself.

Start the client in that parent folder so it can discover its project configuration.
For a client started elsewhere, register `node` with the absolute path to this
clone's `mcp/server.mjs`. See the [MCP reference](reference/mcp.md).

OpenCode on Windows uses `cmd.exe /c node`; native non-Windows generation uses
`node`. A WSL client reaching Windows agents needs a launcher that starts the
Windows Node process, so review the generated command for that host boundary.

## Optional short command

```bash
npm link
hub doctor
```

Without `npm link`, use `node hub.mjs` instead of `hub`.

## Where local state lives

Configuration stays in this clone. By default, runtime logs and personal state
use a sibling `workspaces-panel/` directory; it does not need to be a separate Git repository.
Answers and inflight records use this clone's ignored `results/` directory.
See [workspace configuration](reference/workspace-configuration.md) for overrides.

## Verify the checkout

```bash
npm test
npm run check
```

These checks use fixtures and make no real model calls. Windows CI runs the full
suite. See [Operations](operations.md) if a configured agent cannot start.


## Test a fresh installation offline

```bash
npm run smoke
```

This creates a local Git snapshot of tracked working-tree files and clones it
into a temporary workspace with spaces in its path and a different clone name.
Untracked and ignored files, including your grants and agent registry, are not
copied. Stage new source files before running it if they belong in the checkout.

The check exercises dry-run initialization, disabled grants, repeat initialization,
permission denial, doctor, a saved CLI answer, and real MCP exchanges through both
generated launcher commands. Only a temporary fake ACP agent is configured; no
provider installation, sign-in, npm download or network connection is needed.
It verifies five audit records, cleared inflight/lock directories and a clean Git
checkout, then removes its temporary workspace.

Windows/Node 22 CI runs this as a separate installation smoke step after the
normal checks. It validates the generated server commands and MCP protocol, not
the Claude/OpenCode application UI or real-provider authentication.
