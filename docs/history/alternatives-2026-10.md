# Alternatives to StarNet, and which chat surface to use

STATUS: solved
Date: 2026-10-30. Sources: vendor sites, GitHub, Reddit/HN threads, comparison
round-ups. Claims marked "verified" were checked against the installed copy on
this machine or a live probe; the rest is vendor/marketing or community report.

The question was: is there something better than StarNet — CLI, GUI or
otherwise — and given the stack that already exists here, from which chat
should the work actually be driven?

## How candidates were scored

| Criterion                          | Why it matters here                                                           |
|------------------------------------|-------------------------------------------------------------------------------|
| Native app or CLI, not a web UI    | Stated preference; also keeps the surface local                               |
| Reuses existing logins             | Claude subscription, Codex, free OpenCode/Hermes models — no new keys in JSON |
| Agents / roles / dispatch          | The reason to look past a plain chat window                                   |
| Consent + audit                    | `consent.json` and `logs/runs.jsonl` are the hub's contract                   |
| Isolation                          | Parallel edits must not share a working tree                                  |
| Browser / DOM / screenshot context | Needed to test our own apps                                                   |
| Windows 11                         | The machine                                                                   |
| Maintained                         | No abandoned orchestrator under the daily workflow                            |

## The field

### Desktop cockpits

**StarNet** — v0.14.1 per starnetos.com, MIT, Windows + macOS (no Linux).
Installed here at `%LOCALAPPDATA%\StarNet`; sidecar `/api/health` → `"ok"` and
its ACP agent completes `initialize` + `session/new` (verified 2026-10-30).
Pixel-art station where each sprite is a real run; roles, budgets, schedules,
channels (Telegram/Discord/Slack/Matrix/webhooks), embedded browser view,
OAuth for Claude CLI / Codex / Grok / Kimi, per-provider `baseUrl`, an
OpenAI-compatible `/v1` ingress, and ACP. It can also *import* an existing
OpenClaw or Hermes agent home (`sidecar/harness-import.js`), which is the one
integration path that actually touches this workspace today.

Its isolation is real but different from ours (verified in
`sidecar/checkpoint-store.js` and `execution-profiles.js`): one
`WORKSPACES/<agentId>` per agent, shadow git dir with `--work-tree`, and
execution profiles `safe-cell` (Docker), `remote-ssh`, `trusted-project`,
`this-computer`. There is no `git worktree add` anywhere in the install —
5 occurrences of the word, all of them that shadow work-tree or a comment.
So: not the same primitive as `fanout-acp --worktree`, and it does not see
the hub's worktrees.

**Nimbalyst** (formerly Crystal) — MIT, Electron, Windows/macOS/Linux, free for
individuals. Closest product to "GUI over worktrees": one optional worktree per
session, per-session diff review, session kanban, wiki the agents write.
Agents: Claude Code and Codex native, OpenCode and Copilot in alpha. Models:
Anthropic and OpenAI only. No consent model, no roles/dispatch, no free-model
pool.

**Conductor** (Melty Labs) — free, macOS only, Claude Code + Codex, worktree
per agent, diff-first review, polished. Excluded on platform alone.

**Paperclip** — open-source "company of agents": org chart, managers, job
descriptions, task tracking. Node server + React UI, self-hosted. It is a web
dashboard and a business simulation; neither is what this workspace wants.

### Worktree boards

**Vibe Kanban** (BloopAI) — Apache-2.0, 28.5k stars, `npx vibe-kanban`,
cross-platform, worktree per workspace, 10+ agents including OpenCode and
Claude Code, built-in browser with devtools, inspect mode and device emulation.
On paper the single best fit for this stack. **It is sunsetting**: the repo
README opens with "Vibe Kanban is sunsetting", Bloop shut down in April 2026,
and it is now community-maintained. Adopting it as the daily driver would put
an unmaintained orchestrator under the workflow — exactly the failure mode the
"maintained" criterion exists to avoid.

