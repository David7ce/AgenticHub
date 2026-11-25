# Claude Code integration

The hub reaches Claude over ACP. Run it on the host where Claude is signed in; a Windows installation and a WSL installation do not automatically share credentials. Claude may also host the hub as an MCP server.

Install, authenticate and configure the upstream tool using its
[official documentation](https://code.claude.com/docs/en/overview). This repository documents its own integration,
rather than maintaining a duplicate CLI manual.

Configure executable paths in `acp/agents.json` and grants in `consent.json`.
Use `node hub.mjs doctor` to inspect the local setup. A connection or sign-in alone
does not grant permission to run through the hub.

- [Setup and first call](../getting-started.md)
- [ACP execution reference](acp.md)
- [MCP client registration](mcp.md)
- [Routing and fallback policy](../routing.md)
- [Cancellation and troubleshooting](../operations.md)
