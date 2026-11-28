# hubctl — the minimal control room

STATUS: active

No web UI, no daemon. It reads the state that already exists —
`consent.json`, `workspaces-panel/logs/runs.jsonl`, `results/inflight/`, git worktrees and the
two loopback services — and renders it. The one exception is the task queue:
one small SQLite file (`workspaces-panel/logs/hub.db`) that holds what is queued and who owns it.

```
AGENTHUB 2026-11-08 19:10                    local · loopback

agents    claude ok (61d)  opencode ok (61d)
worktrees 1 total · 0 agent
queue     2 queued · 1 review
bench     15/15 baseline · not run
egress    ok
running   none
last      opencode ok 65.7s
```

## Layout

`hubctl.mjs` is the entry point: argument dispatch, the help text, and the
re-exports other files and tests import. Shared plumbing lives in `common.mjs`
(paths, colour, `readJson`, consent checks, `buildHubArgs`, `parseFlags`).
There is one module per subcommand under `commands/`: `status`, `live`,
`report`, `spend`, `doctor`, `run`, `handoff`, `tasks`, `attach`, `worktree`,
`usage`, `bench`, `path`.

## Run it on Windows

The loopback services bind `127.0.0.1` **on Windows**. A WSL
process cannot reach them, so run `hubctl` from a Windows terminal:

```powershell
node hub.mjs status
node hub.mjs live
node hub.mjs brief   # start of a session
node hub.mjs search "timeout"   # full-text over runs, notes, git
node hub.mjs wrap   # end of a session: JOURNAL draft
```

From WSL it still shows agents, worktrees, egress and the run log, and prints a
hint when the loopback probes fail. `live` also reads `/proc`, so hub-managed
runs remain visible from either side; only external agents are platform-local.

## Commands

| Command | What it does |
|---|---|
| `status [--json] [--no-color]` | One-shot health snapshot, including the task queue |
| `live [--once] [--json] [--interval MS] [--no-external]` | Who is working now; `q` quits, `r` refreshes, `p` pauses |
| `report [--days N] [--json]` | Completed turns by agent and model: OK, failures, timeouts, p50/p95, cost, and why the rest failed (quota, auth, network, config, spawn, agent-error, timeout, budget) |
| `spend [--days N] [--date YYYY-MM-DD] [--by ...] [--json\|--csv]` | Tokens by project and day: OpenCode records, Claude cost-only, Codex rollout tokens/estimated cost |
| `doctor [--json] [--fast]` | Config coherence: registry vs consent, enforced `limits`, expiry, prose-vs-enforced budget, broken relative links in current docs, stale inflight/locks, `core.hooksPath`, `opencode mcp list` (`--fast` skips the network probes it cannot answer honestly). Exit 1 on any `fail` |
| `run <agent> [--worktree]` | One agent through `hub-acp`; consent checked first |
| `tasks add\|list\|show\|run\|done\|block\|cancel\|retry` | The thin work queue (see below) |
| `handoff <agent> [--cwd DIR] [--note TEXT] [--dry-run]` | Relay a tree to another agent when a pool runs out |
| `attach <session>` | Resume; infers the agent from `runs.jsonl` |
| `path <path>` | Both Windows and WSL spellings |
| `bench [args...]` | Run the benchmark |
| `limits [--json]` | One reading of the Codex plan windows into the cache; `brief` starts it in the background when the cache is over 30 minutes old (`AGENT_HUB_NO_REFRESH=1` stops that) |
| `usage [--days N] [--no-codex]` | Estimated Go allowance spent, Claude cost, and **Codex plan usage** (the windows its account reports: % used and reset time; cached in `logs/codex-limits.json`, shown by `brief` and checked by `doctor`) |
| `clean [--yes] [--repo PATH]` | Tidy what agents leave behind: clean worktrees and inflight records whose process is gone. Dry run without `--yes`; never touches a worktree with changes |
| `verify [dir] [--cmd CMD] [--timeout MS] [--task ID]` | Run the repo's own tests (`package.json` script, pytest, .NET, Cargo or Go) and return their exit code; `--cmd` overrides detection. `--task` saves the log as the task's evidence without changing its state. Add `--json` for a report |
| `worktree [--prune] [--repo PATH]` | List or prune agent checkouts; `--repo` (repeatable) also looks in another repository, since fan-out worktrees live inside the repo they came from |

