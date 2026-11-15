# Decisions

STATUS: active

The standing decisions behind the hub, newest first. Each says what was decided and
what it left out. Old surveys of the alternatives are not kept in the tree; they are
in git history.

## 2026-11-15 — Search rows belong to their source file

Search previously tracked log offsets by filename alone: a rotated live log
could duplicate archived rows and skip new records. Notes were replaced using
SQL wildcard matching and deleted notes stayed searchable. The derived index
now records exact file ownership, verifies a changed log's indexed prefix,
reconciles removed sources and commits each refresh transactionally. Old caches
rebuild once; source audit logs and working notes are never modified.

## 2026-11-15 — Bound completed job retention and preserve live controllers

Background-job cleanup now counts actual remaining records after expiry and
also runs when jobs settle, so a completed burst returns to the retention limit
without another dispatch. An unacknowledged cancellation keeps its controller
until its child settles. A synchronous launcher failure removes its phantom
record and calls the ownership-release callback before rethrowing the error.
Four regression tests reproduce these cases without model calls.

## 2026-11-15 — Keep project documentation together

Human documentation lives under `docs/`, including ACP/MCP/CLI references and
written benchmark reports. Root README and AGENTS.md remain short entry points.
Benchmark runners and JSON records stay under `bench/`. Optional setup assets
move to `templates/workspace/`; initialization renders Markdown links for the
actual clone name and continues to preserve existing files. Broad upstream CLI
manuals are replaced with official links and hub-specific integration notes.
Offline relative-file-link validation now runs with the normal checks and CI.

## 2026-11-15 — Stop means stop; every turn ends 1.5 s sooner

- **Pressing stop in the chat did nothing to the delegated agent.** The MCP server ignored
  `notifications/cancelled`, so the callee worked on until its timeout, spending quota and possibly editing.
  `job_cancel` did stop it, by killing the process tree, which left no audit line. Both now ask: the server sends
  `cancel` over an IPC channel to hub-acp, which sends `session/cancel`, waits for proof (`HUB_CANCEL_WAIT_MS`) and
  writes its line with status `cancelled` and `cancelAck`. An agent that ignores the cancel is terminated and the
  line says so. A fan-out passes the request on to each of its runs. The tree kill remains as the backstop after 15 s.
- **Every turn lingered for the whole close grace.** `AcpClient.close()` raced the agent's exit against a timer and
  never cleared it, so the hub process stayed alive 1.5 s after an agent that had already gone. Measured on the
  fixture: a whole `hub-acp` run 1,590 ms before, 105 ms after; the test suite 48 s before, 12 s after. Found while
  timing the cancel path.

## 2026-11-15 — One way in: OpenCode. The VS Code Agents window and the conversation manager leave the repo

The owner works by talking to the model in OpenCode, not by running commands and not in VS Code when OpenCode does
the same. So the path that stays is the shortest one: OpenCode → MCP (stdio) → `hub-acp` → ACP (stdio) → the agent.
No network hop, no background process, no dependency.

- **Removed: `ahp/`**, the gateway launchers (`tools/run-ahp-gateway.ps1`, `tools/register-gateway-task.ps1`), the
  VS Code task, `tools/ui-automation/`, `docs/surfaces.md`, the gateway check in `doctor`, and the registry and
  consent fields only the proxy read (`permissionModes`, `attendedEnv`, `modelPolicy`, `attendedWriteTrees`). It
  worked (6/6), but it was the longest path here (a WebSocket, a third-party gateway on a pre-release with local
  patches, a proxy) and the only thing that had to be kept running. An existing local `agents.json` or `consent.json`
  that still has those fields is fine: they are ignored.
- **Moved out: `chatmgr/`.** It manages conversation lists; it does not call agents. `hubctl clean` no longer prunes
  its backups. To give it its own repository with its history:
  `git subtree split --prefix=chatmgr 04d3bf6 -b chatmgr-only`, then push that branch to a new repo.
- **Kept:** `tools/vscode-models.mjs` and `tools/vscode-state.mjs` (the Copilot BYOK list), which do not depend on AHP.

Both are in git history; the last commit that has them is `04d3bf6`. About 3,000 lines of source and 1,500 of tests
left the tree. Earlier entries below that describe the AHP pilot stay as the record of why it was tried.

