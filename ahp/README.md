# ahp — the hub's agents inside VS Code's native chat

STATUS: piloted end to end on 2026-11-11 (headless client: OpenCode and Claude turns).
Not yet confirmed in VS Code's own Agents window.

VS Code's Agents window talks the [Agent Host Protocol](https://microsoft.github.io/agent-host-protocol/)
(AHP) to a *host*; a host talks ACP to the agents. The third-party
[`ahp-acp-gateway`](https://github.com/formulahendry/ahp-acp-gateway) is such a host, so
Claude, Codex and OpenCode appear in the window **with their tools, edits and sessions**,
which the text-only [`bridge/`](../bridge/README.md) cannot do.

```
VS Code Agents window ──AHP/WebSocket──> ahp-acp-gateway ──stdio──> consent-proxy ──> agent (ACP)
                                         127.0.0.1:8765/ahp          (this folder)      pinned in agents.json
```

## What is here

| File | What it does |
|---|---|
| `gen-config.mjs` | Writes `logs/ahp-gateway.json` from `acp/agents.json` and `consent.json`: only agents with an enabled grant become providers, each launched through the proxy; the gateway's other built-ins are switched off; loopback with a strict Origin allowlist |
| `consent-proxy.mjs` | ACP stdio proxy. Refuses to start the agent when the grant is not valid (enabled, `overseerAck`, expiry, daily caps); otherwise starts the real command and passes bytes through, and writes one `logs/runs.jsonl` line per finished turn (`transport: "ahp"`, stop reason, the cost that turn added) |
| `../tools/run-ahp-gateway.ps1` | Idempotent launcher: regenerates the config and starts the pinned gateway (`0.2.2`) when `/healthz` is down |

Why a proxy: a host that launches agents itself would skip the consent gate, the audit log
and the spend caps. The gateway is "a protocol bridge, not a sandbox" (its own words), and
its built-in providers use unpinned `npx --yes`.

## Run it

```powershell
powershell -ExecutionPolicy Bypass -File agent-hub\tools\run-ahp-gateway.ps1
```

User setting (already added on this machine): 

```json
"chat.remoteAgentHosts": [{ "name": "AgentHub", "address": "127.0.0.1:8765/ahp" }]
```

Then **Chat: Open Agents Window** (or `code --agents`), **New**, pick the folder, choose
**AgentHub** as the remote host, pick the agent and the model. Permission requests are
never auto-approved: VS Code shows them to you.

Stop it with `taskkill /PID <gateway pid> /T /F` (the `/T` matters), and let a session end
with `disposeSession` rather than killing the client: the gateway keeps one agent process per
chat until the session is disposed.

## Verified

- `node --test agent-hub/ahp/tests/ahp.test.mjs`: proxy pass-through, per-turn audit with cost
  deltas, refusal before the agent starts, config generation.
- Headless client (the official `@microsoft/agent-host-protocol` 1.0.0): `initialize` lists
  exactly the granted agents; `createSession` + `chat/turnStarted` returned `AHP_OK` from
  OpenCode and from Claude; the audit lines appeared (Claude 0.17 USD for the trivial turn);
  disposing the session removed the agent processes.

## Not verified / limits

- How VS Code renders a session end to end (model and effort pickers, diffs, permission prompts).
- The gateway has no MCP forwarding and no multi-user policy; ACP v1 only; agents run with
  your rights (use the grant's scope, not the proxy, to decide what they may touch).
- The proxy does not enforce `maxPermission` or `writeTrees`: the person answers permission
  requests interactively, so only enabled, acknowledgement, expiry and the daily caps apply.
