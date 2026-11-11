# ahp — the hub's agents inside VS Code's native chat

STATUS: piloted end to end on 2026-11-11 with a headless client (OpenCode, Claude and Codex
turns, the permission clamp on all three). Not yet confirmed in VS Code's own Agents window.

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
| `consent-proxy.mjs` | ACP stdio proxy. Refuses to start the agent when the grant is not valid (enabled, `overseerAck`, expiry, daily caps); starts the real command; relays every line; writes one `logs/runs.jsonl` line per finished turn (`transport: "ahp"`, stop reason, the cost that turn added) |
| `permission-clamp.mjs` | Applies the grant's `writeTrees` to each session (below) |
| `../tools/run-ahp-gateway.ps1` | Idempotent launcher: regenerates the config and starts the pinned gateway (`0.2.2`) when `/healthz` is down |

Why a proxy: a host that launches agents itself would skip the consent gate, the audit log
and the spend caps. The gateway is "a protocol bridge, not a sandbox" (its own words), and
its built-in providers use unpinned `npx --yes`.

## The permission clamp

**Measured 2026-11-11:** through the gateway, OpenCode (`build`), Claude (`auto`) and Codex
(`agent`) each created a file in the working folder **without asking**. AHP relays the
permission requests an agent chooses to make; it adds no gate, and the hub's own gate only
ever worked by answering such requests. So the proxy applies the grant itself, as the hub does
for its own runs:

- A session whose working directory is under `limits.writeTrees` (or the scratch folder) is
  left alone: the agent's own mode and prompts apply.
- Any other session is **restricted**. Right after `session/new|load|resume` the proxy sets
  the agent's restricted mode, rewrites the reply so the client only sees the allowed modes,
  refuses a later switch, and answers *no* to permission requests that would edit, delete,
  move or execute, or leave the mode (Claude's "Approve Plan"; Codex asking before an edit).
  Read-type requests still reach the person.
- An agent with no restricted mode in the registry cannot be restricted, so such a session is
  refused (fail closed). Hermes is in this case until someone verifies its modes.

The modes live in `acp/agents.json` (`permissionModes.restricted = { force, allow }`):
Claude `plan`, Codex `read-only`, OpenCode `plan`.

Verified live in a folder outside every `writeTrees`: the three agents' `mode` option shows only
the restricted mode, no file was created, Claude's turn ends `cancelled` after its plan is
refused, Codex's after its edit is refused. **To let an agent write in a project, add the
folder to that agent's `limits.writeTrees` in `consent.json`** (today Claude has none, so Claude
edits nothing through this path except in the scratch folder; that is your call, not mine).

## Run it

```powershell
powershell -ExecutionPolicy Bypass -File agent-hub\tools\run-ahp-gateway.ps1
```

User setting (already added on this machine):

```json
"chat.remoteAgentHosts": [{ "name": "AgentHub", "address": "127.0.0.1:8765/ahp" }]
```

Then **Chat: Open Agents Window** (or `code --agents`), **New**, pick the folder, choose
**AgentHub** as the remote host, pick the agent and the model.

Stop it with `taskkill /PID <gateway pid> /T /F` (the `/T` matters), and let a session end
with `disposeSession` rather than killing the client: the gateway keeps one agent process per
chat until the session is disposed.

## Verified

- `node --test agent-hub/ahp/tests/ahp.test.mjs` (16): proxy pass-through, per-turn audit with
  cost deltas, refusal before the agent starts, the clamp (pure and through the proxy with a
  fake agent), config generation.
- Headless client (the official `@microsoft/agent-host-protocol` 1.0.0): `initialize` lists
  exactly the granted agents; `createSession` + `chat/turnStarted` returned `AHP_OK` from
  OpenCode and from Claude; the audit lines appeared (Claude 0.17 USD for the trivial turn);
  disposing the session removed the agent processes.

## Not verified / limits

- How VS Code renders a session end to end (model and effort pickers, diffs, permission prompts).
- The gateway has no MCP forwarding and no multi-user policy; ACP v1 only. The clamp bounds
  what the agent *asks to do*; it cannot see paths an agent touches inside its own tools, so
  `writeTrees` is a rule about the session's folder, exactly as in the hub.
- A mode name that a future agent version renames would make the registered restricted mode
  fail to apply. The proxy fails closed: it writes an error line to `runs.jsonl` (`could not
  restrict`) and refuses every prompt of that session. Check `permissionModes` after upgrading
  an agent.
