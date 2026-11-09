# Orchestration strategy

How agent-hub should use multiple AI harnesses, and whether it should.
Written 2026-10-24 from a direct conversation plus primary-source checks
(official repos/docs, not just blog summaries — each claim below says
which). This is a design document, not a changelog: it records decisions
and why, for whoever next changes `hub.ps1`'s worker set.

Note: written against `hub.js`, a Node implementation that has since been
retired in favor of `hub.ps1` (proven first with all three workers, then
given the same consent/logging contract — see `control-center.md`). The
strategy and research below don't depend on which script runs it, so they
stand; only the file name changed.

## 1. Two interfaces for two jobs

Don't route everything through one surface:

- **Interactive** (ambiguous asks, design decisions, anything to watch and
  redirect mid-task): a chat surface — this session, Claude Desktop, or
  StarNet's crew view. Human in the loop every turn.
- **Headless** (a fixed prompt, a known output, safe to run unattended):
  scripted CLI calls, the way `hub.js` already calls `claude -p`. No human
  in the loop; `consent.json` + `logs/runs.jsonl` do the governance instead.

Using a headless call for an open-ended question wastes budget on retries.
Using an interactive session for a repeatable job wastes your attention.
AgentHub's existing split — dashboard (StarNet or others) for interactive,
`hub.js` for headless — is the right shape; the rest of this document is
about what plugs into the headless side.

## 2. Is a swarm good for general tasks?

**No, not by default.** The research is consistent: a single capable agent
is the baseline, and multi-agent only earns its overhead when a task is
*genuinely* parallel, multi-role, or too large for one context window.

- Anthropic's measured token cost for multi-agent research work is roughly
  **15x** a single agent (FlowHunt's summary of Anthropic's own figures).