Examples:

```powershell
node hubctl/hubctl.mjs run opencode --worktree --prompt "Fix the failing test"
node hubctl/hubctl.mjs live --once
node hubctl/hubctl.mjs attach ses_abc123 --prompt "Continue"
```

`run` creates a detached checkout under `.git/agent-worktrees/` when
`--worktree` is given, keeps it if the agent left changes, and removes it
otherwise. `attach` matches a full session ID or a prefix unique among the last
500 records in the current run log, so `--agent` is optional when a match is
found. An exact ID takes precedence; ambiguous matches are rejected. A prefix
unique in this limited window is not proof of uniqueness in older or rotated
logs, so use the full ID and verify the agent and working directory for recovery.
Restricted permissions still fail closed; resuming requires an existing grant.

## tasks — the thin work queue

One SQLite file, one worker loop, no dependency graph. It never launches an
agent itself: every run goes through `hub-acp`, so consent, `writeTrees`, budget
and the audit line stay in one place. Each task gets a worktree; the live tree is
never written.

```powershell
# queue a bounded change
node hubctl/hubctl.mjs tasks add --repo D:\repo --agent opencode `
  --title "fix the parser" --prompt-file task.txt --budget 0.5

# work it: claim -> worktree -> hub-acp -> review
node hubctl/hubctl.mjs tasks run --parallel 2
node hubctl/hubctl.mjs tasks list

# accept it: done needs evidence, never the agent's own word
node hubctl/hubctl.mjs tasks done t-20261109-040605-5a5b9c1d --evidence path\to\diff.patch
```

- States: `queued` → `running` → `review` → `done`; `blocked` and `cancelled`
  are recoverable with `retry`.
- The claim is one `BEGIN IMMEDIATE` transaction, so two terminals running
  `tasks run` never take the same row.
- A finished run lands in `review`, not `done`. `done` refuses without
  `--evidence` (a diff, a test run, or the review that accepted it).
- Every audit line from a queued run carries `taskId`, so `runs.jsonl` can be
  grouped per task. The full result and the agent's stderr are kept under
  `workspaces-panel/logs/tasks/<id>.json`.
- `AGENT_HUB_TASKS_DB` overrides the database path (tests and scratch queues).
- A worktree with changes is kept and named in `tasks list`; a clean one is
  removed.

## search — history from current source files

```bash
node hub.mjs search "timeout" --source runs --json
```

Search refreshes a disposable local SQLite index from audit logs, the working
handoff/journal/history notes, and Git commit messages. It never edits those
source files. Log rows belong to an exact file path: rotation, replacement and
truncation refresh the affected rows without duplicating archived records or
skipping the start of a new live log. Complete appended records remain incremental;
a partial last line waits for its terminating newline.

Deleted or renamed note/log sources are reconciled on the next refresh. Note
filenames are matched exactly, including SQL wildcard characters. Refreshes
update source rows and their progress metadata in one transaction; a failed
refresh can be retried without keeping a partial replacement.

Existing caches upgrade automatically by rebuilding their derived rows once.
The first search after upgrading may take longer. Unchanged files are skipped
using filesystem metadata; a changed log's indexed prefix is checked before its
old byte offset is reused. This is cache consistency, not tamper detection.

## spend — tokens by project and day

```bash
node hubctl/hubctl.mjs spend --days 7
node hubctl/hubctl.mjs spend --date 2026-11-08 --by project,model
node hubctl/hubctl.mjs spend --days 30 --json
```

- **OpenCode**: exact, from `opencode.db` (`session_message` joined to
  `session_v2` and `project`). Each assistant message carries its own tokens,
  model and timestamp.
- **Claude**: cost-only from `workspaces-panel/logs/runs.jsonl`. Records since 2026-11-08 carry
  `cwd`, so they get a project (fanout worktrees count as their repo); older
  ones stay `unknown`.
- **Codex**: tokens from its rollouts (`~/.codex/sessions`). Dollars appear as `~$x` only for models whose `costPerMillion` (`{input, output, cacheRead}`) is filled in `models.json`; no price is ever invented. `doctor` warns while a dollar cap has no price behind it.
- `cacheRead`/`cacheWrite` stay in their own columns: they are not added to
  input, and cache reads dominate the raw totals.
- `--by day,project,agent,model` accepts any subset; default is day+project.
- `--no-subagents` excludes sessions with a parent.
- `--utc` switches the day boundary; default is local.

The database is opened read-only and only `session_message`, `session_v2` and
`project` are queried. `account`/`credential` are never touched.

Client registration is documented in [Getting started](../getting-started.md).

The OpenCode database is read from the local home first
(`~/.local/share/opencode/opencode.db`; on Windows
`C:\Users\<you>\.local\share\opencode\opencode.db`). If that file is missing,
`spend` falls back to the WSL copy through `wsl.exe` and merges the rows: SQLite
cannot open a live WAL database across `\\wsl.localhost` ("database is
locked"), and `immutable=1` would skip the pages still in `-wal`.
`OPENCODE_DB`/`--db` override the path on either side.

## live — what is happening right now

`status` answers "is it healthy". `live` answers "who is working, where, and is
anything moving" without a daemon:

```
runs · 1
  1234  opencode  AgentHub         prompt  2s silent  12 tools  deepseek-v4.1-flash
