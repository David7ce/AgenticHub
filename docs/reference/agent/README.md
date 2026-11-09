# Session continuity

STATUS: active

This folder documents the **convention**, not the content. AgentHub's own
session batons are personal and live under [`private/`](../../private/), which
git ignores — so a fork clones this explainer but none of the owner's state.

## The batons (in `private/`, local-only)

- `private/HANDOFF.md` — current state, pending changes, verification, exact
  next step. Read it at the start of a session, update it before finishing.
- `private/JOURNAL.md` — append-only history, newest first.
- `private/ROADMAP.md` — open work across the owner's projects.
- `private/history/` — superseded handoffs and dispatch notes.

Chat history is **not** shared between harnesses (Claude Code, OpenCode, Codex,
…); a session that dies mid-task leaves its context in a transcript the next
harness cannot read. The batons are how the next session picks up exactly where
the last one stopped.

## For a project repo

Each project repo keeps its own baton in *its* `docs/agent/` (`HANDOFF.md`,
`JOURNAL.md`), tracked in that repo. AgentHub is the exception: its batons are
personal, so they sit in `private/` instead of here.
