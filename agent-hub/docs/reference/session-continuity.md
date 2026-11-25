# Session continuity

STATUS: active

This folder documents the **convention**, not the content. AgentHub's own
working notes are personal and live under `projects/working/`, a nested private repo —
so a fork clones this explainer but none of the owner's state.

## The notes (in `projects/working/`, private, never published)

- `projects/working/ROADMAP.md` — the only roadmap: open work, its state and its
  priority (P0 blocks revenue or has a date; P1 is the main product; P2 planned; P3
  parked). One P0 at a time; finished items are deleted.
- `projects/working/HANDOFF.md` — how to start: pending items, ports, environment and
  rules. Short; it is not a log.
- `projects/working/JOURNAL.md` — newest first, one line per fact, trimmed weekly.

Chat history is **not** shared between harnesses (Claude Code, OpenCode, Codex, …);
a session that dies mid-task leaves its context in a transcript the next harness
cannot read. These three files are how it picks up where the last one stopped.

## For a project repo

A project repo keeps its `AGENTS.md` (entry point) and its own `README`/`docs`. It has
no HANDOFF or JOURNAL of its own: open work goes to the central `ROADMAP.md` and one
line to the `JOURNAL.md`.