trees · 1 locked
  C:\Projects\example  opencode(1234)  held  3m
  C:\Projects\example  4 change(s), last 3s ago
external · 0
  none from this side of the WSL/Windows boundary
recent · 5
```

- **runs** — `results/inflight/<pid>.json`: agent, tree, model, tool count,
  last tool and `updated`. `silent` is time since that last update; a turn with
  no update for `AGENT_HUB_STALL_MS` (default 15 min) is marked `stalled`,
  unless its last tool is still `running` (a build is allowed to be quiet).
- **trees** — locks from `acp/tree-lock.mjs`, plus a recursive `fs.watch` of the
  active trees. `git status` is never polled in a loop.
- **external** — processes matching `opencode|codex|claude|hermes|hub-acp|hub-mcp`
  from the host's process table. A WSL `live` cannot see Windows processes and
  vice versa; hub runs stay visible through the shared inflight files.
- **recent** — the newest audit lines, replacing the old `board` screen.

`--once` prints one frame and exits; `--json` returns the same model for
scripts. The view is advisory: agents launched outside the hub do not take tree
locks.

## What each line means

- **agents** — `consent.json`: `ok`, `disabled`, `unacked` or `expired`, with
  days until expiry.
- **worktrees** — `git worktree list`; “agent” counts the checkouts under
  `.git/agent-worktrees/`.
- **egress** — `tools/egress-posture.mjs` rules; warnings only.
- **running** — inflight rows, with age, model, job id and the last tool.
- **last** — the newest entries in `workspaces-panel/logs/runs.jsonl`.

## Environment

| Variable | Default |
|---|---|
| `AGENT_HUB_STALL_MS` | `900000` (15 min) |
| `AGENT_HUB_LOG` | `workspaces-panel/logs/runs.jsonl` |
| `AGENT_HUB_INFLIGHT` | `results/inflight` |
| `AGENT_HUB_LOCKS` | `results/locks` |

## Tests

```bash
node --test agent-hub/hubctl/tests/*.mjs
```

Covers consent lifecycle, run-log parsing, worktree counting, the status
render, hub argument mapping, session inference, and the live model. No
network.