- A December 2025 arXiv preprint frames the cost as a "coordination tax":
  shared context has to compress into inter-agent messages, and team-size
  gains on static benchmarks don't carry over to tasks needing sustained
  environment interaction — coordination overhead and error propagation
  dominate instead ([arxiv.org/pdf/2512.08296v1](https://arxiv.org/pdf/2512.08296v1)).
- Where swarms do win: Anthropic's own lead+subagent research setup beat
  single-agent by ~90% on complex research — but that's parallel
  decomposition of one big, genuinely parallel task, not general-purpose
  dispatch.

**Decision:** default every request to one agent (Claude Code, today's
`hub.js` default). Reach for a second agent only when a task is explicitly
parallelizable, needs a tool/skill a given harness doesn't have, or you
want a cross-check on the first agent's output. Swarm is the exception,
not the routing default.

## 3. Role-based orchestration: what's actually possible

Claude Code's own subagent system (the `Task` tool) only spawns more Claude
Code subagents — same model, same runtime. There is no formal protocol for
it to address a foreign harness as a structured "agent."

What *is* possible, and what `hub.js` already does, is the process-level
version: shell out to the other harness's CLI, pass a prompt, capture
stdout, treat the text back as that specialist's report. That is real
orchestration — just a subprocess call, not a handshake. Nothing about this
needs new infrastructure beyond what `ADAPTERS` in `hub.js` already is.

One nuance per harness worth designing around (details in section 4):
**Hermes Agent is built to sit on the other side of this relationship** —
it ships first-party skills to delegate to Claude Code and OpenCode as
sub-agents. So "Claude Code orchestrates everything" isn't the only shape;
Hermes-as-orchestrator with Claude Code/OpenCode/others-as-workers is
equally natural, and avoids Hermes and AgentHub both trying to dispatch the
same call.

## 4. Harness capability table

Verified against each project's own repo/docs where noted; third-party
summaries are marked as such. Confirm the exact flags against
`--help`/the installed version before wiring a new adapter — this table is
a starting point, not a substitute for the verify step `hub.js`'s own
pattern already requires (register disabled → test once → enable).

| Harness                      | License / governance                                                 | Headless invocation                                                                                                                                                                                      | Orchestration notes                                                                                                                                                                                                                                                  | Source confidence                                                                                          |
|------------------------------|----------------------------------------------------------------------|----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|------------------------------------------------------------------------------------------------------------|
| **Claude Code**              | Anthropic                                                            | `claude -p "prompt" --output-format text --permission-prompts none`                                                                                                                                      | `Task` tool spawns Claude subagents only, not foreign harnesses                                                                                                                                                                                                      | Primary (in use in `hub.js`)                                                                               |
| **OpenCode**                 | MIT, provider-agnostic                                               | `opencode run "prompt"` (current docs); older versions used `--prompt`/`-p` — check `opencode run --help` on the installed version before relying on either                                              | No native delegation to other harnesses found                                                                                                                                                                                                                        | Official docs + third-party, flags not hand-verified                                                       |
| **Hermes Agent**             | Nous Research, open-source                                           | CLI session-based; official skills delegate to Claude Code/Codex CLI/OpenCode/OpenHands as sub-agents                                                                                                    | Built to be the orchestrator, not just a worker                                                                                                                                                                                                                      | Primary (Nous docs) + Arize technical review                                                               |
| **Goose**                    | Apache 2.0, governed by the Agentic AI Foundation (Linux Foundation) | `goose run -t "prompt" --no-session --output-format text`                                                                                                                                                | Multi-provider (incl. `claude-code` as a provider target), MCP-native for extensions                                                                                                                                                                                 | Docs (goose-docs.ai) + man-page mirror, not hand-verified                                                  |
| **Pi**                       | Open-source (earendil-works), minimal                                | `pi -p "prompt" --json`                                                                                                                                                                                  | No sub-agents or plan mode by default (extension-only); **no built-in sandbox/permission layer** — `--yolo` on the Rust port skips confirmation entirely                                                                                                             | Third-party reviews, consistent across sources                                                             |
| **DeepSeek Harness (`dsh`)** | MIT, DeepSeek AI, **developer preview — breaking changes expected**  | `dsh --profile headless "job"` — one fresh persisted session, prints the final answer, exits. Also `dsh --profile acp` (ACP stdio) and `dsh --profile sdk` (JSON-RPC stdio) for programmatic integration | Plugin architecture on Cordis ("everything is a plugin"); no delegation-to-other-harnesses feature found in the README                                                                                                                                               | **Primary** — read directly from `github.com/deepseek-ai/deepseek-harness` README and `apps/cli/README.md` |
| **StarNet**                  | MIT, androoAGI                                                       | CLI bin `bin/starnet.js`; sidecar also runs `sidecar/mcp/serve.js` (MCP server) and `sidecar/acp/serve.js` (ACP server) per its `package.json`                                                           | Not purely a dashboard — the sidecar can itself be addressed as an MCP/ACP server, so StarNet could be a callable node, not only the UI AgentHub's hub sits behind. Not yet confirmed which agent runtime (if any) the sidecar imports — see `starnet-comparison.md` | Primary (`package.json` read directly) + open items noted in `starnet-comparison.md`                       |

Two corrections from this round of research, logged so they don't get
re-asserted later:
- Earlier docs in this repo treated StarNet purely as "the dashboard."
  Its `package.json` shows the sidecar also serves MCP and ACP — worth
  re-checking once `sidecar/` source is read (open item in
  `starnet-comparison.md`).
- "DeepSeek harness" is a real, DeepSeek-AI-maintained project
  (`deepseek-ai/deepseek-harness`, the `dsh` CLI) — earlier research in
  this repo found only third-party DeepSeek-model CLIs (DeepSeek-TUI, Deep
  Code CLI) and missed the official one. Corrected here from the primary
  repo.

Harnesses not evaluated for adapters (out of scope here, named only because
they came up in `starnet-comparison.md`'s broader scan): Codex CLI, Gemini
CLI, Cursor, Copilot, Qwen Code, Zed Agent, and orchestrator frameworks
Paperclip/LangGraph/CrewAI/AutoGen/Mastra/AutoGPT/MetaGPT.

## 5. Centralizing control in this repo

AgentHub as the single control plane (one consent file, one log, one
adapter registry) is sound and should stay the pattern as more harnesses
get added. Two things to hold onto as the roster grows:

- **Decide orchestrator vs worker per task type, not by default.** Claude
  Code doesn't have to be the one deciding what to delegate — per section
  3, Hermes is built for that role. Whichever harness is deciding what to
  delegate should be the one calling `hub.js`'s `run()`, so there's one
  dispatcher per task, not two harnesses independently calling the same
  worker.
- **Don't loosen governance as the roster grows.** Every new adapter
  follows the same verify → `enabled: false` → test → `enabled: true` path
  already documented in `control-center.md`. Pi in particular has no
  sandbox of its own, so its AgentHub consent entry is the only safety net
  it gets — worth being stricter there, not looser.

## 6. Claude Desktop instead of the CLI?

No — Desktop has no headless/scripting interface, nothing equivalent to
`-p` / `--output-format` / `--permission-prompts none`. `hub.js` depends on
exactly those flags to run Claude non-interactively, so Desktop cannot
replace the CLI as a dispatched worker. Desktop's actual value is as a
*better human console* (first-party OAuth connectors, Artifacts, nicer
multi-turn UX) — the same role StarNet's dashboard plays, never the worker
side. Claude Code CLI stays the only way Claude participates as an
AgentHub-dispatched node.

## Open items

- **Update 2026-10-24:** OpenCode and Hermes are no longer open items —
  both were verified through `hub.ps1` (including a three-way fan-out) and
  are `enabled: true` in `consent.json`. Goose, Pi, and DeepSeek Harness
  remain unverified — this document gives the starting invocation for each,
  but each still needs the one-prompt verification step before
  `consent.json` flips `enabled: true`.
- StarNet's `sidecar/` imports haven't been read — settles whether it
  wraps an existing agent runtime or is custom, and whether its MCP/ACP
  servers are a second integration path alongside `hub.js`.
- `apps/cli/README.md` for DeepSeek Harness documents `--approval-policy`
  and `--permission-mode` flags for its headless/Auto-review layer — worth
  reading in full before writing its adapter, since it has its own
  approval-policy concept that could double up with AgentHub's consent gate
  the same way Hermes's delegation skills could double up with `hub.js`'s
  dispatch.

## Sources

- [Anthropic multi-agent research cost — FlowHunt summary](https://www.flowhunt.io/blog/multi-agent-ai-system/)
- [Coordination tax preprint](https://arxiv.org/pdf/2512.08296v1)
- [Single-vs-multi-agent decision guide — Lyzr](https://lyzr.ai/blog/multi-agent-vs-single-agent/)
- [Hermes Agent delegation skills — Nous docs](https://hermes-agent.nousresearch.com/docs/user-guide/skills/bundled/autonomous-ai-agents/autonomous-ai-agents-hermes-agent)
- [Hermes harness architecture — Arize](https://arize.com/blog/how-hermes-implements-open-source-agent-harness-architecture/)
- [Goose — governance/capabilities overview](https://www.promptlayer.com/glossary/goose-block)
- [Goose `run` flags — goose-docs.ai](https://goose-docs.ai/docs/guides/running-tasks)
- [Pi coding agent review](https://glukhov.org/ai-devtools/pi/pi-coding-agent-review/)
- [DeepSeek Harness — official repo README](https://github.com/deepseek-ai/deepseek-harness)
- [DeepSeek Harness CLI modes — official `apps/cli/README.md`](https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/cli/README.md)
- [OpenCode `run` / non-interactive mode](https://opencode.ai/v2/docs/cli/commands/)
- `starnet-comparison.md` (this repo) — StarNet `package.json`, read in full
- A curated link collection in the AI Tools & Services category — a starting point for finding more harness/tool candidates, not itself a claim about any specific tool
