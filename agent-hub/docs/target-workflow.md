# Target workflow and next-agent plan

Updated: 2026-11-15. Status: owner requirements agreed; implementation choice pending
validation. Read this before proposing further architecture or provider changes.

## Goal

One centralized CLI/TUI, similar to OpenCode but not necessarily OpenCode, where
the owner can interact with and coordinate multiple LLMs, agents and subagents.
Prefer one shared harness and one interface. Providers may include Anthropic,
OpenAI, Google and others, using API keys or eligible monthly subscription plans.
Monthly subscription access is a real requirement, not shorthand for API billing.

Preserve and share as much useful information as practical: project instructions,
conversation continuity, decisions, task state, skills, plugins, tools and evidence.
Optimize relevance, latency, context consumption and maintenance. A second GUI,
multiple mandatory chat apps or another always-running backend is not the goal.

## Requirements and boundaries

| Area           | Required behavior                                                                                                         |
|----------------|---------------------------------------------------------------------------------------------------------------------------|
| Interface      | One daily terminal workspace; GUI/mobile access is optional                                                               |
| Providers      | Model selection across providers; verify each specific account and plan                                                   |
| Authentication | API-key and subscription integrations where supported; never copy tokens between apps as a workaround                     |
| Billing        | Identify the funding source; no silent fallback from subscription to paid API usage                                       |
| Coordination   | Primary agent delegates bounded tasks, receives results and follows up with workers                                       |
| Harness        | Prefer shared tools, skills, instructions and permissions; integrate external runtimes only for demonstrated capabilities |
| Context        | Keep continuity when switching models; explicitly prepare child-task context and return evidence                          |
| Concurrency    | One writer per working tree; separate worktrees for simultaneous writers                                                  |
| Recovery       | Clear cancellation outcome, saved results, restart behavior and unfinished-task state                                     |
| Portability    | Windows is the present deployment; evaluate Linux and macOS support without adding Windows/WSL boundaries unnecessarily   |
| Maintenance    | Reuse maintained integrations; avoid custom adapters and duplicated orchestration without evidence                        |
| Git            | Keep only `main` remotely; temporary local branches/worktrees are acceptable                                              |

A model is not a complete agent runtime. Using a Claude or OpenAI model with
OpenCode's tools differs from running the full Claude Code or Codex environment.
The owner wants both kinds of coordination where useful, preferably through the
same interface. Do not promise that every external runtime becomes identical.

A subscription is not a universal API credential. A provider name alone does not
prove eligibility: verify the plan, authentication method, integration and version.
In particular, Google subscription compatibility remains unverified. Preserve the
existing [operating contract](reference/agent-contract.md); centralized permissions
or Git worktrees are not an OS sandbox. Usage-based cancellation is not proof of
a strict billing ceiling, especially with delayed reporting or concurrent runs.

## Context strategy

- Keep project rules and durable decisions in versioned files. Store task state
  and evidence in the appropriate local session records, without credentials.
- For model switches, preserve supported messages/tool results and compact older
  history when necessary. Summaries are lossy; retain pointers to original evidence.
- Give workers the objective, acceptance criteria, constraints, relevant paths,
  current revision/worktree, prior findings and expected result format. Do not
  assume a child can read its parent's transcript or hidden reasoning.
- Return findings, changed paths, checks, unresolved issues and artifact references.
  Retrieve large source files/logs on demand instead of repeatedly embedding them.
- Configure shared skills/plugins/tools in the selected platform. Native Claude
  Code or Codex settings are not automatically portable. Verify what each adapter
  forwards, replaces or disables; do not install every plugin just to unify names.
- Default to one worker. Add parallelism or an independent reviewer when the task
  warrants it. Never share secrets merely to maximize shared context.

## Candidate evaluation

These are candidates, not a migration commitment or a performance ranking.

| Candidate  | Role to evaluate                                                     | Main open question                                                                                  |
|------------|----------------------------------------------------------------------|-----------------------------------------------------------------------------------------------------|
| OpenCode   | First trial: central CLI, model selection and native subagents       | Do the owner's subscription integrations, model switches and worker lifecycle meet the tests below? |
| T3 Code    | Alternative shared control plane, headless or with its own interface | Does its coordination/recovery justify another server and external-client authentication?           |
| Pi         | Minimal, extensible CLI alternative                                  | Do required extensions add more maintenance than they remove?                                       |
| AgenticHub | Current ACP/MCP backend; retain as baseline or for verified gaps     | Which consent, audit, routing or usage controls are actually missing upstream?                      |
| Agent Deck | Terminal-session management alternative                              | Is session management enough, given WSL on Windows and assistant-bridge cancellation limits?        |