Also in this category: Claude Squad (tmux, CLI-only), Superset (newer,
YC-backed, closed), Gastown/Antfarm (unattended overnight runs, heavy), Clash
(predicts semantic merge conflicts between worktrees — genuinely useful, but a
helper, not a cockpit).

### Editors that speak ACP

**Zed** — now has a native Windows build (stable line 1.25.x) and an Agent
Panel that drives external agents over ACP. Since the hub already exposes
`claude`, `opencode`, `hermes` and `starnet` as ACP agents in
`acp/agents.json`, Zed can host them without a new orchestrator. No worktree
board, no roles, no consent UI — but it is native, fast, and reuses the hub
as-is.

**VS Code** — the Copilot harness caps BYOK context at 128K
(`vscode#336797`); the Local harness honours the configured window. It is the
only surface here with real browser/DOM/screenshot context built in.

### CLI agents

Claude Code (best tool use; now has native worktree isolation via
`isolation: worktree` on subagents), OpenCode (free models, TUI, ACP),
Goose (Apache-2.0, Rust, desktop + CLI + API, MCP, 15+ providers), OpenHands
(Docker isolation, CLI + web), Crush (Charm, TUI, single focused agent),
Aider (git-native pair programming, no agent loop), Pi (highly customisable).
All of these are *workers*, not cockpits — which is what the hub already
treats them as.

## What this means

No candidate beats the stack end-to-end. Each one wins a column and loses
three:

|                       | StarNet                      | Nimbalyst    | Vibe Kanban    | Zed     | Paperclip       | This stack                        |
|-----------------------|------------------------------|--------------|----------------|---------|-----------------|-----------------------------------|
| Native, not web       | yes                          | yes          | local web app  | yes     | web             | CLI + TUI                         |
| Existing logins       | yes (OAuth CLIs)             | Claude/Codex | via agents     | via ACP | via agents      | **yes, incl. free models**        |
| Roles / dispatch      | **yes**                      | no           | no             | no      | yes (org chart) | roster + router                   |
| Consent + audit       | own, separate                | no           | no             | no      | no              | **`consent.json` + `runs.jsonl`** |
| Worktree isolation    | per-agent workspace + Docker | **yes**      | **yes**        | no      | no              | **`--worktree`**                  |
| Browser / DOM context | own view                     | no           | **yes**        | no      | no              | via VS Code                       |
| Windows 11            | yes                          | yes          | yes            | yes     | yes             | yes                               |
| Maintained            | v0.14.1, active              | active       | **sunsetting** | active  | active          | ours                              |

The honest conclusion: **there is no product that gives a visual cockpit over
this hub's own consent, audit and worktrees.** StarNet has the best cockpit but
its own governance; Nimbalyst has the best worktree GUI but no governance and
Anthropic/OpenAI only; Vibe Kanban would have been the fit but is dying.

## Decision

1. **Chat surface stays VS Code Chat.** It is the only one with workspace
   context *and* a browser with DOM/screenshots, which is the stated need.
   Model = AgentHub (Local harness) when context matters, native harness when
   tools matter.
2. **Build/hard coding stays Claude Code** (or the native Claude harness),
   once the weekly limit resets.
3. **Routine and cheap work stays OpenCode/Hermes** through `hubctl run`.
4. **One surface, not five.** The hub becomes an MCP tool server that the
   agent in the chat can call (`ask_agent`, `fanout`, `route`, `agents`), so
   routing and other models happen *inside* the session. See the follow-up
   section above.
5. **OpenCode is the strongest single-surface candidate as of 2.2.4**, but not
   yet the default: it now has worktrees (v2.0.27) and can drive the Claude
   subscription (v2.2.3), which were its two gaps. It needs a Windows install
   to see `claude.exe`; until then the WSL copy only reaches free/gateway
   models. Zed remains the ACP-native fallback editor.
6. **StarNet is optional now**, demoted from pilot: the visual cockpit is
   explicitly not the priority, and its governance is separate from ours.
