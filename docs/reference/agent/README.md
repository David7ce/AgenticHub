# Session continuity

STATUS: active

This folder documents the **convention**, not the content. AgentHub's own
session batons are personal and live under [`working/`](../../working/), which
git ignores — so a fork clones this explainer but none of the owner's state.

## The batons (in `working/`, local-only)

- `working/HANDOFF.md` — current state, pending changes, verification, exact
  next step. Read it at the start of a session, update it before finishing.
- `working/JOURNAL.md` — append-only history, newest first.
- `working/ROADMAP.md` — open work across the owner's projects.
- `working/history/` — superseded handoffs and dispatch notes.

Chat history is **not** shared between harnesses (Claude Code, OpenCode, Codex,
…); a session that dies mid-task leaves its context in a transcript the next
harness cannot read. The batons are how the next session picks up exactly where
the last one stopped.

## For a project repo

Each project repo keeps its own baton in *its* `docs/agent/` (`HANDOFF.md`,
`JOURNAL.md`), tracked in that repo. AgentHub is the exception: its batons are
personal, so they sit in `working/` instead of here.
