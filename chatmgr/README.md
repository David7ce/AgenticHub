# chatmgr — one list of every conversation

An OpenCode TUI plugin that shows OpenCode, Codex, Claude Code and Hermes
conversations in one searchable table, filters them, previews them, and deletes
a selection in one batch through each agent's own CLI — except Claude Code,
which has none, so only that session's own files are removed after a backup.

It is a plugin, not a fork: OpenCode 2.2.6 ships the TUI plugin API this uses
(`ui.router`, `ui.dialog`, `keymap.layer`, `session.panel`).

## Use

Inside OpenCode: `/conversations` (or `/chats`) is the dependable way; `Ctrl+Shift+L` only works in terminals that report it. Also the command palette entry
**Conversations: OpenCode, Codex, Claude, Hermes**, or `/conversations`.

| Key | Action |
|---|---|
| `↑` `↓` / `PgUp` `PgDn` | Move |
| `Space` | Select / deselect the row |
| `a` / `c` | Select all filtered / clear selection |
| `p` | Preview the transcript |
| `Enter` | Resume (OpenCode opens the session; others show their own command) |
| `m` | Archive / unarchive the selection (Codex only, reversible) |
| `t` | Show/hide automated sessions (tool-payload summarizers, auto-review guardians, hub-started runs); hidden by default |
| `k` | Toggle backup on/off for the next delete (off = permanent, no undo) |
| `Ctrl+D` | One batch confirmation, then delete the marked rows (the row under the cursor if none is marked) |
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
node agent-hub/chatmgr/src/cli.mjs delete --keys codex:X --yes --no-backup   # permanent
node agent-hub/chatmgr/src/cli.mjs prune-backups --days 14 [--yes]            # dry run without --yes
node agent-hub/chatmgr/src/cli.mjs archive --keys codex:X --dry-run
node agent-hub/chatmgr/src/cli.mjs archive --keys codex:X --yes
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
| Claude Code 2.1.319 | `~/.claude/projects/*/*.jsonl` | JSONL | `claude --resume <id>` | — | delete `.jsonl` + `<id>/` sidecar (backup first) |
| Hermes 0.23.0 | `state.db` (read-only) | `messages` table | `hermes chat --resume <id>` | bulk only | `hermes sessions delete --yes` |

Claude Code has no per-session delete command — `claude purge` deletes a whole
project and `claude rm` only handles background agents. For a Claude row the
manager therefore removes exactly two paths: that session's own
`~/.claude/projects/<project>/<id>.jsonl` and its sibling `<id>/` folder
(subagent transcripts and tool output), when present. It never globs, never
removes a project folder, and never touches another session. The same
backup-before-mutation rule applies, and the backup includes the sidecar.

## Safety

- **Running sessions are never deleted.** Codex uses its own
  `thread-writer-locks/<id>.lock`; Hermes uses a missing `ended_at`; OpenCode
  compares `time_busy` and `time_idle`. Claude Code has no per-session lock, so
  a transcript modified in the last 10 minutes is treated as running and
  blocked; a row that cannot report a boolean is blocked as unknown. If a
  provider cannot report runtime state, deletion is blocked instead of guessed.
- **The current session** is blocked even if selected.
- **Claude deletes are path-checked.** The jsonl and sidecar are resolved with
  `realpath` and must stay strictly inside `~/.claude/projects`, directly under
  one project folder, with filenames matching the session id. `..`, symlinks,
  junctions and any path outside that root are rejected before removal; only
  the two verified paths are removed, never a glob or a project folder.
- **Backup before mutation (default; `--no-backup` or `k` turns it off).** Backups older than 14 days are pruned after a backed-up delete (`--no-prune`, `--prune-days N`). Every batch writes
  `backups/<timestamp>/manifest.json` plus a copy of each file-backed
  transcript and its sidecar folder (Claude), or a JSON dump for
  database-backed agents. If the backup fails, nothing is deleted.
- **Restore:** `cli.mjs restore --manifest …` copies file-backed sessions and
  Claude sidecars back. Database dumps are exported for re-import through that
  agent's own CLI. Backups are removed only by an explicit `backup-remove`.
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
  agent-hub/chatmgr/test/execute.test.mjs agent-hub/chatmgr/test/providers.test.mjs `
  agent-hub/chatmgr/test/claude-delete.test.mjs
```

46 tests, no network and no real conversations: fixtures build a fake Codex
home, Claude home (with sidecar) and two SQLite stores in a temp directory.
Filtering (including the midnight boundary), selection/select-all/pruning,
cancellation, partial failures, blocked reasons, archive toggling,
backup/restore and every provider parser are covered. Claude deletion is
tested for backup-before-delete, the recent-mtime block, path-escape rejection
and a jsonl+sidecar restore round-trip — all under temp homes.

No real conversation was deleted while building this.

## Not yet: VS Code / Copilot

VS Code is a host, not a conversation owner. Copilot Chat history lives in
GitHub's service and in VS Code's storage, and there is no supported deletion
command for a single chat. Adding it needs a separate read-only integration
first; until then it is deliberately out of the list rather than faked.
