# ahp — the hub's agents inside VS Code's native chat

STATUS: active. Piloted end to end on 2026-11-11 with a headless client and accepted in VS Code's own
Agents window the same day (6/6 of the criterion in `docs/harness.md`, run with `tools/ui-automation/`).

VS Code's Agents window talks the [Agent Host Protocol](https://microsoft.github.io/agent-host-protocol/)
(AHP) to a *host*; a host talks ACP to the agents. The third-party
[`ahp-acp-gateway`](https://github.com/formulahendry/ahp-acp-gateway) is such a host, so
Claude, Codex and OpenCode appear in the window **with their tools, edits and sessions**,
which the text-only Custom Endpoint bridge (retired 2026-11-11, see `docs/decisions.md`) could not do.

```
VS Code Agents window ──AHP/WebSocket──> ahp-acp-gateway ──stdio──> consent-proxy ──> agent (ACP)
                                         127.0.0.1:8765/ahp          (this folder)      pinned in agents.json
```

## What is here

| File | What it does |
|---|---|
| `gen-config.mjs` | Writes `projects/logs/ahp-gateway.json` from `acp/agents.json` and `consent.json`: only agents with an enabled grant become providers, each launched through the proxy; the gateway's other built-ins are switched off; loopback with a strict Origin allowlist |
| `consent-proxy.mjs` | ACP stdio proxy. Refuses to start the agent when the grant is not valid (enabled, `overseerAck`, expiry, daily caps); starts the real command; relays every line; writes one `projects/logs/runs.jsonl` line per finished turn (`transport: "ahp"`, stop reason, the cost that turn added) |
| `permission-clamp.mjs` | Applies the grant's `writeTrees` to each session (below) |
| `gateway-run.mjs` | Starts the pinned gateway from its local install (`projects/logs/ahp-gateway-pkg`) with `gateway-patch.mjs` applied |
| `gateway-patch.mjs` | Three local changes to the third-party gateway: idempotent `createSession`, `subscribe` that declines windowed delivery instead of failing, and a request log without values (below) |
| `../tools/run-ahp-gateway.ps1` | Idempotent launcher: installs the pinned gateway (exact version, `--ignore-scripts`), regenerates the config and starts `gateway-run.mjs` when `/healthz` is down |

Why a proxy: a host that launches agents itself would skip the consent gate, the audit log
and the spend caps. The gateway is "a protocol bridge, not a sandbox" (its own words), and
its built-in providers use unpinned `npx --yes`.

## The permission clamp

**Measured 2026-11-11:** through the gateway OpenCode (`build`), Claude (`auto`) and Codex (`agent`)
each created a file in the working folder **without asking**. AHP relays the permission requests an
agent chooses to make; it adds no gate, and the hub's own gate only ever worked by answering such
requests. So the proxy applies the grant itself. The policy chosen by the owner (2026-11-11) for a
person at the keyboard is **edit freely, ask before commands, read-only elsewhere**:

| | Working folder under the writable trees (open) | Anywhere else (restricted) |
|---|---|---|
| Claude | mode `acceptEdits`: edits free, commands ask (harmless ones such as `echo` do not) | `plan`; "Approve Plan" refused |
| Codex | `workspace-write`: edits and commands free inside the folder; the sandbox confines it and asks to leave it (checked: a write outside was blocked) | `read-only`; edits refused |
| OpenCode | `build` plus an `ask` rule for `shell` (`attendedEnv`): edits free, **every** shell command asks | `plan` |

Codex cannot separate edits from commands (its presets are sandboxes, and `approval_policy = "never"`
stays as it is for the hub), so for it "controlled" means confined, not asked. OpenCode's ask rule is
coarser than Claude's: it asks for every command.

- The writable trees are `limits.attendedWriteTrees` when the grant has it, else `limits.writeTrees`,
  plus the scratch folder. `attendedWriteTrees` exists so that a folder can be opened for the person at
  VS Code without opening it for unattended hub runs (today Claude: AgentHub and charstudio there, none
  in `writeTrees`).
- Right after `session/new|load|resume` the proxy sets the mode of the class, rewrites the reply so
  the client only sees the allowed modes, and refuses a later switch to another one.
- In a restricted session the proxy also answers *no* to permission requests that would edit, delete,
  move or execute, or leave the mode (Claude's "Approve Plan"; Codex asking before an edit). In an open
  session those requests reach the person.
- An agent with no restricted mode in the registry cannot be restricted, so such a session is refused
  (fail closed); if setting the mode fails, every prompt of that session is refused. Hermes is in the
  first case.
- A session that arrives with no `cwd` (or an empty one) is also treated as restricted: `checkLimits`
  only compares the trees when a cwd is given, so an empty one used to pass as open. Seen in the
  2026-11-12 review, fixed the same night.
- The tree check compares resolved, case-folded paths: an NTFS junction or symlink inside an allowed
  tree is not resolved, so a link created inside it would still read as inside. Not fixed; the agents
  run with their own shells, so a `mklink /J` there is possible.

Registry (`acp/agents.json`): `permissionModes.restricted` and `.attended` are `{ force, allow }`;
`modelPolicy` (`{ allow: [prefix...], default }`, `model-filter.mjs`) narrows the model picker and refuses a switch outside it:
OpenCode offers `opencode-go/*` only (32 models of the flat plan), not Zen's `opencode/*` (44, billed per token, with the
`claude-*`/`gpt-*` models that repeat the Claude and Codex agents); `attendedEnv` is extra environment only for agents the proxy starts (OpenCode's inline
`OPENCODE_CONFIG_CONTENT` with the `ask` rule and the `.env` denies).

Verified live with all three agents, in a folder under the trees and in one outside them.
**To let an agent work in a project, add the folder to its `attendedWriteTrees` (or `writeTrees`) in
`consent.json`.**

## Why the gateway is patched, and why a pre-release

First real use in VS Code's Agents window (2026-11-11, VS Code 1.146, gateway 0.2.2) was unusable, and the
agents were fine. Measured in `projects/logs/ahp-gateway-rpc.log`:

- VS Code asks to create a session that already exists (a repeat after a slow create: 3-4 s). The gateway
  answered "Session already exists" and the first message never started. Patched: a repeat succeeds once the
  session is ready (a different provider on the same URI still fails).
- VS Code offers windowed delivery (`flowControl`) in `subscribe`. The spec says the server accepts it or the
  subscription uses ordinary delivery; the gateway failed the whole call and VS Code retried forever (41,000 in
  2.5 minutes). Patched: the offer is declined.
- ~100 `chat/isReadChanged` dispatches per second on one chat (the session and chat read flags disagreeing).
  Fixed upstream on 2026-11-10 and 2026-11-11 and not in 0.2.2, so the launcher pins the pre-release of that
  commit, `0.2.3-next.202611110657.0d297c2` (same three dependencies, no install scripts). Go back to a stable
  version once 0.2.3 ships.
- A `session/configChanged` that carries a field the agent does not declare fails whole. VS Code sends
  `sensitiveEditLocations` together with the mode, so the session never left `plan` and an agent could not
  edit through the window (measured 2026-11-12, OpenCode over AHP; the log showed
  `Unknown or immutable session config sensitiveEditLocations`). Patched: an unknown field is dropped and the
  rest of the update is applied (`config-drop` in the log); a known but immutable field still rejects.
  Verified the same night: a new OpenCode session starts in `build` and wrote a 150-line file.

With the three in place the log is a few dozen lines in 25 s instead of thousands. The log keeps method, session
suffix, parameter names, action type and timing, never values, and collapses identical requests per second. A successful
`ping` (one every five seconds from VS Code) is not logged, and the file is moved to `ahp-gateway-rpc.log.prev` when it
reaches 2 MB, one generation kept. The change applies the next time the gateway starts.

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

- `node --test agent-hub/ahp/tests/ahp.test.mjs` (21): proxy pass-through, per-turn audit with
  cost deltas, refusal before the agent starts, the clamp (pure and through the proxy with a
  fake agent), config generation.
- Headless client (the official `@microsoft/agent-host-protocol` 1.0.0): `initialize` lists
  exactly the granted agents; `createSession` + `chat/turnStarted` returned `AHP_OK` from
  OpenCode and from Claude; the audit lines appeared (Claude 0.17 USD for the trivial turn);
  disposing the session removed the agent processes.

## Not verified / limits

- Seen in VS Code's Agents window (2026-11-11): the agent, mode and model pickers, the restricted modes, Codex's
  command confirmation, no process left after deleting a session.
- Seen on 2026-11-12: the model's reasoning is drawn as plain grey paragraphs inside the chat, streamed as it comes,
  with no collapsible "thinking" block; a prompt that says "reason step by step" made DeepSeek V4.1 Flash deliberate for
  five minutes and the turn ended `cancelled`.
- A large diff is drawn: OpenCode changed 75 of the 150 lines of `tabla.txt` with its edit tool and the chat showed
  `1 file changed +75 −75` with its diff card, 7 s for the turn (2026-11-12, `Pkg-lab`).
- **The window has its own Agent mode (Interactive / Plan / Autopilot).** With Plan selected the agent answers with a plan
  and writes nothing, in any folder (the log shows `session/configChanged ... "mode":"plan"` asked by the window). That
  looked like the permission clamp and was not; pick Interactive or Autopilot before testing an edit.
- **First session after a provider switch can fail to start.** Seen 2026-11-12: two `createSession` calls 0.7 s apart
  both failed (`ACP provider OpenCode (opencode) failed (reference …)`), then the next one worked; nothing reached
  `runs.jsonl`, so the proxy's agent process never got to a turn. The window then shows an empty model or mode list for
  that draft. Switching the session type away and back (Claude → OpenCode) creates a fresh session and the lists come
  back. Likely two `opencode acp` starts racing over the CLI's SQLite store; not confirmed.
- The gateway has no MCP forwarding and no multi-user policy; ACP v1 only. The clamp bounds
  what the agent *asks to do*; it cannot see paths an agent touches inside its own tools, so
  `writeTrees` is a rule about the session's folder, exactly as in the hub.
- A mode name that a future agent version renames would make the registered restricted mode
  fail to apply. The proxy fails closed: it writes an error line to `runs.jsonl` (`could not
  restrict`) and refuses every prompt of that session. Check `permissionModes` after upgrading
  an agent.
