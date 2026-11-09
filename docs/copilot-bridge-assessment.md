# Copilot Chat bridge: what was built and what was rejected

Assessment of the "Hybrid Agentic Hub Central" sketch in `ROADMAP.md`, checked
against VS Code's BYOK documentation on 2026-10-29. The legitimate half is now
implemented in [`../bridge/`](../bridge/).

## The sketch

Point VS Code's Copilot Chat at `http://localhost:3010/v1/chat/completions`
through BYOK, and run a local server that:

1. receives OpenAI-shaped chat requests,
2. injects a strong system prompt,
3. picks an upstream model from the request,
4. forwards using flat-rate subscription credentials (OpenCode Zen, Claude
   Pro, Hermes), and
5. streams the answer back as OpenAI `delta` chunks.

The goal is to keep Copilot Chat's IDE context (`@workspace`, embedded
previews, browser DOM selection) while using non-Copilot models.

## What the sketch gets right

- `chatLanguageModels.json` is real, and `vendor: "customendpoint"` with
  `apiType: "chat-completions"` is the documented way to add an
  OpenAI-compatible endpoint.
- Model-level `url` and `toolCalling` are real properties.
- SSE with `choices[0].delta.content` and a final `data: [DONE]` is the
  correct wire format.
- A local translation layer is the right place to hide provider differences.

## What the sketch gets wrong or omits

| Sketch                                | Actual behaviour                                                                                                                                            |
|---------------------------------------|-------------------------------------------------------------------------------------------------------------------------------------------------------------|
| Requests carry a `modelId`            | Chat Completions uses `model`; `id` is the config-side model key                                                                                            |
| `apiKey` only shown at provider level | It is provider-level, but VS Code prompts for it and stores it; `${input:...}` is the supported indirection                                                 |
| Provider object needs a `url`         | `url` is optional at provider level (model discovery) and required per model unless discovery is used                                                       |
| No token limits                       | `maxInputTokens` / `maxOutputTokens` (or `contextWindow`) are needed, or VS Code cannot size the conversation                                               |
| Tool calling is a checkbox            | Agent use requires `toolCalling: true` **and** an upstream that actually supports tools                                                                     |
| "Custom API endpoint"                 | VS Code resolves the URL: an explicit `/chat/completions`, `/responses`, or `/messages` path is used as-is; otherwise it appends the path and inserts `/v1` |
| `apiType` is only `chat-completions`  | `responses` and `messages` are also supported, per model or per provider                                                                                    |

Also worth knowing: BYOK covers chat and utility tasks. Semantic search, inline
completions and embedding-based features still require a GitHub account.

## What was built

`agent-hub/bridge/server.mjs`, zero dependencies, Node 18+:

- `GET /v1/models`, `POST /v1/chat/completions`, `GET /health`.
- **Agent mode (default):** an ACP agent from `agent-hub/acp/agents.json` runs
  the turn using its own existing login. The bridge never sees a token. It
  honors `consent.json`, so a revoked agent is refused.
- **Provider mode (optional):** `openai` upstreams pass through; `anthropic`
  upstreams are translated both ways, with the key read from an env var.
- Streaming SSE in OpenAI delta format, with a guaranteed final `[DONE]`.
- Loopback-only bind and an optional bearer token for the bridge itself.
- A bounded system-prompt prepend that preserves the caller's own system
  message; optional per-model override.
- One JSON audit line per request in `logs/bridge.jsonl`, including agent,
  permission decisions and stop reason.
- Nineteen tests with a mock upstream and a fake ACP agent: config validation,
  model listing, both provider streaming paths, prompt merge, unknown model,
  auth, missing credential, audit line, ACP prompt building, platform
  override, agents-only config, consent decisions, a 403 for a missing
  consent entry, and process reuse. No network, no model calls.
- Verified live 2026-10-29 through the bridge with no API key: both `opencode`
  and `claude` returned `BRIDGE_ACP_OK`.

## What was rejected, and why

**Extracting or forwarding subscription login tokens.** The sketch routes
Claude Pro through "a local instance/session matching the Claude Pro CLI
authentication token". Reading that token and replaying it through a
third-party gateway would break on rotation, put the account at risk, and turn
a workstation into a credential broker.

The built path is different in kind: the bridge spawns the **official ACP
client** (`claude-agent-acp`, `opencode acp`) and lets it use the login it
already owns. No token crosses the bridge. The provider's own client still
enforces its usage limits and terms, which is exactly the boundary we want to
keep. Provider API-key mode remains available for people who prefer a direct
API.

**An "aggressive, uncensored" master prompt.** The bridge supports
`systemPrompt` and per-model `systemPrompt` for ordinary, user-authored
instructions. It does not ship a jailbreak prompt: provider safety systems
still run upstream, so the prompt would mostly add noise and a false sense of
control. If a task needs a specific persona or output contract, put that text
in the config — visible, editable, and honest about what it is.

**"Tricking" Copilot Chat.** Nothing needs tricking. Custom Endpoint is a
documented BYOK feature; the bridge is a normal endpoint.

## Recommended deployment

1. Run the bridge as its own process, not inside `hub.ps1`. It is long-lived;
   the hub is per-run.
2. Run it on Windows for this registry: Claude lives there and OpenCode is
   reached through `wsl.exe`. A WSL bridge has OpenCode but no Claude login.
3. Set `authTokenEnv` so only clients holding the bearer token can call it, and
   keep `agents.permission` at `deny` unless a task needs more.
4. Start with one model, verify a non-streaming reply, then enable streaming.
5. Only set `toolCalling: true` for models whose path actually translates
   tools — provider `openai` mode today; agent mode is text chat.
6. Watch `logs/bridge.jsonl` for the first week; it records model, agent,
   permission decisions, stream, status and duration per request.

## Open decisions for the Commander

- **Default agent.** `claude` or `opencode` first; both are verified through
  the bridge. The other stays available as a second model.
- **Tool calling in agent mode.** Not a translation gap: the agent owns and
  executes its tools, so VS Code cannot drive them through `tool_calls`. Agent
  mode stays chat-only; provider `openai` mode already supports tools.
- **Budget.** The bridge has no per-model spend cap; the agent's own limits
  apply. The hub's `--budget` does not see bridge traffic.
- **Responses API.** Not implemented; only Chat Completions. Add it only if a
  model you want is Responses-only.

## Sources

- [AI language models in VS Code](https://code.visualstudio.com/docs/agent-customization/language-models)
  — BYOK, Custom Endpoint, `chatLanguageModels.json`, URL resolution, token
  limits, `toolCalling`.
- [OpenCode Console / Zen](https://opencode.ai/docs/zen/) — base URLs,
  OpenAI- and Anthropic-shaped endpoints, pricing, free-model restriction.
- [`../bridge/README.md`](../bridge/README.md) — run and config reference.
