# Harness guide

A "harness" here is the thing an agent actually runs and shows itself inside
— a CLI session, a TUI, a desktop dashboard. agent-hub is not a harness;
it's the gate between a dashboard and whichever harnesses it's allowed to
call. This is current as of 2026-10-24 and based on public docs/comparisons,
not hands-on testing of every tool below — verify a harness here the same
way `hub.ps1` verifies a worker, before trusting it with real runs.

## The chosen stack

| Harness          | What it is                                                                                                                                                 | Role in this hub                                                                                                                                                                                                                                 |
|------------------|------------------------------------------------------------------------------------------------------------------------------------------------------------|--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| **Hermes Agent** | Nous Research's open-source agent framework — runs from terminal, messaging, or IDEs; broader than coding (personal-assistant, automation, scheduled runs) | Verified worker (`hermes -z`). It ships first-party skills to delegate to Claude Code/OpenCode on its own, too — see the note on double-dispatch below                                                                                           |
| **Claude Code**  | Anthropic's CLI coding agent — hooks, subagents, deep multi-step engineering                                                                               | Verified worker, called with `--permission-prompts none` and a budget cap                                                                                                                                                                        |
| **OpenCode**     | Open-source (MIT), provider-agnostic terminal coding agent; plan/build modes, LSP+MCP support, 400+ models via OpenRouter or BYOK                          | Verified worker, routed through WSL2 Ubuntu via `run-opencode.sh`                                                                                                                                                                                |
| **StarNet**      | androoAGI's local-first desktop "agent station" — pixel-art crew dashboard, recruits agents as crew, each with its own bounded workspace/permissions       | The dashboard this hub's consent/log layer is meant to sit behind. Its sidecar also serves MCP (`sidecar/mcp/serve.js`) and ACP (`sidecar/acp/serve.js`), per `starnet-comparison.md` — it may be addressable as a node, not only used as the UI |

Hermes's own delegation skills and this hub's worker pattern do the same job
from opposite ends — Hermes can call Claude Code/OpenCode directly, and
agent-hub can gate/log any of the three. Both are live now, so decide which
side owns delegation for a given task to avoid double-dispatching the same
run (e.g. don't let Hermes call OpenCode directly on a task StarNet already
routed through `hub.ps1`).

## Also evaluated: Goose, Pi, DeepSeek Harness

Researched in depth for `docs/orchestration-strategy.md` — not part of the
chosen stack yet, but real candidates with verified headless invocations:

- **Goose** (Block, now governed by the Linux Foundation's Agentic AI
  Foundation, Apache 2.0) — multi-provider, MCP-native. Headless:
  `goose run -t "prompt" --no-session --output-format text`.
- **Pi** (earendil-works, open-source) — deliberately minimal, no
  sub-agents/plan mode by default, and **no built-in sandbox or permission
  layer** — would need AgentHub's consent gate more than any other
  candidate here. Headless: `pi -p "prompt" --json`.
- **DeepSeek Harness (`dsh`)** — DeepSeek AI's own open-source harness
  (`github.com/deepseek-ai/deepseek-harness`, MIT), currently in
  **developer preview with breaking changes expected**. Headless:
  `dsh --profile headless "job"`; also offers `--profile acp` and
  `--profile sdk` for programmatic/editor integration.

## Other harnesses worth knowing about

Not part of the current stack, listed because they come up in every
comparison of this space:

- **Cursor** — IDE-first, best for interactive editor work, not CLI-driven.
- **Codex CLI** — OpenAI's agent, strongest for autonomous cloud/hands-off runs.
- **Aider** — git-native CLI, simple and cheap, good for disciplined small diffs.
- **Cline** — Apache-2.0 agent extension inside stock VS Code, BYOK.

None of these have a `consent.json` story worked out here — adding one
means repeating the same verify-then-enable steps as `hermes`/`opencode`.

## Picking among them

- Need deep multi-file engineering with review hooks → **Claude Code**.
- Need a free/open fallback or a second opinion without a Claude budget hit → **OpenCode**.
- Need one agent to coordinate several others, or to do non-coding automation (scheduling, messaging) → **Hermes Agent**.
- Need to see the crew, recruit/dismiss agents, watch them work → **StarNet**.

## Sources

- [OpenCode docs mirror / Real Python reference](https://realpython.com/ref/ai-coding-tools/opencode)
- [Terminal Trove — OpenCode](https://terminaltrove.com/ai-coding-agents/opencode/)
- [Arize — How Hermes implements an open-source agent harness architecture](https://arize.com/blog/how-hermes-implements-open-source-agent-harness-architecture/)
- [Hermes Agent docs — autonomous AI agents / delegation skills](https://hermes-agent.nousresearch.com/docs/user-guide/skills/bundled/autonomous-ai-agents/autonomous-ai-agents-hermes-agent)
- [StarNet — AI Success Lab walkthrough](https://aisuccesslabjuliangoldie.com/blog/starnet-ai-agent/)
- [Open Source Alternatives — StarNet listing](https://www.opensourcealternatives.to/item/starnet)
- [ssojet — 12 AI coding agents compared in 2026](https://ssojet.com/blog/ai-coding-agents-compared)
