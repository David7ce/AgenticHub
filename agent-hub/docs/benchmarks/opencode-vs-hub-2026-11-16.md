# OpenCode and Agent Hub: initial continuity checks

Date: 2026-11-16. Host: Windows. OpenCode v2.3.0; Agent Hub revision
`8a770dd`. These are small live checks, not a comprehensive benchmark.

## Native OpenCode, no hub

In an empty temporary directory, an archived `opencode run` session used
`openai/gpt-6.1-sol`. It was told to retain a code and a one-line constraint
without using tools, and answered correctly. A second `opencode run` resumed
that same session with `opencode-go/deepseek-v4.1-flash`; it recalled both the
code and constraint in one line. No tools were called. Reported input/output
tokens: 10,236/6 and 10,572/23, respectively; reported cost was zero for
both, which does not establish the actual billing source or quota consumption.
This confirms cross-provider context continuity for this simple example, not
delegation or retention of tool evidence.

A separate live test through this OpenCode session's built-in `general`
subagent returned a supplied code and recalled it in a follow-up to the same
child session. The model was inherited, not independently selected; this does
not establish cross-provider subagent delegation or detailed UI trace quality.

Another matched arithmetic task and follow-up were sent to the native general
subagent and to an OpenCode worker through the hub, requesting
`openai/gpt-6.1-terra` on the hub side. Both returned 12, then 17 on follow-up.
The native worker inherited the parent model. This simple case checks task
transfer and child continuity, not real-world quality; only the hub reported
turn duration (5.9 seconds each), so latency is not comparable.

In a temporary directory, a local OpenCode config denied `edit` and `shell`.
Both a direct OpenCode run and a hub-dispatched OpenCode run with permission
`deny` were asked to create separate test files. Neither file existed afterward.
Both agents reported no local write tool available, rather than making a
write request that was explicitly rejected. Thus the result is inconclusive
about enforcement of a denied request. Both still had access to Code Mode and
could discover MCP tools; a deny policy on edit/shell is not an OS sandbox and
does not by itself establish restrictions on other integrations.

**Real Claude permission failure:** A Claude Sonnet job dispatched with
`permission: allow-reads` was instructed to create a test file in an authorized
temporary directory. It created the file. The audit record contains one
completed `edit` tool and `permissions: []`, so no ACP permission decision was
recorded. The policy handler only acts on permission requests; the reason the
adapter did not send one has not yet been established. Do not treat the hub's
`deny`/`allow-reads` as a verified read-only boundary for Claude. The earlier
simulated tests exercise the handler only and do not contradict this failure.
Codex and OpenCode subsequently also wrote files under `allow-reads`, without
permission requests. Mitigation: restricted dispatches are now rejected for
all agents before adapter startup. This is not read-only agent support.

The hub's focused offline consent, permissions, cancellation and tree-lock
tests passed 29/29 with simulated agents. These exercise denied grants,
acknowledged versus unacknowledged cancellation and write-lock conflicts;
they do not prove equivalent behavior in a real provider or in OpenCode.

## Live review and follow-up

A native OpenCode `general` subagent and Claude Sonnet through Agent Hub were
given the same synthetic queue requirements and asked for two tests. Both
covered the concurrency limit, cancellation and prevention of repeat runs.
Their follow-ups identified different valid failure cases. Claude's turns took
9.6 and 4.1 seconds, with $0.0877 and $0.0364 reported; subscription billing
was not verified. Native timing and comparable token usage were not measured.

In a separate read-only review, an OpenCode `explore` child and Claude Sonnet
through Agent Hub read the same four-line temporary JavaScript fixture. Both
identified the `> 2` vs `>= 2` bug at line 2. The hub response named
`Read queue-example.js` as one tool call; the native child reported the file
read. The fixture was re-read and remained unchanged. These results do not
evaluate the user's UI trace presentation, cancellation or real project work.

A later live cancellation test started an OpenCode worker through the hub and
cancelled its background job. The result was `cancelled`; its audit record
reported `cancelAck: true` after 58 ms. The task did not use tools or edit
files, so this does not test stopping an in-progress write.

A subsequent real test used an isolated temporary directory with an authorized
write-capable OpenCode worker. It wrote `ANTES`, began a 40-second wait, and
was meant to replace the text with `DESPUES`. Cancellation during the wait
returned `cancelled`; the audit records `cancelAck: true`, a completed patch and
a failed wait. After the original wait period, the file still contained
`ANTES`. This tests stopping before a later edit, not interruption of an edit
already underway or all possible child-process behavior.

### Live background visibility

A Claude Sonnet read-only background job reviewed the same fixture. At 4 and
8.7 seconds, `job_status` reported running, elapsed time, agent and directory;
at 31.4 seconds it also showed model `sonnet`, but no tool. The completed job
status named the last tool, `Read queue-example.js`; `job_result` listed both
`Find **/queue-example.js` and `Read queue-example.js`, the model, duration,
reported cost and result. The job took 36.5 seconds and reported $0.0526;
actual billing source was not established. This demonstrates status and a
tool-summary, not continuous live streaming or the quality of the user's UI.

In another live background test, an OpenCode worker was asked to execute a
20-second wait in a temporary directory, with no file or network access.
`job_status` did show `last tool: shell (pending)` while the worker was still
running. This proves point-in-time in-flight visibility by polling; it still
does not establish continuous event streaming or UI presentation quality.

### Two agents concurrently

