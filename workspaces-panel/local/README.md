# workspaces-panel/local — per-machine data, never committed

Everything in this folder except this README is ignored by git. It holds the
facts that only make sense on one machine:

| File              | What it is                                                                   |
|-------------------|------------------------------------------------------------------------------|
| `config.json`     | The local GitHub user and the commit author the calendar counts.            |
| `accounts.json`   | Other accounts to name on the page: `[{ "name": "…", "emails": ["…"] }]`.   |
| `roots.json`      | Roadmap path prefixes → folders, e.g. `{ "code\\": "D:/Workspaces/code" }`. |
| `icons.json`      | Pinned owner avatars that cannot be read from a remote, keyed by owner name. |
| `overrides.json`  | Hand-curated exceptions for the inventory, keyed by repository name.         |
| `exclusions.json` | Exact paths relative to the scanned root to omit from the inventory.         |
| `stars.json`      | GitHub star cache written by the `stars` command.                            |
| `limits.json`     | Optional default subscription labels and Claude's local estimate settings.  |
| `go-usage.json`   | Optional manual snapshot of the OpenCode Go subscription meters.           |
| `codex-account.json` | Optional account-dashboard statistics. Not a limit or part of the local token ledger. |
| `claude-usage.json` | Optional, generated Claude Code subscription snapshot, without transcript or account data. |

A missing or empty file means "nothing set"; a file with broken JSON or the
wrong shape stops the build with its name, instead of being silently ignored.

`config.json` sets the two values that have no neutral default:

```json
{
  "githubUser": "your-github-user",
  "author": "you@example.com"
}
```

`author` can also be an array, when you commit under more than one email
(`"author": ["you@example.com", "you@work.example"]`): a commit by any of
them counts. Matching is literal, not a regex.

The environment wins over this file: `AGENTHUB_GITHUB_USER` and
`AGENTHUB_AUTHOR` (comma-separated for several emails).

`overrides.json` is a flat object, keyed by repository folder name:

```json
{
  "some-repo": { "project": "Some Project" },
  "another-repo": { "working": false },
  "third-repo": { "owner": "Upstream-Owner" },
  "working": { "name": "AgenticHub-private", "ignoreChanges": ["COSTS.md", "costs.json"] }
}
```

Keys are repository folder names; values may set `owner`, `project`, `name`
(the name shown, without renaming the folder) or `working`. Anything absent is
derived from the folder layout. `ignoreChanges` lists exact repo-relative paths
that never count as pending changes — for files a scheduled job rewrites, such
as the hourly costs refresh. Unpushed commits and any other file still count,
and `sync` ignores this list: it never pulls over those files.

`exclusions.json` is an array such as `["Git-clones/example"]`. Entries match
the complete root-relative path, not the repository name, so another clone with
the same name stays visible. Excluding a path never deletes or alters it.

Related settings live in the environment, not here:

| Variable                  | Effect                                                  |
|---------------------------|---------------------------------------------------------|
| `AGENTHUB_WORKSPACE_ROOT` | Root to scan (default: two levels above `workspaces-panel/`). |
| `AGENTHUB_GITHUB_USER`    | Owner given to repos that have no owner folder.         |
| `AGENTHUB_AUTHOR`         | Author whose commits the calendar counts.               |

## Subscription limits

Use the **AI Usage** subscription chips to change a plan, remove one (×) or add one (**+ Add subscription**) in the browser, or set local defaults
in `limits.json`, e.g. `{"opencode":{"plan":"go"},"claude":{"plan":"pro"}}`.
Codex reports its plan automatically. Settings don't change the account measured.

For OpenCode Go, open your signed-in [Console](https://opencode.ai/console) and
copy the percentages and reset times you see into `go-usage.json`. For example
(these are sample readings, not actual usage):

```json
{
  "measuredAt": "2026-11-25T20:00:00Z",
  "windows": [
    { "label": "week", "usedPercent": 20, "resetsAt": "2026-11-30T00:00:00Z" },
    { "label": "month", "usedPercent": 40, "resetsAt": "2026-12-01T00:00:00Z" }
  ]
}
```

The allowed window labels are `week`, `month` and `5h`; omit any you don't know.
Use ISO timestamps with a time zone, then run `node workspaces-panel/tool/cli.mjs refresh`.
Once a window resets, the panel no longer shows its old percentage. The public
model catalog and all three subscription integrations require no API keys.

Codex dashboard statistics can be copied into `codex-account.json` with a
`measuredOn` (`YYYY-MM-DD`) and optional non-negative integer fields:
`lifetimeTokens`, `peakTokens`, `longestChatMinutes`, `currentStreakDays` and
`longestStreakDays`. The chart does not use these figures to estimate usage limits.

For measured Claude percentages, use the official
[Claude Code status line](https://code.claude.com/docs/en/statusline#rate-limit-usage).
Set its `statusLine` command to the absolute path to the included script, for example:

```json
{
  "statusLine": {
    "type": "command",
    "command": "node \"D:/Workspaces/AgenticHub/workspaces-panel/tool/claude-usage-statusline.mjs\""
  }
}
```

If you already have a status line, integrate the helper into it rather than
overwriting your settings. **Only the terminal CLI runs it:** the VS Code extension
does not execute `statusLine` (checked 2026-11-27 with 2.1.332, `entrypoint:
claude-vscode`), and `claude -p` has no status line either. A reading therefore
needs an interactive `claude` session in a terminal after at least one reply;
the snapshot then stays valid until each window resets. When Claude Code passes its rate-limit data to the
status line, the helper exports only the percentage used, observation time and
reset time per window. The visible AI Usage page re-reads this local snapshot once
a minute and when you return to the tab. No service, manual refresh or extra
provider request is needed. If the Claude client is idle or closed, the panel
shows the last reading with its timestamp until the corresponding window resets.
