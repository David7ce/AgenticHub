# OpenCode control room: live acceptance

Date: 2026-11-22. Host: Windows. Branch `opencode-control` at `5965dcf`.
Design: [2026-11-22-opencode-control-design.md](../superpowers/specs/2026-11-22-opencode-control-design.md).
Plan: [2026-11-22-opencode-control.md](../superpowers/plans/2026-11-22-opencode-control.md).

A fresh `mcp/server.mjs` was driven over JSON-RPC against the real registry,
consent, results and audit log — not the server an OpenCode chat started
earlier. Prompts ran on disposable Git repositories under the system temp
directory, which is the only place Claude's grant allows a write-capable run
(its `writeTrees` is empty). Codex was not run: its weekly quota was exhausted
and resets at 13:30 on the day of the run.

## Results

| # | Acceptance item | Result |
|---|---|---|
| 1 | Labelled Claude session on a temp repo; restart the server; list it; follow-up depends on the earlier turn | **Pass.** The first turn answered `SAVED-41`; a new server process listed `acc-claude`; the follow-up answered `41`. |
| 2 | During a long turn, `job_status` shows the current tool and recent text; afterwards `session_log` shows the conversation | **Pass, with a note.** `last tool` appeared while the turn ran; live `recent text` did not (the answer arrived at the end of the turn). `session_log` showed prompt and answer (`LONG-DONE`). |
| 3 | Cancel a running turn; the session stays usable | **Pass.** `job_cancel` reported the callee stopped; the session settled to `idle`/`cancelled`; a follow-up answered `AFTER-CANCEL`. |
| 4 | Under `ask`, a request reaches the owner, a refusal is honoured and audited, an unanswered one times out | **Documented, not exercised live.** The Claude adapter never sent `session/request_permission`, so nothing was held, refused or audited. See the adapter matrix below. The hold/refuse/timeout mechanism itself is covered by real `hub-acp` child tests with a fixture adapter (`acp/tests/permissions.test.mjs`). |
| 5 | Two writers on one repo: the second is placed in a worktree; neither blocks | **Pass.** The second job ran in `<repo>/.git/agent-worktrees/20261122-031944-claude-acc-w2`, and both jobs answered. |
| 6 | Hand one session's turn to another by reference | **Pass (Claude to Claude).** The target answered `41` from the carried text; Codex-to-Claude is pending Codex quota. |
| 7 | No credential in transcripts, registry or audit log | **Pass.** Nine files (`sessions.json`, the transcript directory, `projects/logs/runs.jsonl`) checked for four key shapes: no match. |
| 8 | Existing hub tests still pass | **Pass.** `npm test`: documentation links and the full suite. |

## Which adapters ask

A direct `hub-acp --permission ask` run on a disposable repo, with a prompt that
runs `git status --short` through the shell:

| Adapter | Native mode tried | `session/request_permission` received |
|---|---|---|
| `@agentclientprotocol/claude-agent-acp@0.101.0` | `acceptEdits` (the attended mode) | none — the command ran |
| the same, explicit override | `default` | none — the command ran |
| native OpenCode | `build` (the attended mode) | none — the command ran |
| `@agentclientprotocol/codex-acp@2.6.0` | `workspace-write` | none — the shell was denied, so the command did not run (2026-11-23, see Codex below) |

This repeats the 2026-11-16 finding: Claude wrote files under `allow-reads`
without sending a request. The cause has still not been established inside the
adapters.

**Consequence, stated plainly:** with these adapters `ask` is not a supervision
boundary. It forces a write-capable native mode and holds whatever arrives, but
nothing arrives, so its real effect today is the same as `allow-all` within the
grant. The tool and the reference docs say so. Codex was checked on 2026-11-23
and does not change this: it sends no request either (see below).

## Codex (2026-11-23)

The same harness, items 1–6, run with `ACC_AGENT=codex` against local `main`
at `bc006cf`, through `@agentclientprotocol/codex-acp@2.6.0`, after the weekly
quota reset. **5/6.**