Two read-only background jobs ran in distinct temporary directories: Claude
Sonnet reviewed the queue fixture while OpenCode with `openai/gpt-6.1-terra`
read a different marker file. A single `status` snapshot showed both running,
each with agent, directory and job ID; Claude's snapshot included a pending
`Find` tool. Both jobs completed successfully, retaining distinct results:
Claude identified the queue boundary bug, and OpenCode returned `ANTES`.
The hub returned separate saved results and tool summaries; Claude reported
$0.0509 and OpenCode $0.0000, without verified billing attribution. No writes
were requested. This verifies simultaneous reads and separation of these
results, not concurrent edits, a coordinated shared plan or UI ergonomics.

### Isolated concurrent writes

In a new disposable local Git repository at revision `ffbfebc`, two separate
worktrees were created. OpenCode (`openai/gpt-6.1-terra`) and Claude Sonnet
ran concurrently through Agent Hub with write permissions, each constrained to
create a different marker file in its own worktree. A status snapshot showed
both active. Each worktree contained only its expected untracked marker, and
the main checkout was clean. After reviewing both files, the coordinator
committed each result in its own branch and cherry-picked both into the
disposable main; both expected files were present and main was clean.
Claude reported $0.0553; actual billing was not verified. This is a small
disjoint-file test, not a conflict, automatic integration, security sandbox,
or proof for production changes. The temporary worktrees were retained.

To check explicit cross-agent transfer, the coordinator copied Claude's line-2
finding and the queue rule into a new native OpenCode child prompt. Without
reading the fixture, that child produced the correct boundary tests: two active
jobs must block, one active job must not. This validates a small explicit
evidence handoff, not automatic transcript sharing or context compression.

## Agent Hub baseline

Live read-only delegations and same-session follow-ups succeeded for Claude
Sonnet, OpenCode DeepSeek and Codex. A Codex continuation initially changed an
explicit model; revision `8a770dd` fixes the tested case. After the fix, a fresh
MCP server started Codex on `gpt-6.1-sol` and resumed it without an explicit
model; both the MCP response and Codex's native turn metadata confirmed Sol
on both turns. The follow-up retained the supplied code.

This was not the same task or runtime as the native OpenCode cross-provider
check, so timings and context sizes are not comparable. The Claude turn's
reported cost is not proof of an actual charge or of its funding source.

## Provisional assessment

OpenCode can already switch connected models within a conversation, and its
documented subagents support distinct model and permission settings. Agent Hub
provides a verified way to invoke separate Claude Code and Codex runtimes and
adds its own consent gate and audit records. These controls are not yet proven
equivalent or necessary for the owner's workflow. The native Claude Agent
provider mentioned in `docs/target-workflow.md` was not present in the active
model catalog inspected here; absence in that catalog does not prove the
integration cannot be installed or configured. The current OpenCode provider
documentation does not describe it.

Still untested: identical task and revision across both systems, native worker
delegation and follow-up, Claude subscription integration without the hub,
funding attribution, permission denials, cancellation, concurrent worktrees,
and comparable latency and resource usage. Do not remove the hub on this
evidence alone.

## T3 Code: documentation review, not a local test

On 2026-11-16, T3's official site advertised Windows support and the ability to
use installed Claude Code, Codex and OpenCode with existing sign-ins. Its
orchestrator design documents cross-provider child threads, follow-ups, traces,
worktree isolation and permission ceilings. Child threads receive a supplied
brief rather than the entire parent conversation. These are upstream claims, not
evidence that the user's plans, Windows installation, trace UI or permissions
work in practice. `Get-Command t3, t3code` found neither command on PATH; that
does not exclude a desktop installation elsewhere.

Sources: https://t3.codes/ , https://t3.codes/download and
https://github.com/pingdotgg/t3code/blob/main/docs/orchestration-v2/orchestrator-mcp-server.md .
Testing requires a separately approved installation or disposable launch and
review of its local configuration and any network exposure. No installation,
sign-in or T3 trial was performed here.

## Hermes: documentation review, not a local agent test

The Hermes executable is installed on this machine. Its Agent Hub grant is
disabled; no Hermes agent was dispatched and no credentials were inspected.
Current upstream docs describe the following, with local version and
entitlements still unverified:

- OpenAI: ChatGPT/Codex subscription OAuth as a model provider, plus a
  separately optional Codex app-server runtime and CLI delegation.
- Anthropic: API keys and an OAuth route that Hermes documents as requiring
  Claude Max extra-usage credits, not included plan allowance. Separate
  delegation to the unmodified Claude Code CLI is documented. Check Anthropic
  terms and actual billing; do not reuse tokens to bypass restrictions.
- OpenCode: Zen and Go model providers requiring their corresponding API keys;
  this does not show that the owner's existing Go subscription provides a
  usable key, nor does it demonstrate the OpenCode agent runtime.
- GitHub: repository workflows via `gh` or MCP; Copilot model access is an
  unsupported Labs plugin, with its own sign-in or eligible token.
- OpenRouter: key or documented browser OAuth; account billing applies.

Sources: https://hermes-agent.nousresearch.com/docs/integrations/providers ,
https://hermes-agent.nousresearch.com/docs/user-guide/features/codex-app-server-runtime ,
https://hermes-agent.nousresearch.com/marketplace/github-copilot and
https://hermes-agent.nousresearch.com/docs/user-guide/skills/bundled/autonomous-ai-agents/autonomous-ai-agents-claude-code .
