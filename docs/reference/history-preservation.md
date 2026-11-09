# History preservation

STATUS: active

Verified 2026-11-07: recover the locally reachable animation source with:

```sh
git show d8681244710275e703cfc1a5ae0a2e9099cd3bf0:categories/design-art/animation/animations.jsx
```

The older handoff names `D:\Workspaces\AgentHub-history-2026-11-06.bundle`.
That file was absent on 2026-11-07; do not rely on it as a verified backup.

Before a future history rewrite:

1. Tag HEAD and any required archive revision not reachable from HEAD with
   dated preservation tags.
2. Create a new external bundle with `git bundle create <backup-path> --all`
   and run `git bundle verify <backup-path>`.
3. Confirm required files can be read; record tags, full revisions, bundle
   location and verification date in the journal.
4. Perform only the separately authorized rewrite, retain preservation tags,
   and copy the verified bundle to the normal backup destination.

Bundles exclude uncommitted and untracked files; preserve those separately.
This session creates no tags, external backups, or history rewrites.