| # | Acceptance item | Result |
|---|---|---|
| 1 | Labelled session survives a server restart and recalls its turn | **Pass.** First answer had `SAVED-41`; the restarted server listed the session; the follow-up recalled `41`. |
| 2 | Live progress during a turn, then a readable `session_log` | **Pass.** Unlike Claude, both `last tool` and live `recent text` appeared while the turn ran. |
| 3 | Cancel a running turn; the session keeps working | **Pass.** The callee stopped; the session settled to `idle`/`cancelled`; a follow-up answered. |
| 4 | Under `ask`, a request reaches the owner, a refusal is honoured and audited | **Fail — adapter.** No `session/request_permission` arrived, so nothing was held or audited. The turn ended `idle`/`ok` with Codex reporting that access was denied when starting the shell: `git status` did not run. |
| 5 | A second writer on a busy repo is placed in a worktree | **Pass.** The second job ran in `<repo>/.git/agent-worktrees/20261123-171747-codex-acc-w2-cx`; both answered. |
| 6 | Hand one session's turn to another by reference | **Pass (Codex to Codex).** The target answered `41` from the carried text. |

Item 4 differs from Claude and OpenCode in outcome but not in kind: those ran
the command without asking, while Codex's `workspace-write` sandbox refused to
start a shell, also without asking. Either way no question reaches the owner,
so `ask` is still not a supervision boundary for any of the three adapters, and
the wording in the tool description and reference stays as it is. Whether the
denial comes from Codex's Windows sandbox or from its approval policy was not
established. Evidence: `projects/logs/acceptance-codex-cx.json` (local).

## Re-run after the final-review fixes

The whole-branch review found two Critical defects that the first run could not
see: a grant capped at `ask` also admitted `allow-all`, and starting a second
server reset another window's live session to `idle`. Both were fixed, along with
six Important findings (out-of-tree reads auto-approved under `ask`, a foreground
checkout never cleaned, a dead child's held permission surviving a model retry,
the raw prompt in the inflight file, case-sensitive tree identity, and a
stale-`running` session queueing forever). The harness was then run again against
`f0b7e1a` with fresh session labels: **7/9**, the same two adapter findings
(items 4 and 4b), and every other item passed again — including the worktree
placement and the credential sweep, which now covered 22 files because the first
run's transcripts were still on disk.

That run is the evidence for the merge recommendation: the branch behaves as this
report describes against the real Claude adapter, and the only failing checks are
the adapters' refusal to ask, not the hub's handling of a request.

## Defects the run found

1. **A denied first turn binds its label** (deferred since Task 4). The first
   attempt at item 6 started a labelled session without a `cwd`, so it ran
   under the server's own directory; consent denied it, and the label then
   belonged to that tree. Pointing the same label at the temp repo was refused
   with `label acc-hand belongs to claude in D:\Workspaces\AgenticHub\agent-hub`.
   A new label worked. The session never ran, so nothing was lost, but a
   mistyped first turn costs the label.
2. **Live text arrives late.** `recent text` is empty for most of a turn because
   the agent streams its answer at the end; `last tool` is the useful live
   signal. Acceptance 2 asks for both, so this is recorded rather than fixed.

## What was left behind

- Sessions from the run were closed (`acc-claude`, `acc-long`, `acc-cancel`,
  `acc-ask`, `acc-w1`, `acc-w2`, `acc-hand`, `acc-handsrc`). A worktree made by
  item 5 is kept under its temp repository's `.git/agent-worktrees/`.
- The disposable repositories are under the system temp directory (`acc-a-*`,
  `acc-b-*`, `acc-c-*`); nothing in a real project tree was modified.
- The audit log gained the run's lines, as every hub run does.

## Not covered here

- Codex: item 4b (an unanswered request times out) and Codex-to-Claude
  handoff; items 1–6 ran on 2026-11-23 (see Codex above).
- The OpenCode-side UI: these checks drove the MCP server directly. Whether
  OpenCode shows a held question through MCP elicitation is untested; the
  phase 0 note records that OpenCode advertises the capability.
