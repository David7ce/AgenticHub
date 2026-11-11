# bridge — local OpenAI-compatible endpoint for editor BYOK

STATUS: active

VS Code's **Custom Endpoint** provider can talk to any endpoint that speaks
Chat Completions. This is that endpoint, on loopback only.

It has two model kinds:

| Kind                    | How it authenticates                                                                                 | Use it for                                         |
|-------------------------|------------------------------------------------------------------------------------------------------|----------------------------------------------------|
| **agent** (default)     | An ACP agent that is **already logged in** — Claude Code, OpenCode — via `agent-hub/acp/agents.json` | Your existing subscriptions; no API key anywhere   |
| **provider** (optional) | A normal provider API key in an env var                                                              | Direct API access, local OpenAI-compatible servers |

Agent mode is the secure path: the bridge never reads, copies, or forwards a
provider token. It spawns the same client you use from a terminal, and that
client uses the login it already has. It also honors the hub's
`consent.json`, so an agent the hub would refuse to run cannot be run here.

## Which VS Code surface for what

VS Code chat has two levels. The **harness** selector (Copilot, Local, Claude,
Codex, Cloud) picks the agent runtime; inside Copilot/Local the **model**
picker lists providers (Copilot, Custom Endpoint, OpenRouter). This bridge
lives in the second level only.

| You want | Use | Why |
|---|---|---|
| Claude with tools, edits, full 1M, billed to Copilot or an Anthropic API key | **Claude harness** | Native Agent SDK. It needs a GitHub Copilot sign-in or `ANTHROPIC_API_KEY`; it does **not** use the Claude Code subscription login |
| Claude through your Claude Code subscription | **This bridge**, model "Claude via AgentHub" | The ACP adapter uses the existing login, no API key; text chat only |
| Codex with tools and edits | **Codex harness** (experimental) | Accepts a ChatGPT account or Copilot Pro+; the extension integration adds it to the Chat view |
| OpenCode / DeepSeek in VS Code chat | **This bridge**, model "OpenCode via AgentHub" | OpenCode has no harness; text chat only |
| Claude/Codex answers inside the Copilot harness, with `@workspace` and editor context | This bridge | Text chat, `toolCalling: false` |
| Anything that must reach this machine from Cloud | Not possible | Cloud runs remotely and cannot see loopback |

Costs of the bridge path: every request opens a fresh agent session (Claude
loads about 44K tokens of its own prompt, tools and MCP before your text), and
the Local harness, the one that honors the configured window, is deprecated
and is removed in February 2027.

## What it does

- `GET /v1/models` — the models this bridge exposes.
- `POST /v1/chat/completions` — validate, run one turn, stream back in
  OpenAI's `choices[0].delta.content` format, ending with `data: [DONE]`.
- `GET /health` — liveness; no model call.
- One JSON audit line per request in `logs/bridge.jsonl` (gitignored),
  including the agent, permission decisions and stop reason.

## What it deliberately does not do

- **No token replay.** It does not read Claude/Copilot/OpenCode login tokens or
  forward them to a third party. Agent mode drives the official client, which
  owns its own auth.
- **No jailbreak prompt.** `systemPrompt` is ordinary, user-authored text;
  provider safety systems still apply.
- **No remote bind.** Defaults to `127.0.0.1`; it is not exposed to the LAN.
- **No tool-call translation.** Agent mode is text chat: the agent keeps its
  own tools. VS Code sees `toolCalling: false`, so it will not offer agent mode
  for these models. This is deliberate: an ACP agent *executes* its tools, so
  reporting them as OpenAI `tool_calls` would ask VS Code to run work that has
  already happened.
- **One process per agent, one session per request.** An initialized agent is
  kept for 60 s (`AGENT_HUB_BRIDGE_IDLE_MS`) and reused, but every request opens
  a fresh ACP session so conversations never share context.

## Run

Run it **on Windows** for the current registry: Claude lives on Windows and
OpenCode is reached through `wsl.exe`. A bridge inside WSL can run OpenCode
directly but has no Claude credentials.

```powershell
node agent-hub/bridge/server.mjs --check --config agent-hub/bridge/config.example.json
node agent-hub/bridge/server.mjs --config agent-hub/bridge/config.example.json
```

`--check` validates the config, resolves each agent's command for this
platform, checks consent, and prints the exact `chatLanguageModels.json`
entry. Exit `0` means ready. `--config FILE` and `--port N` override defaults;
relative paths resolve against the config file's directory.

Optional bearer token: if `authTokenEnv` names a variable that is set, every
request must send `Authorization: Bearer <value>`. If it is unset, the bridge
stays unauthenticated and warns at startup — loopback only, but any local
process could call it.

## VS Code configuration

`Chat: Manage Language Models` → **Add Models** → **Custom Endpoint**, or edit
`chatLanguageModels.json` directly:

