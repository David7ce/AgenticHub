# Decisions

STATUS: active

The standing decisions behind the hub, newest first. Each says what was decided and
what it left out. Old surveys of the alternatives are not kept in the tree; they are
in git history.

## 2026-11-10 — AgentHub stays the orchestrator and the governance layer

- **OpenRig is not adopted.** It was evaluated as a replacement orchestrator and
  dropped. Orchestration stays in the hub (`router`, `fanout`, `tasks`, `handoff`).
- **No model gateway.** The quota problem it would have solved is covered by the
  router's `agentFallbacks` chain (`claude → codex → opencode`), which passes the
  tree's context along. If a single agent ever needs per-request provider switching,
  revisit.
- **Retired:** the VS Code BYOK bridge (twice; finally 2026-11-11), claude-mem, the PowerShell/CLI fallback
  (`hub.ps1`, `fanout.ps1`), Hermes as a worker and StarNet. They were dormant or
  redundant; ACP is the only transport.

## 2026-11-09 — Limits are enforced, not described

`consent.json` carries machine-readable `limits` (`maxPermission`, `writeTrees`,
`maxBudgetUsd`, `maxDailyUsd`) that the hub checks against each request. Prose scope
is documentation, never the control. Codex reports no cost, so its daily cap counts the
estimated cost of the sessions the hub started (`acp/spend-estimate.mjs`).

## 2026-11-11 — The AHP gateway runs patched and on a pre-release

VS Code 1.146's Agents window looped against gateway 0.2.2 (repeat `createSession`, rejected `flowControl` offers,
an `isReadChanged` storm). The hub now starts the gateway from a pinned local install through `ahp/gateway-run.mjs`
with `ahp/gateway-patch.mjs`, on `0.2.3-next.202611110657.0d297c2` (upstream's fixes of 2026-11-10/11). See
`ahp/README.md`. Revisit when 0.2.3 is released.

## 2026-11-11 — Two top surfaces (Claude Code, OpenCode); AHP on trial

See [`harness.md`](harness.md): the hub centralises governance and orchestration, not the models, and the chat UIs are cut
to two by what each uniquely gives; the Agents window over AHP replaces OpenCode-in-the-IDE only if it passes the checklist
there.

## 2026-11-11 — AHP is the way into VS Code's native chat (reviewed, not built yet)

Reviewed https://microsoft.github.io/agent-host-protocol/ (spec v1.0.0, MIT, repo pushed the same day). AHP is the
coordination layer between a host and N clients; ACP is the 1:1 layer between a host and an agent, and a host uses ACP
downstream. VS Code's Agents window is the reference client and connects to any host through the user setting
`chat.remoteAgentHosts` (`[{ "name", "address": "127.0.0.1:8765/ahp" }]`, present in this build). So the way to see Claude,
Codex, OpenCode, Hermes and Pi in VS Code's own chat **with their tools** is an AHP host in front of ACP agents, not
more text-only endpoints and not a stale ACP-client extension (`formulahendry/vscode-acp`: last push 2026-05-16).

Hosts that already exist (all MIT, active in Nov 2026): `ahp-acp-gateway` 0.2.2 (npm; deps: official ACP SDK, official AHP
lib, ws; no install scripts; Node >= 24; built-in providers claude, codex, opencode, hermes, pi, copilot...; loopback by
default; permission requests never auto-approved; SQLite sessions, replay, diffs, native model/effort pickers), `ahpd`
(plugin-driven, users and usage tracking), `pi-ahp`, `hydra-ahp`. Terminal clients: `ahpx`, `ahpc` (CLI/TUI and an MCP server).

What a gateway does **not** give: it is "a protocol bridge, not a sandbox" (agents run with the user's rights), it has no
MCP forwarding and no multi-user policy, and it launches providers with `npx --yes` (unpinned). It also skips
`consent.json`, the audit log and the spend caps, which the hub must keep. Plan if we pilot it: generate the gateway's
`providers` from `acp/agents.json` (same pinned versions), and launch each through a thin ACP stdio proxy that checks
the consent grant and writes the `runs.jsonl` line, so the gate is not bypassed.

**Piloted the same day** (`ahp/`): the proxy and the config generator are written and tested, and a headless client built on
the official `@microsoft/agent-host-protocol` 1.0.0 created sessions and ran turns on OpenCode and Claude through the
gateway; the audit lines appeared (Claude 0.17 USD for a trivial turn). Auditing is per turn: the host stops providers
abruptly, so an exit hook never ran. Not verified: how VS Code renders a gateway session end to end.

**Permissions through AHP are not gated by AHP (measured the same day):** OpenCode, Claude and Codex each wrote a file
without asking in their default modes, because the gateway only relays the requests an agent chooses to make. The proxy
therefore applies the grant itself (`ahp/permission-clamp.mjs`): a session outside `limits.writeTrees` is forced into the
agent's restricted mode (`permissionModes` in `agents.json`: Claude `plan`, Codex `read-only`, OpenCode `plan`), the client
sees only the allowed modes, edit/delete/move/execute/switch_mode permission requests are answered no, an agent with no
restricted mode is refused, and a failure to restrict fails closed. Verified live: no file was created by any of the three
outside the trees. Consequence for the owner: Claude has no `writeTrees`, so through VS Code it edits nothing except in the
scratch folder until a tree is added to its grant. Hermes is registered
in the hub (`hermes acp --check` OK) with its grant disabled.

## 2026-11-11 — The bridge is retired; AHP is the VS Code surface

The acceptance test in `docs/harness.md` passed 6/6 in VS Code's own Agents window (all three agents, host
AgentHub), so `bridge/` (the Custom Endpoint) is deleted again; it stays in git history (last commit that
has it: `296941d`). What replaces it: the AHP gateway with its own launcher
(`tools/run-ahp-gateway.ps1`, scheduled by `tools/register-gateway-task.ps1`, which nobody has registered
yet). What is lost: nothing the Agents window does not do better (tools, edits, sessions); the Custom Endpoint
was text-only. Claude's cost per turn goes up (about 0.17 USD by AHP against 0.01-0.06 by the bridge, from
the heavier start-up). `doctor` no longer probes port 3010. The test fixture of the AHP tests moved to
`ahp/tests/fixtures/`.