**Talking, not commands.** The MCP server's `instructions` are now a short playbook (start with `brief`, where the
roadmap is, when to use `ask_agent`, `fanout` or `route`, how to continue a session), so a request such as "let's
start with the roadmap and consult Claude and Codex" turns into the right tool calls without the owner naming one.

## 2026-11-15 — The tree lock and the daily cap no longer depend on spelling or on the log's size

Two more found by reading the gate's helpers, each confirmed with a test that fails on the old code:

- **One tree, two locks.** `acp/tree-lock.mjs` keyed the lock file on the cwd as typed. The same tree reached through
  a symlink or junction, or as `D:\Repo` and `d:\repo`, got a second lock, so two `allow-all` runs could write to it
  together. The key is now the real path in the form the consent gate already compares `writeTrees` in
  (`normalizeTree`). Still two keys: the Windows and WSL spellings of one tree, which neither side can resolve.
- **The daily cap forgot the day when the log rotated.** `spentToday` read only the live `runs.jsonl`. Past 10 MB the
  log is renamed, and what had been spent that day went with it, so `maxDailyUsd` started again from zero. Archives
  last written today are now read too.

## 2026-11-15 — Two ways around a grant are closed; setup is one command

Found by reading `acp/consent.mjs` and confirmed by running it, then fixed to fail closed:

- **`--budget 0` switched the watchdog off under a capped grant.** hub-acp reads a budget of 0 (or one that does not
  parse) as "no budget", and the gate only clamped a budget *larger* than the cap, so one run could spend past
  `maxBudgetUsd` and past what was left of `maxDailyUsd`. A budget that is not a positive number now gets the cap,
  like a missing one. Only the command line could do this; the MCP tools already rejected it. A grant with no cap is
  unchanged.
- **An `expires` that is not a date never expired.** `"2027-13-45"` or `"next week"` parsed to nothing and the grant
  ran forever. The gate now refuses it, `doctor` fails on it and `status` shows it as expired.

`hub init` copies the two examples to `consent.json` and `acp/agents.json` and sets `core.hooksPath`. It never
overwrites and never grants (every example grant is disabled). The front door also stops printing Node's
"SQLite is experimental" line on every command.

## 2026-11-15 — T3 Code is a candidate for the chat surface, not for the hub (read, not run)

Asked: is `pingdotgg/t3code` a better alternative? Read from its README and `docs/user/` on 2026-11-15; nothing was
installed or run. It is an MIT desktop/web/mobile client for the agents already signed in on the machine (Claude Code,
Codex, OpenCode, Cursor and "any ACP agent"), on Windows too, with one worktree per thread, a usage view (tokens,
estimated cost, the providers' subscription windows) and an MCP server through which an outside agent can start,
message and read threads (`t3_thread_launch`, `t3_thread_wait`, `t3_thread_read`).

- **What it would replace:** the surface work, which is the fragile part here: the patched pre-release AHP gateway
  behind VS Code's Agents window, `chatmgr/`, and most of what `hubctl live` and `usage` show.
- **What it does not have** (per its docs): write access limited to named trees, a budget or daily cap, an audit line
  per attempt, quota failover. Its permission modes are per thread and **Full access is the initial default**; a
  managed policy can only cap which modes are offered.
- **So it does not replace the hub; it could sit in front of it.** `ahp/consent-proxy.mjs` is already an ACP stdio
  proxy, and T3 Code accepts any ACP agent, so registering the three proxied agents there would keep `consent.json`,
  `writeTrees` and the audit line. Not tried.

Trial criterion, if it is run: the six checks in [`harness.md`](harness.md), with T3 Code as the client and the proxy
as its agents. If it passes, the AHP gateway and `chatmgr/` can go. Others looked at only through listings: Crystal
(deprecated), Vibe Kanban (unmaintained), Conductor (closed, macOS).

## 2026-11-15 — A turn starts faster and a follow-up reuses its session; no warm process

The hub's own overhead is small, so the two costs worth removing were measured and removed where they are:

- **npx on every start.** Claude and Codex are registered as `npx -y <pkg>@<version>`, and npx resolves the package
  each time even when cached. To the `initialize` response of `codex-acp@2.6.0` through the hub's own client (Linux,
  Node 22): 700-1056 ms through npx, 178-230 ms running the cached file with node. `acp/npx-direct.mjs` does that
  when the line is exactly `-y name@exact-version` and npx's cache holds that version; anything else, and the first
  run, still goes through npx. It applies to every path that starts an agent (hub, fan-out, the AHP proxy).
  `HUB_NO_NPX_SHORTCUT=1` turns it off. Not measured on Windows, where the cmd.exe wrapper also disappears.