7. **Rejected:** Vibe Kanban (sunsetting), Conductor (macOS), Paperclip (web
   org simulation), Nimbalyst (no governance, no free models), Gastown-class
   pipelines (too heavy for one machine), and the `ANTHROPIC_BASE_URL` gateway
   (needs the tool_use translation layer we already rejected).
8. **The gap is small enough to own.** A read-only TUI over
   `logs/runs.jsonl`, `consent.json` and the worktree list — `hubctl` grown a
   `watch`/`board` screen — covers "see what the swarm is doing" without a
   third-party orchestrator, a web server, or a second source of truth.

One rule regardless of choice: **never run two orchestrators on the same
working tree.** StarNet uses its own workspaces; the hub uses `--worktree`.
Pick one per task.

## Follow-up: "Claude Code, but agnostic" (same day)

The five-surface workflow above is the thing to avoid. The real ask is one
surface that keeps Claude Code's ergonomics — files, git, worktrees, skills,
plugins, Playwright, web search, remote/mobile, subagents, images — and adds
model-agnostic routing and calls to other agents. Checked what exists:

- **OpenCode** is the closest shipped product to that description: MIT, any
  provider, per-agent model *and* effort (`model` + `/variant` config options),
  subagents as child sessions, skills, plugins, MCP, images in the prompt
  (`promptCapabilities.image: true`), **built-in worktree tools**, and four
  surfaces — terminal, Windows desktop app, web app, and ACP inside
  Zed/Cursor/Windsurf. It is not a VS Code extension with native diffs; it is
  the whole agent, embedded.