```json
[
  {
    "name": "AgentHub",
    "vendor": "customendpoint",
    "apiKey": "<the bridge's authToken>",
    "apiType": "chat-completions",
    "models": [
      {
        "id": "claude",
        "name": "Claude via AgentHub",
        "url": "http://127.0.0.1:3010/v1/chat/completions",
        "toolCalling": false,
        "contextWindow": 1000000,
        "maxOutputTokens": 64000
      },
      {
        "id": "codex",
        "name": "Codex via AgentHub",
        "url": "http://127.0.0.1:3010/v1/chat/completions",
        "toolCalling": false,
        "contextWindow": 872000,
        "maxOutputTokens": 128000
      },
      {
        "id": "opencode",
        "name": "OpenCode via AgentHub",
        "url": "http://127.0.0.1:3010/v1/chat/completions",
        "toolCalling": false,
        "contextWindow": 1000000,
        "maxOutputTokens": 64000
      }
    ]
  }
]
```

`contextWindow` is the model's full window (input + output); VS Code derives
`maxInputTokens` as `contextWindow - maxOutputTokens`. Prefer it over setting
both numbers by hand.

Known limit: in the **Copilot harness**, VS Code's Agent Host currently ignores
the configured BYOK window and falls back to 128K prompt tokens
([vscode#336797](https://github.com/microsoft/vscode/issues/336797)). Local
harness sessions honor the configured `contextWindow`. So a 200K/262K model is
only fully usable there until that bug is fixed.

The `id` must match a model id in the bridge config; the `url` must include the
explicit `/v1/chat/completions` path. The `apiKey` is whatever the bridge
expects as its bearer token (or anything, if no token is configured) — it is
not a provider key.

On this machine (2026-10-30) the **Custom Endpoint** provider lists these three
agent models with `contextWindow` set, and `chat.agentHost.byokModels.enabled`
is on for Copilot-harness sessions. Timestamped `.bak-*` copies sit beside both
files. Model defaults per agent live in `agent-hub/roster.md`.

## Config reference

| Key                          | Meaning                                                       |
|------------------------------|---------------------------------------------------------------|
| `host`, `port`               | Bind address; default `127.0.0.1:3010`                        |
| `authTokenEnv`               | Env var holding the bearer token clients must send            |
| `auditLog`                   | Path for the JSONL audit trail; `null` disables               |
| `systemPrompt`               | Prepended to every request's prompt                           |
| `agents.registry`            | `agents.json` to resolve agents from                          |
| `agents.cwd`                 | Session working directory passed to the agent                 |
| `agents.permission`          | `deny` (default) / `allow-reads` / `allow-all`                |
| `agents.timeoutMs`           | Per-turn ceiling (default 300000)                             |
| `agents.consent`             | Consent file; defaults to `../consent.json`, `false` disables |
| `agents.models[]`            | `{ id, agent, label?, systemPrompt? }`                        |
| `providers.<name>.type`      | `openai` or `anthropic` (optional API-key mode)               |
| `providers.<name>.baseUrl`   | Without the trailing API path                                 |
| `providers.<name>.apiKeyEnv` | Env var holding that provider's key                           |
| `models[].id`                | Stable id VS Code selects                                     |
| `models[].provider`          | Key into `providers`                                          |
| `models[].upstreamModel`     | Real model id sent upstream                                   |

## Verify

```bash
node --test agent-hub/bridge/tests/bridge.test.mjs
```

19 tests, no network and no model calls: config validation, model listing,
OpenAI streaming, Anthropic translation, system-prompt merge, unknown model,
bearer auth, missing-credential fail-closed, audit line, ACP prompt building,
platform override, agents-only config, consent decisions, a 403 for a missing
consent entry, process reuse, and a fake ACP agent exercised in both streaming
and non-streaming modes.

Live check on 2026-10-29, through the bridge with no API key:

```powershell
# both returned CONTENT: BRIDGE_ACP_OK
powershell -File agent-hub/results/bridge-smoke.ps1 -Model opencode -Port 3012
powershell -File agent-hub/results/bridge-smoke.ps1 -Model claude   -Port 3013
```

Process reuse, same model, two turns: **4.8 s** then **1.6 s** — the second
turn skips agent startup because the initialized process is still pooled.

## Not done yet

- **Tool calling in agent mode.** Not a translation gap: the agent owns and
  executes its tools, so VS Code cannot drive them through `tool_calls`. Agent
  mode stays chat-only. Provider `openai` mode already supports tools.
- **Streaming thoughts.** Only `agent_message_chunk` is forwarded; reasoning
  chunks are dropped.
- **Cloud sessions.** They run on managed compute and cannot reach this
  loopback endpoint; use Local or a remote session whose agent host is this
  machine.
