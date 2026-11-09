# Operating instructions for AI agents working in this directory

This file is for you, the agent — Claude Code or otherwise. If you're a
human, see [`README.md`](README.md) instead.

## What this directory is

AgentHub is the **control room** for two things:

- [`agent-hub/`](agent-hub/) — the local swarm: dispatcher, consent gate,
  MCP server, ACP adapters, routing and audit log.
- [`repos/`](repos/) — the inventory of repositories under `D:\Workspaces`
  and the generated repos/heatmap pages.

It is not a general documentation workspace. General domain documentation,
AI working habits and durable research notes live in the external vault:

`D:\Knowledge\Vault\Markdown-vault\AI-vault\`

Project state belongs to each project repository. Scripts and installers
belong to a separate toolbox repo outside this tree.

## Before you start any task

1. If the user doesn't specify a task, read [`private/ROADMAP.md`](private/ROADMAP.md) for
   open items to pick up.
2. For `agent-hub/`, read [`agent-hub/AGENTS.md`](agent-hub/AGENTS.md) and
   [`agent-hub/README.md`](agent-hub/README.md); for `repos/`, read
   [`repos/README.md`](repos/README.md).
3. If the task touches a project repo under `D:\Workspaces`, read that repo's
   `AGENTS.md` and `docs/agent/HANDOFF.md` **first**, and update them before
   you finish (see "Session continuity").
4. Do not recreate `categories/` here. If a task produces general
   documentation, put it in the AI-vault; if it is project-specific, keep it
   in the project.

## The `private/` folder (personal, never published)

Everything that is this owner's and not the hub itself lives in
[`private/`](private/), which git ignores wholesale. A fork clones an **empty**
`private/` and a generic repo. It holds `ROADMAP.md`, the session batons
(`HANDOFF.md`, `JOURNAL.md`), `git-backup.md` and `history/` (old handoffs and
dispatch notes). Local **config** that code reads stays next to the code
(`agent-hub/consent.json`, `agent-hub/acp/agents.json`, `repos/local/`), also
ignored, each with a tracked `*.example` or README a fork copies from.

Keep anything personal, project-specific or machine-specific in `private/` or in
a `*.local.*` file — never in a tracked file, so the public tree stays generic.

### Keeping `private/ROADMAP.md` current

- Something the user mentions that isn't handled immediately: add it to
  `private/ROADMAP.md` rather than letting it live only in conversation.
- A task genuinely blocked on someone/something else (not just "the user
  hasn't done it yet") stays there with the blocker spelled out.
  A one-step thing only the user can do is still their next action, not a wait.
- When something finishes, remove it; don't leave it checked off and lingering.

## Session continuity across harnesses

Chat history is **not** shared between Claude Code, Hermes, OpenCode and
StarNet. A session that dies mid-task leaves its context in a harness-specific
transcript that the next harness cannot read. Each project repo carries its own
baton instead:

- `AGENTS.md` — entry point and read/close protocol, for every harness.
- `docs/agent/HANDOFF.md` — current state, uncommitted work and exact next step.
- `docs/agent/JOURNAL.md` — append-only history, newest first.
- `tools/agent-state.mjs` — optional mechanical check; its baseline lives in
  `.git/`, not in the repo, so it cannot go stale by being committed.

Pattern to copy: any repository that already keeps an `AGENTS.md` with its
read/close protocol. If a repo you work in has no `AGENTS.md`, add one there rather
than keeping the knowledge only in chat.

This workspace's own baton is [`private/HANDOFF.md`](private/HANDOFF.md)
and [`private/JOURNAL.md`](private/JOURNAL.md) — read them at the start
of a session and update them before finishing. They live under `private/`
(ignored by git): they carry personal project state, not hub code, so they stay
on disk and out of the repository. The `docs/agent/` paths above are the
convention each *project* repo follows; AgentHub keeps its own under `private/`.

**Concurrency policy:** one writing orchestrator per working tree. Read-only
sessions may overlap. Give simultaneous writers separate Git worktrees;
hub-managed ACP writers reject a conflicting claim unless the caller explicitly
passes `--allow-concurrent-write`. The override does not isolate edits.
Apply this even when planned edits look disjoint: shared commits and handoff
files can still collide. Never absorb another session's pending work into a
commit without naming it.

## While working

- **`agent-hub/` is infrastructure.** The dispatcher (`hub.ps1`/`fanout.ps1`),
  consent gate, MCP server and orchestration docs live here as a sibling of
  `repos/`, `docs/` and `logs/`. Don't move it into a task folder.
- **`repos/` has source and generated halves.** Edit `cli.mjs`, `src/` or
  `test/`; rebuild `dist/` with `node repos/cli.mjs build` and
  `node repos/cli.mjs heatmap`. Never hand-edit `dist/`.
- **`docs/agent/` is the workspace baton.** Keep it current; preserve rather
  than rewrite historical entries.
- **`logs/` is local, never versioned** (except its README). `runs.jsonl` is the
  audit log; run evidence goes there named by task and date, and the final
  evidence goes to the project repo.
- **Every subdirectory gets a README** stating what it is and what platform or
  tool it assumes, when that matters.
- **Verify before documenting.** Run the command, read the file, open the page
  or inspect the log. If an earlier claim turns out wrong, correct it.
- **General docs go to the AI-vault; project docs stay with the project;
  scripts go to the toolbox.** AgentHub is not a dumping ground.

## Conventions

- `repos/dist/*` is generated output. Regenerate it; never edit it by hand.
- `logs/runs.jsonl` is the agent audit log. Append-only.
- Keep machine-affecting changes and their rollback in the owning project or
  toolbox task, not in AgentHub.
- Credentials, tokens and `.env*` values never enter a document, commit, log or
  prompt.

## Hard-won constraints for this control room

- **Do not bypass the consent gate.** Agents run only when `enabled`,
  `overseerAck` and expiry all allow it; the audit log is not optional.
- **One writer per tree.** Check `running`/`inflight` and the handoff before
  dispatching; do not edit a worker tree while its ACP run is active.
- **Do not merge or reset a worker repository** to make a dispatch succeed.
  Report the state and ask.
- Constraints for other domains (hardware, RGB, OMR, animation, desktop setup)
  live with their documentation in the AI-vault and the toolbox; do not
  relearn them here.

## Permissions

Act autonomously on routine work. Still stop and ask before anything genuinely
destructive or hard to reverse, and before any action outside this directory
tree that affects the wider system, a remote service, or another person.

**Secrets never enter a transcript.** `.claude/settings.json` and the global
OpenCode config both deny reading `.env*` (`.env.example` excepted), because a
token that reaches a model's context has left the machine. If a task genuinely
needs a credential, read it inside a process and pass it on — never print it,
never paste it into a prompt.

**Model choice follows what the session touches.** Public repos and anything
without credentials may use any model, including ones that train on request
data. A session that could read `.env`, tokens or the claude-mem store stays on
zero-retention models.
