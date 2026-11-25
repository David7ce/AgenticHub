# projects/local — per-machine data, never committed

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
  "third-repo": { "owner": "Upstream-Owner" }
}
```

Keys are repository folder names; values may set `owner`, `project` or
`working`. Anything absent is derived from the folder layout.

`exclusions.json` is an array such as `["Git-clones/example"]`. Entries match
the complete root-relative path, not the repository name, so another clone with
the same name stays visible. Excluding a path never deletes or alters it.

Related settings live in the environment, not here:

| Variable                  | Effect                                                  |
|---------------------------|---------------------------------------------------------|
| `AGENTHUB_WORKSPACE_ROOT` | Root to scan (default: two levels above `projects/`).   |
| `AGENTHUB_GITHUB_USER`    | Owner given to repos that have no owner folder.         |
| `AGENTHUB_AUTHOR`         | Author whose commits the calendar counts.               |