- **A follow-up paying for the task again.** `hub-acp --continue <sessionId>` continues a session whichever way the
  agent offers (resume, else load), and the MCP `ask_agent` takes `sessionId`. Each turn is still its own consent
  check and audit line (`sessionMode` says which way).

Left out: a pool of agent processes kept alive between turns. It needs a daemon, which the hub does not have on
purpose, and it would make the tree lock, the inflight record and "is the callee really stopped" depend on a
long-lived process. Revisit only if start-up is still the bottleneck after these two.

## 2026-11-13 — The official SDKs are not adopted (measured); one front door, `hub`

Asked: would the hub be simpler or faster on the official SDKs than on its own ACP client and MCP server?
Measured on the test fixture (`mcp/tests/fixtures/fake-acp-agent.mjs`, one full turn, Node 22, three runs each):

| | Own `acp/acp-client.mjs` | `@agentclientprotocol/sdk` 2.6.0 |
|---|---|---|
| Import | 5 ms | 77-103 ms |
| initialize + session/new + prompt | 50-52 ms | 116-150 ms |
| Install | none (Node only) | 9.3 MB, plus `zod` as a peer |

- **ACP SDK: no.** It would replace only the JSON-RPC framing (about 150 of the client's 484 lines). What the hub
  adds on top stays ours either way: spawning and tree-killing the agent, the late answer kept as evidence that a
  cancelled turn really ended (`cancelAck`), the stderr tail, the permission policy. The 2.x API is also a rewrite of
  the 1.x one the AHP gateway pins (`^1.8.0`), so the two would not even share a copy.
- **MCP SDK: no.** `@modelcontextprotocol/sdk` 1.32.2 brings 17 runtime dependencies (express, hono, jose, ajv...)
  to replace about 90 lines of `mcp/core.mjs`, for a server that only lists and calls tools over stdio. Together the
  two SDKs install 92 packages (38 MB) into a repo whose hooks, CI and MCP registration run today with no install step.
- **Vendor SDKs (Claude Agent SDK, Codex SDK, OpenCode SDK): no.** Each is one vendor's API, so the gate, the audit
  line and the limits would need three code paths. ACP is the agnostic layer and every agent already speaks it.
- **Where the time goes instead:** the hub's own overhead per turn is tens of milliseconds; an agent's start-up is
  seconds and, for Claude, 13-45K tokens. If a turn must get cheaper, keep an agent process warm and reuse its
  session (`--resume`), do not change the transport.

Revisit when ACP v2 is stable (the hub pins v1), when the hub must proxy `fs/*` or `terminal/*` for an agent, or
when the MCP side needs more than stdio tools (resources, HTTP).

What changed instead, for ease of use: `hub.mjs` is the single command (`hub ask <agent> "..."`,
`hub fanout a,b "..."`, `hub route "..."`, `hub mcp`, `hub check`, and every `hubctl` command), installed with
`npm link` from the root `package.json` (no dependencies). It runs the existing scripts in-process and decides
nothing, so the long forms keep working. Left out: merging `hub-acp`, `fanout-acp` and `router` into one module.

## 2026-11-13 — The BYOK list lives in the repo

The models VS Code offers under a BYOK provider are user config (`chatLanguageModels.json`), which is lost with
the profile and rots when the provider retires an id. The curated list now lives in `tools/vscode-models.json`,
`tools/vscode-models.mjs --apply` writes it into the user config (vendor and key reference untouched) and
`--check` / `hubctl doctor` report drift; `--online` also asks the provider whether an id still exists. Left
out: automating the key (it stays a VS Code secret) and the other providers' catalogues (only OpenRouter has one
we can query).

