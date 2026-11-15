# AgenticHub

A local backend that lets coding agents delegate to Claude Code, OpenCode and
Codex over ACP, through one consent gate and an audit log. MCP connects the hub
to your chat client. The supported deployment is Windows; some clients may run
in WSL. Node.js 22+ and Git are required.

## Quickstart

Run these commands **from this repository's root**, whatever you named the clone:

```bash
node hub.mjs init
```

Edit `consent.json` and `acp/agents.json` for your machine. Every example grant
starts disabled: explicitly enable and acknowledge the agents you want, set
expiry and limits, and configure their executable paths. Then:

```bash
node hub.mjs doctor
node hub.mjs ask opencode "Reply with exactly: HUB_OK" --permission deny --json
```

The last command makes a real agent call and uses that provider's allowance.
For chat-client setup, optional workspace templates and troubleshooting, follow
[Getting started](docs/getting-started.md).

## Documentation

Start with the [documentation index](docs/README.md). It links to architecture,
operations, routing, ACP/MCP/CLI references and benchmark evidence.
Coding agents must read [AGENTS.md](AGENTS.md) before editing.

| Folder | Purpose |
|---|---|
| `acp/` | Agent transport, execution, consent, routing and worktrees |
| `mcp/` | MCP server, tools and background jobs |
| `hubctl/` | Command dispatch and control-room commands |
| `bench/` | Benchmark runners, fixtures and versioned data |
| `tools/` | Maintenance and verification scripts |
| `templates/workspace/` | Optional files installed beside the clone |
| `docs/` | Project documentation and written benchmark reports |

## Checks

```bash
npm test       # offline tests and documentation links
npm run check  # the same checks plus the benchmark dry-run
```

No dependencies need installing. `npm link` optionally installs the short `hub`
command. Simultaneous writers require separate worktrees. See
[the operating contract](docs/reference/agent-contract.md) for consent, audit,
cancellation and safety rules.
