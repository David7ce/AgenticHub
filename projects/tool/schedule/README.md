# schedule/

Windows only (Task Scheduler, PowerShell 7). Optional safety net for the
Workspaces panel.

`refresh-task.ps1` registers a per-user task **Workspaces-Refresh** that runs
`node projects/tool/cli.mjs refresh` every hour and at logon, with no console
window and no admin rights. Nothing stays resident between runs.

    pwsh -NoProfile -File projects/tool/schedule/refresh-task.ps1 -Action install
    pwsh -NoProfile -File projects/tool/schedule/refresh-task.ps1 -Action uninstall

Each run appends one line (time, exit code, last output lines) to
`projects/logs/refresh.log`, which git ignores. The task does not commit:
`working/costs.json` goes in with the next normal commit.

Why hourly: the ledger keeps usage per hour, and Claude Code deletes transcripts
older than `cleanupPeriodDays` (14 here). Usage not yet written to the ledger is
lost when its transcript goes.
