# OpenCode integration

OpenCode is the daily chat surface and can also be a worker. On the supported Windows deployment its worker executable runs natively; the MCP launcher uses Windows Node. Explicit model selection disables the hub's model substitution; see routing for fallback behavior.

Install, authenticate and configure the upstream tool using its
[official documentation](https://opencode.ai/docs/). This repository documents its own integration,
rather than maintaining a duplicate CLI manual.

Configure executable paths in `acp/agents.json` and grants in `consent.json`.
Use `node hub.mjs doctor` to inspect the local setup. A connection or sign-in alone
does not grant permission to run through the hub.

- [Setup and first call](../getting-started.md)
- [ACP execution reference](acp.md)
- [MCP client registration](mcp.md)
- [Routing and fallback policy](../routing.md)
- [Cancellation and troubleshooting](../operations.md)
