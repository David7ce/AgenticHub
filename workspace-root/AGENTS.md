# Operating instructions for AI agents working in this directory

For you, the agent — Claude Code, Codex, OpenCode or any other. If you are a
human, read [`README.md`](README.md) and [`docs/agent-guide.md`](docs/agent-guide.md).

## What this directory is

AgentHub is the **control room** for this machine's agent workspace:

- [`agent-hub/`](agent-hub/) — the local swarm: ACP dispatcher, consent gate, MCP
  server, `hubctl` control room, conversation manager, routing and audit log.
- [`repos/`](repos/) — the inventory of repositories under `D:\Workspaces` and the
  generated repos/heatmap pages.

It is not a general documentation workspace. General notes and research live in the
external vault (`D:\Knowledge\Vault\Markdown-vault\AI-vault\`); project state lives
in each project repo; scripts and installers live in the toolbox repo.

## Before you start

0. Run `node agent-hub/hubctl/hubctl.mjs brief` first: doctor, dirty repos, last runs,
   today's spend and the pending list in ≤40 lines.
1. No task given? Read [`working/ROADMAP.md`](working/ROADMAP.md) for open items.
2. Touching `agent-hub/`: read [`agent-hub/AGENTS.md`](agent-hub/AGENTS.md). Touching
   `repos/`: read [`repos/README.md`](repos/README.md).
3. Touching a project repo: read **its** `AGENTS.md` and `docs/agent/HANDOFF.md`
   first, and update the handoff before you finish.
4. Do not recreate `categories/` here. General docs go to the vault; project docs
   stay with the project.

## `working/` — personal, never published

Everything that is the owner's and not the hub itself lives in
[`working/`](working/), which git ignores wholesale: `ROADMAP.md`, the session
batons (`HANDOFF.md`, `JOURNAL.md`), `git-backup.md`, `history/`. A fork clones it
empty. Local **config** that code reads stays next to the code
(`agent-hub/consent.json`, `agent-hub/acp/agents.json`, `repos/local/`), also
ignored, each with a tracked `*.example` or README to copy from. Keep anything
personal or machine-specific in `working/` or a `*.local.*` file — never in a
tracked file.

Keep `working/ROADMAP.md` current: add what the user mentions and you cannot do now,
keep a blocked item with its blocker spelled out, and delete finished items instead
of leaving them checked off.

## Session continuity

Chat history is **not** shared between harnesses; a session that dies mid-task
leaves a transcript the next harness cannot read. So the state goes in files:

- A **project repo** keeps `AGENTS.md` (entry point), `docs/agent/HANDOFF.md`
  (current state, uncommitted work, exact next step) and `docs/agent/JOURNAL.md`
  (append-only, newest first). If a repo has no `AGENTS.md`, add one.
- **This workspace's** baton is `working/HANDOFF.md` and `working/JOURNAL.md`: read
  them at the start, update them before finishing. They stay out of git.

**One writing orchestrator per working tree.** Read-only sessions may overlap. Give
simultaneous writers separate git worktrees; hub-managed writers reject a
conflicting claim unless the caller passes `--allow-concurrent-write`, which does
not isolate edits. Apply this even when planned edits look disjoint. Never absorb
another session's pending work into a commit without naming it.

## While working

- `agent-hub/` is infrastructure; do not move it into a task folder.
- `repos/dist/` is generated: edit `cli.mjs`, `src/` or `test/`, rebuild with
  `node repos/cli.mjs build` and `node repos/cli.mjs heatmap`, never hand-edit `dist/`.
- `logs/` is local and never versioned (except its README). `logs/runs.jsonl` is the
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
