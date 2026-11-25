# OpenCode control room: phase 0 checks

Date: 2026-11-22. Host: Windows. OpenCode v2.3.2. Design:
[2026-11-22-opencode-control-design.md](../superpowers/specs/2026-11-22-opencode-control-design.md).
Small live checks, not a benchmark.

## Session resume capability of the pinned adapters

`node acp/hub-acp.mjs --agent <name> --probe --json --permission allow-all`
(initialize + session/new, no prompt):

| Adapter | `loadSession` | `sessionCapabilities` |
|---|---|---|
| `@agentclientprotocol/claude-agent-acp` 0.101.0 | true | resume, list, close, delete, fork, additionalDirectories, systemPrompt |
| `@agentclientprotocol/codex-acp` 2.6.0 | true | resume, list, close, delete, fork, title, additionalDirectories, subagents, systemPrompt |

Both can be continued after the hub process that created the session exits, so
named sessions can be resumable for both agents.

The Claude probe was first denied in the agent-hub tree: the local consent grant
lists no `writeTrees` for Claude, so `allow-all` (and the planned `ask`) is only
accepted in scratch directories. That is the owner's grant and is left unchanged;
using Claude write sessions on a repository needs that repository in the grant.

## OpenCode's own providers

With the logins currently stored, `opencode models` lists `openai/*` (22) and
`opencode-go/*` (33) models and no Claude Agent provider. Enabling one would need a
new sign-in, which was not done without the owner. Approach A (Claude as an OpenCode
model) therefore remains untested; nothing in the design depends on it.

## MCP client capabilities

The `initialize` request OpenCode v2.3.2 sends to the hub MCP server (captured with a
temporary, reverted debug line during one `opencode run --standalone` call):

```json
{"protocolVersion":"2025-11-25","capabilities":{"elicitation":{"form":{},"url":{}},"roots":{}},"clientInfo":{"name":"opencode","version":"2.3.2"}}
```

OpenCode advertises **elicitation** (form and URL). The hub can therefore ask the
owner a held permission question directly through MCP, with `permission_answer` as
the fallback when a request arrives while no tool call is open or the client
declines.
