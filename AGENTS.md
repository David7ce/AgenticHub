# Operating instructions for AI agents working in this directory

For you, the agent — Claude Code, Codex, OpenCode or any other. If you are a
human, read [`README.md`](README.md) and [`agent-hub/docs/reference/agent-guide.md`](agent-hub/docs/reference/agent-guide.md).

## What this directory is

AgentHub is the **control room** for this machine's agent workspace. This folder
is one **public** repository (`David7ce/AgenticHub`) with two parts, plus the
launcher files agents and editors read from here (`AGENTS.md`, `CLAUDE.md`,
`.mcp.json`, `opencode.json`, `.claude/`, `.vscode/`). The only private part,
`workspaces-panel/working/`, is a separate nested repository that the public one ignores.

- [`agent-hub/`](agent-hub/) — the local swarm: ACP dispatcher, consent gate, MCP
  server, `hubctl` control room, conversation manager, routing and audit log.
- [`workspaces-panel/`](workspaces-panel/) — the inventory of repositories under `D:\Workspaces` (one
  generated page: commit calendar + repo table) and the owner's working notes.

It is not a general documentation workspace. General notes and research live in the
external vault (`D:\Knowledge\Vault\Markdown-vault\AI-vault\`); project state lives
in each project repo; scripts and installers live in the toolbox repo.

## Before you start

0. Run `node agent-hub/hubctl/hubctl.mjs brief` first: doctor, dirty repos, last runs,
   today's spend and the pending list in ≤40 lines.
1. No task given? Read [`workspaces-panel/working/ROADMAP.md`](workspaces-panel/working/ROADMAP.md) for open items.
2. Touching `agent-hub/`: read [`agent-hub/AGENTS.md`](agent-hub/AGENTS.md). Touching
   `workspaces-panel/`: read [`workspaces-panel/README.md`](workspaces-panel/README.md).
3. Touching a project repo: read **its** `AGENTS.md` first. Open work goes to
   [`workspaces-panel/working/ROADMAP.md`](workspaces-panel/working/ROADMAP.md) —the only roadmap,
   with its priority— and one line to `JOURNAL.md`; a repo's `docs/agent/` files
   were retired and live in its git history.
4. Do not recreate `categories/` here. General docs go to the vault; project docs
   stay with the project.

## `workspaces-panel/working/` — personal, private

Everything that is the owner's and not the hub itself lives in
[`workspaces-panel/working/`](workspaces-panel/working/): `ROADMAP.md`, the notes (`HANDOFF.md`,
`JOURNAL.md`) and `git-backup.md`. It is **ignored by the public repo** and is its own
nested git repository with a **private** remote (`David7ce/AgenticHub-private`), so the
notes keep their history and nothing is published. Commit notes from inside
`workspaces-panel/working/`, never from the root. The generated `workspaces-panel/dist/` is ignored too.
Local **config** that code reads stays next to the code and is ignored, each with a
tracked `*.example` or README to copy from: `agent-hub/consent.json`,
`agent-hub/acp/agents.json`, `workspaces-panel/local/` (accounts, roots, config) and the root
`opencode.json`. Keep personal or machine-specific data out of tracked files: it goes in
`workspaces-panel/working/` or in one of those local files.

Keep `workspaces-panel/working/ROADMAP.md` current: add what the user mentions and you cannot do now,
keep a blocked item with its blocker spelled out, and delete finished items instead
of leaving them checked off.

## Session continuity

Chat history is **not** shared between harnesses; a session that dies mid-task
leaves a transcript the next harness cannot read. So the state goes in three central
files, and nowhere else:

- `workspaces-panel/working/ROADMAP.md` — the only roadmap: open work, its state and its
  priority (P0 blocks revenue or has a date; P1 is the main product; P2 planned; P3
  parked). One P0 at a time. Finished items are deleted.
- `workspaces-panel/working/HANDOFF.md` — how to start: pending items, ports, environment and
  rules. Keep it short; it is not a log.
- `workspaces-panel/working/JOURNAL.md` — newest first, one line per fact, trimmed weekly. The
  detail lives in git history.

A **project repo** keeps `AGENTS.md` (entry point) and its own `README`/`docs`; it has
no HANDOFF/JOURNAL of its own. If a repo has no `AGENTS.md`, add one.

**One writing orchestrator per working tree.** Read-only sessions may overlap. Give
simultaneous writers separate git worktrees; hub-managed writers reject a
conflicting claim unless the caller passes `--allow-concurrent-write`, which does
not isolate edits. Apply this even when planned edits look disjoint. Never absorb
another session's pending work into a commit without naming it.

## While working

- `agent-hub/` is infrastructure; do not move it into a task folder.
- `workspaces-panel/dist/` is generated: edit `workspaces-panel/tool/`, rebuild with
  `node workspaces-panel/tool/cli.mjs build`, never hand-edit `dist/`.
- **"Actualiza el panel" / refresh the Workspaces panel (Repos + IA + Notas):** run
  `node workspaces-panel/tool/cli.mjs refresh` from here (costs --write + build). An hourly
  task `Workspaces-Refresh` also runs it; see `workspaces-panel/tool/schedule/`. The panel
  opens from [`workspaces-panel/index.html`](workspaces-panel/index.html) (Inicio: glance page, generated by `build`; tabs
  Projects, AI Usage, Roadmap); `dist/index.html`, `dist/ai-usage.html` and `dist/notes.html` link the
  shared palette and scripts under `dist/shared/`.
- `workspaces-panel/logs/` is local and never versioned (except its README). `workspaces-panel/logs/runs.jsonl` is the
  append-only audit log; run evidence goes there named by task and date, and the
  final evidence goes to the project repo.
- Every subdirectory gets a README saying what it is and which platform or tool it
  assumes, when that matters.
- **Verify before documenting.** Run the command, read the file, open the page. If an
  earlier claim turns out wrong, correct it.
- Keep machine-affecting changes and their rollback in the owning project or
  toolbox task, not here.

## Hard constraints for this control room

- **Do not bypass the consent gate.** Agents run only when `enabled`, `overseerAck`
  and expiry allow it, and within the grant's `limits`. Never widen a grant to make
  something work — ask.
- **One writer per tree.** Check `running`/`inflight` and the handoff before
  dispatching; do not edit a worker tree while its ACP run is active.
- **Do not merge or reset a worker repository** to make a dispatch succeed. Report
  the state and ask.
- Constraints for other domains (hardware, RGB, OMR, animation, desktop setup) live
  with their docs in the vault and the toolbox; do not relearn them here.

## Permissions

Act autonomously on routine work. Stop and ask before anything destructive or hard to
reverse, and before any action outside this tree that affects the wider system, a
remote service, or another person.

**Secrets never enter a transcript.** Credentials, tokens and `.env*` values never go
into a document, commit, log or prompt. Both `.claude/settings.json` and the global
OpenCode config deny reading `.env*` (`.env.example` excepted), because a token that
reaches a model's context has left the machine. If a task needs a credential, read it
inside a process and pass it on — never print it.

**Model choice follows what the session touches.** Public repos and anything without
credentials may use any model, including ones that train on request data. A session
that could read `.env`, tokens or another tool's memory store stays on
zero-retention models.