- **Kilo Code** is the VS Code-native version of the idea: Ask/Architect/Code/
  Debug/**Orchestrator** modes, a model per mode, 500+ models BYOK, images, MCP,
  plus a JetBrains plugin and a CLI. Roo Code is the same lineage. Neither has
  native worktree management (Roo has an open request, `Roo-Code#10646`) and
  neither has Claude Code's skills ecosystem or mobile.
- **Cline** turned itself into a runtime: Apache-2.0 SDK (May 2026) powering the
  IDE extension, CLI 2.0 (interactive TUI + headless + JSON), and a kanban.
  Model-agnostic, subagents, checkpoints, images.
- **Claude Code's own routing seam**: `ANTHROPIC_BASE_URL` "changes where
  requests are sent, not which model answers them" (Anthropic docs), so people
  point it at a gateway that routes by model name and get per-subagent model
  routing. The catch: a custom base URL means provider keys, not the
  subscription, and the gateway must translate Anthropic `tool_use` for every
  upstream. This is the translation layer already rejected in
  `copilot-bridge-assessment.md`.
- **VS Code image attachments + custom endpoint**: broken without a GitHub
  sign-in (`vscode#319255`), which is why the bridge is not a path to
  multimodal chat.

So no product is "Claude Code but more agnostic" — the market splits into
quality (Claude Code, Codex) and agnosticism (OpenCode, Kilo, Cline, Roo).
The cheap way to have both is not to replace the surface but to give it the
missing organ: **expose this hub as an MCP server**, so the agent in the chat
can call the other agents and models as tools.

    Claude Code (VS Code ext / CLI)  ← the one surface
      ├── skills, Playwright MCP, git worktrees, images, mobile   (already)
      └── MCP "hub": ask_agent / fanout / route / agents          (missing)

That keeps `consent.json` and `runs.jsonl` in the path, adds no UI and no
second login, and makes the hub a tool instead of a destination. Its limit is
honest: Claude stays the main loop, the other models are callees, and MCP
results are text — an image from a free model cannot come back through it.

**Built the same day**: [`../mcp/`](../../mcp/) implements exactly that, with
`ask_agent`, `fanout`, `route` and `agents` over stdio, registered in the
repo's `.mcp.json`. 26 tests, 7 of them end-to-end through the real consent
gate and audit log.

The alternative, if the *main loop* itself must be a free/any model, is
OpenCode as the single surface (or Kilo if VS Code-native matters more than
worktrees and skills). That is a replacement, not an addition, and it is the
escape hatch — not the first move.

## Correction: Hermes was filed as a worker and it is a platform (2026-10-30)

The earlier pass listed Hermes as a cheap summarizer. That was wrong. Verified
against the installed copy (`%LOCALAPPDATA%\hermes\bin\hermes.exe`,
`config.yaml`, `hermes --help`, `hermes status`):

| Capability                   | Evidence                                                                                                                                      |
|------------------------------|-----------------------------------------------------------------------------------------------------------------------------------------------|
| Git worktree per session     | `--worktree` flag; `hermes worktree list/audit/prune/restore` archives dirty idle trees to `refs/hermes/archive/<tree>`                       |
| Multi-role orchestration     | `hermes kanban swarm --worker PROFILE:TITLE[:SKILL] --verifier --synthesizer`: parallel workers → verifier → synthesizer, over a SQLite board |
| Per-task routing             | `kanban set-model` overrides model/provider per task                                                                                          |
| Subagents                    | `delegation.max_iterations: 250`                                                                                                              |
| Mixture of Agents            | `hermes moa`, plus `fallback_model` on 429/529/503                                                                                            |
| Model-agnostic               | `--provider` (built-in or user-defined), `--base-url`, `--model`; providers seen: Nous Portal, GitHub Copilot, Anthropic, Copilot ACP         |
| Skills                       | `-s/--skills`, `skills.creation_nudge_interval`                                                                                               |
| Images                       | `chat --image PATH`                                                                                                                           |
| Effort / context             | `--reasoning none…ultra`, compression with a 0.5 threshold, prompt caching                                                                    |
| Browser, LSP, code execution | `browser`, `lsp`, `code_execution`                                                                                                            |
| Remote / mobile              | `gateway` with Telegram, Discord, WhatsApp, Slack, Signal, Teams, Google Chat; **gateway already running, Telegram connected**                |
| Memory                       | `memory.provider: claude-mem`, with the claude-mem MCP server already registered                                                              |
| Governance                   | `approvals`, `security` (OSV supply-chain audit), secret redaction, tirith pre-exec scanning, `pause`/`resume`                                |
| Interop                      | ACP agent, MCP client, `proxy` (OpenAI-compatible to OAuth providers), `peer` (bot-to-bot across machines)                                    |

So Hermes matches the user's list more completely than any product surveyed,
including Claude Code. The gap is **model access, not architecture**:
`hermes auth status anthropic` says *logged out*, so today it runs on Nous
free models (`upstage/solar-mini4:free` default) with a GitHub Copilot
credential available via `gh auth token`. Pointing it at the Claude Code OAuth
token is not an option worth taking — it is outside Anthropic's terms and
breaks without warning.

**Hermes vs OpenCode as the single surface:**

|                      | Hermes                                       | OpenCode                                                                                            |
|----------------------|----------------------------------------------|-----------------------------------------------------------------------------------------------------|
| Coding loop maturity | general-purpose agent; unproven on refactors | purpose-built, v2.2.4, per-agent model + effort                                                     |
| Worktrees            | **yes, first-class**                         | **yes since v2.0.27** — `worktree_create/list/remove`, "Run session in" picker, base-branch chooser |
| Roles / swarm        | **yes, kanban swarm**                        | subagents only                                                                                      |
| Remote / mobile      | **yes, gateways**                            | `serve` + `pair` (LAN or tunnel)                                                                    |
| Desktop / web app    | TUI only                                     | **desktop (Windows), web, IDE/ACP**                                                                 |
| Skills / plugins     | yes                                          | **yes, plus plugins**                                                                               |
| Images               | yes                                          | **yes, in-prompt**                                                                                  |
| Claude subscription  | no (logged out)                              | **yes since v2.2.3** — Claude Agent provider, on the machine where `claude` is installed            |
| Model access today   | free Nous + Copilot                          | **free models working**                                                                             |

Neither is a clear winner on paper, which is exactly why this needs one real
task run through both rather than another table.

## OpenCode 2.2.4, checked 2026-10-30

The installed copy auto-updated from 2.2.2 to **2.2.4** the same day, so these
are live here, not just release notes:

| Change                                                                                                                                                                        | What it means for this workspace                                                                                                                                                                                                                                                                                                                                                              |
|-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|-----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| **Built-in worktree tools** (v2.0.27) `worktree_create/list/remove` in Code Mode, plus the "Run session in" picker (v2.2.2) and **Choose base branch** (v2.2.4, `Ctrl+Alt+.`) | Corrects an earlier claim of mine: OpenCode **does** have worktrees, and has had them since 2026-10-12. The gap I listed against Claude Code no longer exists.                                                                                                                                                                                                                                |
| **Claude Agent** (v2.2.3) — provider picker copies `claude auth login`, installs Claude Code, verifies the connection                                                         | The missing piece from the bake-off: OpenCode can drive the **Claude subscription** instead of only free/paid gateway models. Constraint: `claude` must be on the same machine — it is, and WSL can run it directly (the installed Claude CLI, signed in). **Corrected 2026-10-31:** the earlier claim that this needed a Windows build of OpenCode was wrong. |
| **Persistent desktop terminals** (v2.2.4) — session PTYs, scrollback survives a server restart, synced with TUI                                                               | Only pays off in the Desktop app. For the WSL TUI it changes little.                                                                                                                                                                                                                                                                                                                          |
| **Artifacts** (v2.2.4) — `"experimental": { "artifacts": true }`, `artifact_create/read/update/delete`, built-in local static provider                                        | Useful for a website project: an agent can publish a built HTML page (a design variant, a report) and you open it, without `pnpm dev`. Keep the provider on loopback; it serves files. Nothing for agent-hub.                                                                                                                                                                               |

Net effect: the bake-off is now **OpenCode (Windows, Claude Agent + free
models + worktrees) vs Hermes (kanban swarm + gateways)** — a much closer
fight than before, and OpenCode is the one that gained the most.

## Correction: the surface moved to OpenCode (2026-11-01)

Decision 1 above ("Chat surface stays VS Code Chat") is superseded. Two of
its load-bearing reasons turned out not to hold once actually checked,
prompted by the user noticing VS Code felt capped and slow:

- **The Copilot relay, not VS Code itself, was the cap.** VS Code's Session
  Target list has at least four harnesses (`docs/vscode-harnesses-and-remote.md`),
  and "Copilot" — the default — routes every prompt through the Copilot SDK
  in the Agent Host. That relay is what caps context and adds latency, not
  anything inherent to the editor; VS Code's own **Claude** target (the
  Anthropic Claude Agent SDK, no Copilot in the path) would not have the same
  ceiling, for whoever stays on VS Code. OpenCode and Claude Code both talk
  to a model directly, so neither hits it.
- **The browser/DOM requirement was a missing MCP registration, not a VS
  Code-only capability.** MCP is a protocol, not something Claude Code or
  VS Code owns. `@playwright/mcp` (`npx @playwright/mcp@latest`) is now
  registered in OpenCode's global config (`~/.config/opencode/opencode.json`)
  next to `agent-hub`, both verified `✓ connected`. The "stated requirement"
  this decision leaned on is satisfied without VS Code.
- A third assumption from the original framing — that moving off Claude Code
  would cost its mobile/remote continuity — doesn't apply here either: the
  user's mobile and Claude-web sessions already run independent of local
  Claude Code sessions, through GitHub (API or Claude's own GitHub
  integration), not through this hub or claude-mem.

What's left of the old decision stands: build/hard-coding is still Claude
Code (now reached **through the hub**, not typed into directly), StarNet
stays optional, and the rejections (Vibe Kanban, Conductor, Paperclip,
Nimbalyst) are unaffected. Updated: `agent-hub/README.md`, `AGENTS.md`,
`docs/agent/HANDOFF.md`.

## Still unverified

- StarNet's UI quality and stability under real daily use — only the sidecar
  and ACP were exercised, never the desktop shell.
- Whether StarNet's imported Hermes agent keeps working model routing.
- Zed's ACP panel against `starnet` specifically (only claude/opencode/hermes
  were driven through it indirectly).
