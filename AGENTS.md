# Instructions for coding agents

Read the [operating contract](docs/reference/agent-contract.md) before making
changes. It contains the full consent, audit, cancellation and verification rules.
Before changing architecture, providers, orchestration or chat surfaces, read the
[target workflow and next-agent plan](docs/target-workflow.md). It records the
owner's current goal and supersedes older interface preferences.

- One writing orchestrator per working tree; isolate simultaneous writers in worktrees.
- Never widen or bypass a consent grant. Never print credentials or `.env*` values.
- Never delete a grant, audit line or worktree containing changes without asking.
- Verify changes before claiming success. Run `npm run check` from the repository root.
- Keep human documentation under `docs/`; keep setup assets under `templates/workspace/`.
  Link to the authoritative page instead of repeating command references.

The [documentation index](docs/README.md) is the project map. Personal session
state, when present, is outside the tracked repository; see
[session continuity](docs/reference/session-continuity.md).
