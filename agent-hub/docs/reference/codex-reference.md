# Codex integration

The registry example uses `@agentclientprotocol/codex-acp@2.6.0`. The hub negotiates ACP v1; do not restore the retired `@zed-industries/codex-acp` adapter. Keep model selection in the local registry/catalogue. Provider allowance and the hub's configured token or estimated-dollar caps are separate controls.

Install, authenticate and configure the upstream tool using its
[official documentation](https://learn.chatgpt.com/docs/cli). This repository documents its own integration,
rather than maintaining a duplicate CLI manual.

Configure executable paths in `acp/agents.json` and grants in `consent.json`.
Use `node hub.mjs doctor` to inspect the local setup. A connection or sign-in alone
does not grant permission to run through the hub.

- [Setup and first call](../getting-started.md)
- [ACP execution reference](acp.md)
- [MCP client registration](mcp.md)
- [Routing and fallback policy](../routing.md)
- [Cancellation and troubleshooting](../operations.md)