Source inspection on 2026-11-15 found documented ChatGPT subscription sign-in and
a built-in Claude Agent provider in OpenCode. The latter runs installed Claude
Code through its SDK while using OpenCode's tools/settings. This revises earlier
advice that a separate orchestration backend is necessarily required. It does
not prove live account eligibility, identical native behavior or an end-to-end
Windows result. Recheck released versions before configuring anything.

## Next agent: work in this order

1. Read this page, the operating contract and current setup/architecture docs.
   Inspect the actual installation and versions; distinguish repository examples
   from the owner's ignored configuration. Do not print credentials or assume
   the current chat transcript is available.
2. Inventory intended providers and funding sources. Build a small compatibility
   matrix: provider, exact plan/API account, supported login, installed version,
   available models, quota visibility and fallback policy. Ask only for missing
   account/plan facts; do not substitute an API key for subscription access.
3. Validate OpenCode alone first in a disposable project. Use maintained built-in
   integrations and the owner's own sign-ins. Preserve existing settings and
   grants. Initial roles: coordinator, implementer and read-only reviewer; select
   models from the actual authenticated catalog, not remembered model names.
4. Run the acceptance checks below, comparing against AgenticHub on the same
   starting revision and task brief. Record versions, commands, results and limits
   in `docs/benchmarks/`; keep fixture/data files in `bench/`. Separate offline
   fixture results from live-provider evidence. Do not spend provider allowance
   or modify authentication merely because this plan exists; obtain task-specific
   authorization when it has not already been given.
5. If an essential check fails, test the smallest alternative that addresses it:
   T3 for runtime coordination, Pi for an extensible CLI, or the existing hub for
   specific controls. Use one orchestration backend per trial to avoid recursive
   delegation and competing ownership.
6. Recommend one primary setup based on evidence. Explain any native skills/tools
   lost in translation and any extra processes required. Migrate only within the
   authorized scope; preserve existing grants, audit records and dirty worktrees.
   Update this page and the decision log after validation, not before.

## Acceptance checks

| Check                     | Evidence to collect                                                                                                 |
|---------------------------|---------------------------------------------------------------------------------------------------------------------|
| Subscription/API access   | Each intended funding source works; usage is attributed correctly; no unexpected paid fallback                      |
| Model switching           | A second provider continues a task using prior constraints, tool evidence and pending work                          |
| Cross-provider delegation | Coordinator gets a worker result, sends a follow-up and incorporates it                                             |
| Shared customization      | Required project rules, skills, plugins and tools work for each selected integration; differences documented        |
| Context efficiency        | Measure input/context overhead and handoff fidelity on the same brief; no unsupported claim of shared memory        |
| Concurrent edits          | Distinct worktrees, clear ownership and reviewed integration into `main`                                            |
| Permissions               | A deliberately denied operation stays denied in the worker                                                          |
| Cancellation/restart      | Observe whether work actually stops; distinguish persisted records from live processes and recover unfinished state |
| Quota/failure             | Exhaustion/unavailability is explicit; retries and billing changes follow the chosen policy                         |
| Performance               | Record startup, idle CPU/RAM across all involved processes and task latency on the same host                        |

## Upstream starting points

These are references to recheck, not copied third-party manuals or guarantees.

- [OpenCode providers](https://opencode.ai/docs/providers/),
  [agents](https://opencode.ai/docs/agents/),
  [compaction](https://opencode.ai/docs/compaction/) and
  [releases](https://github.com/anomalyco/opencode/releases).
- [OpenCode Claude Agent integration design](https://github.com/anomalyco/opencode/blob/dev/specs/v2/claude-agent-provider.md).
- [T3 external agents](https://github.com/pingdotgg/t3code/blob/main/docs/user/outside-agents.md)
  and [orchestration](https://github.com/pingdotgg/t3code/blob/main/docs/orchestration-v2/orchestrator-mcp-server.md).
- [Pi](https://github.com/earendil-works/pi/tree/main/packages/coding-agent).
- [Agent Deck assistant bridge](https://github.com/asheshgoplani/agent-deck/blob/main/docs/assistants/README.md).