*Addendum:* OpenCode through AHP is limited to `opencode-go/*` (`modelPolicy` in `agents.json`, applied by
`ahp/model-filter.mjs`): the picker had 76 models, 44 of them Zen's per-token `opencode/*` that also repeated
Claude and Codex. `opencode-go/claude-haiku-5-5` and the `gpt-*-luna` models stay: they are on the flat plan and
the hub's own fallbacks use them.

## 2026-11-11 — The bridge returns as a second surface

*Addendum (later the same day):* the bridge also maps VS Code's `reasoning_effort` onto each agent's own
option, and `gpt-luna` (OpenCode Go `gpt-6-luna`, 1,050,000) is the 1M GPT option because Codex caps itself at 872K.

VS Code's Custom Endpoint still pointed at `127.0.0.1:3010` after `bridge/` was deleted, so
every model there was dead. `bridge/` is restored from history (text chat only, no
`tool_calls`: the agent owns its tools), Codex is added and Hermes dropped. Context windows
are per-model in `config.json`: claude 1M, opencode 1M, codex 872K (raised from the 500K default via
`model_context_window` in ~/.codex/config.toml). OpenCode stays the daily surface; the bridge is for VS Code Chat
context (@workspace, browser DOM). VS Code's Copilot harness may still cap BYOK at 128K
(vscode#336797; not re-measured: attachments and big pastes reach the bridge as
file paths, which the agent reads itself). Windows the agents themselves report
over ACP (usage_update.size): claude 1,000,000, opencode 1,000,000, codex 828,400
(= 95% of the 872K set in ~/.codex/config.toml). Start-up context per turn: claude
13.7K (with sessionMeta, 44K without), opencode 16.2K, codex 20.4K. The Claude
harness in VS Code needs Copilot or an Anthropic API key, not the subscription
login, so Claude on a subscription goes through this bridge.

## 2026-11-08 — The hub is canonical on Windows

Claude and Codex credentials live there; OpenCode runs natively (or from WSL through the
Windows Node process registered as its MCP server). Windows/WSL path spelling is
centralised in `acp/paths.mjs`.

## 2026-11-01 — OpenCode is the daily surface

Talking to a model directly through OpenCode beats VS Code's Copilot session target,
which relays prompts through its own SDK with capped context and extra latency. The hub
is the consent gate, audit log and MCP server behind that surface; Claude Code and
Codex are reached through it.

## Standing rules

- One writer per working tree; parallel agents get worktrees.
- Never widen a consent grant to make something work: ask.
- No secrets in a transcript; credentials are read inside a process and passed on.
