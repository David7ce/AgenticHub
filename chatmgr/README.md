# chatmgr — one list of every conversation

An OpenCode TUI plugin that shows OpenCode, Codex, Claude Code and Hermes
conversations in one searchable table, filters them, previews them, and deletes
a selection in one batch through each agent's own CLI.

It is a plugin, not a fork: OpenCode 2.2.6 ships the TUI plugin API this uses
(`ui.router`, `ui.dialog`, `keymap.layer`, `session.panel`).

## Use

Inside OpenCode: `Ctrl+Shift+L`, or the command palette entry
**Conversations: OpenCode, Codex, Claude, Hermes**, or `/conversations`.

| Key | Action |
|---|---|
| `↑` `↓` / `PgUp` `PgDn` | Move |
| `Space` | Select / deselect the row |
| `a` / `c` | Select all filtered / clear selection |
| `p` | Preview the transcript |
| `Enter` | Resume (OpenCode opens the session; others show their own command) |
| `Ctrl+D` | One batch confirmation, then delete |
| `f` `o` `b` `x` `/` | Filter by agent, exact path, before-date, archived, text |
| `r` | Refresh |
| `Esc` | Leave the panel |

"Before date X" means **last activity before local midnight at the start of X**.
A row active at 00:00 on X is not "before X".

The panel calls `src/cli.mjs`, so every action is also available headless:

```powershell
node agent-hub/chatmgr/src/cli.mjs list --json
node agent-hub/chatmgr/src/cli.mjs list --agent codex,claude --before 2026-11-01 --archived
node agent-hub/chatmgr/src/cli.mjs preview --key codex:01a1...
node agent-hub/chatmgr/src/cli.mjs delete --keys codex:X,hermes:Y --dry-run
node agent-hub/chatmgr/src/cli.mjs delete --keys codex:X,hermes:Y --yes
node agent-hub/chatmgr/src/cli.mjs backups
node agent-hub/chatmgr/src/cli.mjs restore --manifest <backup>/manifest.json
node agent-hub/chatmgr/src/cli.mjs backup-remove --dir <backup>
```

## What each agent can do

Verified on 2026-11-09 against the installed CLIs, not assumed:

| Agent | List | Preview | Resume | Archive | Delete |
|---|---|---|---|---|---|
| OpenCode 2.2.6 | `session_v2` (read-only) | `session_message` | `opencode --session <id>` | — | `opencode session delete` |
| Codex 0.167.0 | `sessions/`, `archived_sessions/` | rollout JSONL | `codex resume <id>` | `codex archive` | `codex delete --force` |
| Claude Code 2.1.319 | `~/.claude/projects/*/*.jsonl` | JSONL | `claude --resume <id>` | — | **disabled** |
| Hermes 0.23.0 | `state.db` (read-only) | `messages` table | `hermes chat --resume <id>` | bulk only | `hermes sessions delete --yes` |

Claude Code has no per-session delete command. `claude purge` deletes a whole
project and `claude rm` only handles background agents, so the manager marks
Claude rows read-only and says why. It never edits `~/.claude` directly.

## Safety

- **Running sessions are never deleted.** Codex uses its own
  `thread-writer-locks/<id>.lock`; Hermes uses a missing `ended_at`; OpenCode
  compares `time_busy` and `time_idle`. If a provider cannot report runtime
  state reliably, deletion is blocked instead of guessed.
- **The current session** is blocked even if selected.
- **Backup before mutation.** Every batch writes
  `backups/<timestamp>/manifest.json` plus a copy of each file-backed
  transcript, or a JSON dump for database-backed agents. If the backup fails,
  nothing is deleted.
- **Restore:** `cli.mjs restore --manifest …` copies file-backed sessions back.
  Database dumps are exported for re-import through that agent's own CLI.
  Backups are removed only by an explicit `backup-remove`.
- **Local only.** These are local stores; no remote deletion is attempted.
- **Side effects are named in the confirmation.** OpenCode deletes child
  sessions (the count is shown before confirming); none of the providers touch
  git worktrees or project files from here.
- **Failures do not stop the batch.** Each row reports `ok`, `failed`, `blocked`
  or `cancelled`; cancelling stops before the next item.

## Wiring

TUI-only plugins are configured in `~/.config/opencode/cli.json`:

```json
{
  "plugins": ["D:/Workspaces/AgentHub/agent-hub/chatmgr"]
}
```

`opencode plugin list` should show it as a `local` plugin. Restart OpenCode after
moving the directory.

## Tests

```powershell
node --test agent-hub/chatmgr/test/filter.test.mjs agent-hub/chatmgr/test/selection.test.mjs `
  agent-hub/chatmgr/test/plan.test.mjs agent-hub/chatmgr/test/backup.test.mjs `
  agent-hub/chatmgr/test/execute.test.mjs agent-hub/chatmgr/test/providers.test.mjs
```

38 tests, no network and no real conversations: fixtures build a fake Codex
home, Claude home and two SQLite stores in a temp directory. Filtering (including
the midnight boundary), selection/select-all/pruning, cancellation, partial
failures, blocked reasons, backup/restore and every provider parser are covered.

No real conversation was deleted while building this.

## Not yet: VS Code / Copilot

VS Code is a host, not a conversation owner. Copilot Chat history lives in
GitHub's service and in VS Code's storage, and there is no supported deletion
command for a single chat. Adding it needs a separate read-only integration
first; until then it is deliberately out of the list rather than faked.