## 2026-11-13 — One door per agent
The native Claude harness in VS Code is switched off (`chat.agentHost.claudeAgent.enabled=false`);
the Codex one already was. `This Computer` serves Copilot only, and `AgentHub` serves OpenCode,
Claude and Codex, all three behind `consent.json`, `writeTrees` and one audit line per turn. Left
out: the native harnesses as a fallback when the gateway is down, and any hope of a single list of
models shared by every harness. The map and the vocabulary are in
`surfaces.md` (removed 2026-11-15, in git history).

## 2026-11-13 — BYOK models live only in the Copilot harness

VS Code registers the BYOK providers from `chatLanguageModels.json` for the Copilot harness only:
that is where OpenRouter appears, both in the chat panel and in the Agents window, trimmed to 21
models by giving the group an explicit `models` list (the free ones that take tools plus the best
price/quality: DeepSeek V4.1 Flash and V4 Pro, GPT-6 Luna, GLM-5.3 Flash, MiMo V2.6 Flash, Qwen3.8
Flash, MiniMax M3.1 Flash). Claude Code, Codex and OpenCode bring their own model lists and cannot
take an external one. OpenCode Go stays out of BYOK: its console gives no API key for this plan and
the OAuth token it stores returns 401 on the endpoint, so the plan is used through
`AgentHub → OpenCode`. So "any LLM" is a property of the chat surface, while "any agent" is a
property of `AgentHub`; a model running under the Copilot harness behaves differently from the same
model running under its native agent. The group's key is a VS Code secret
(`${input:chat.lm.secret.…}`), never a value in the JSON.

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

## 2026-11-12 — The gateway drops session-config fields the agent does not declare

VS Code's Agents window sends `sensitiveEditLocations` in the same `session/configChanged` as the mode. The
gateway validates every key and fails the whole update on the first unknown one, so an AHP session never left
`plan` and an agent could not edit through the window (measured 2026-11-12; `ahp/permission-clamp.mjs` was not
involved, and `Pkg-lab` was already a writable tree). `ahp/gateway-patch.mjs` now removes the unknown keys and
applies the rest; a known but immutable key still rejects. Verified end to end: a fresh OpenCode session starts
in `build`, writes a 150-line file, and its 75-line edit renders as `+75 −75` in the chat.

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

## 2026-11-12 — OpenCode: only the Go plan (`opencode-go/*`)

OpenCode listed two providers side by side: `opencode` (Zen, per token) and `opencode-go` (flat plan). The Zen one is now
turned off at the source, with `"disabled_providers": ["opencode"]` in OpenCode's own `~/.config/opencode/opencode.json`, so
`opencode models` lists only the 32 Go models in every client (TUI, hub, VS Code). The hub followed: the free Zen model
`opencode/deepseek-v4.1-flash-free` left `modelFallbacks` (the chain is now Go-only: haiku, mimo, beam-free) and is disabled in
`models.json`. `modelPolicy` in `agents.json` stays as a second guard. To bring Zen back, remove that line.

## 2026-11-12 — No type-check gate (measured), Codex usage refreshes itself

`tsc --checkJs` over the protocol modules (`acp-client`, `consent-proxy`, `permission-clamp`, `mcp/server`) gives 46
messages today, almost all inference noise on plain JS (`resolve()` of an untyped `Promise`, option objects with
required fields). The ones checked were not bugs. A gate would start red, need TypeScript in a repo with no dependencies,
and catch nothing yet; so there is none, and the hub stays JavaScript (Node runs it directly, tests included). Revisit if a
protocol-shape bug ships. Also: `hubctl brief` now starts `hubctl limits` in the background when the cached Codex
reading is over 30 minutes old (at most one try per 10 minutes), so the line is current without anyone waiting.

## 2026-11-12 — Codex is measured by plan usage, not by price

Codex on a ChatGPT plan is flat-rate: a price per token only fed an estimate for the daily token cap. What the plan
limits is the usage windows, and the Codex app server reports them (`account/rateLimits/read`: percent used, window
length, reset time). `acp/codex-limits.mjs` reads them with the login Codex already has and keeps only percentages, the
plan name and reset times. Measured on this account (Plus): **one weekly window, no 5-hour window** (unlike Claude);
74% used, reset Sat 14 Nov 00:53 local. `hubctl usage` refreshes the reading, `hubctl brief` shows the cached one with its
age, and `doctor` warns at 85% and fails at 100%. The per-token prices in `models.json` stay as the unit of the daily
token cap; they do not describe what Codex costs on the plan.

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

