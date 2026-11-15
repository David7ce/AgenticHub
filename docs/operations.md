# Operations

Complete [Getting started](getting-started.md) first. Commands below run from the
repository root. Detailed options live in the [CLI reference](reference/cli.md);
MCP tool behavior lives in the [MCP reference](reference/mcp.md).

## Inspect before dispatch

```bash
node hub.mjs doctor
node hub.mjs brief
node hub.mjs live --once --json
```

Doctor checks configuration coherence and optional local integrations. Brief
summarizes local state. Live shows inflight runs, managed tree locks and process
activity visible on the current host. It is advisory: externally started agents
do not acquire the hub's locks.

A Windows Terminal layout with a chat client in one pane and `node hub.mjs live`
in another is sufficient. The hub does not need a separate dashboard service.

## Delegate and review

```bash
node hub.mjs ask opencode "Review the current change" --permission deny --json
node hub.mjs fanout opencode,claude "Implement the task" --worktree
node hub.mjs verify <worktree>
```

These agent calls require valid grants and consume provider allowance. Put every
simultaneous writer in its own worktree. Use the [dispatch playbook](dispatch-playbook.md)
for handoffs and the [routing policy](routing.md) for quota failover. The caller
must supply the relevant context; delegated agents do not inherit the chat.

The task queue is a local SQLite file. A task runs through the same consent gate
in a worktree, then lands in `review`. Marking it `done` requires evidence. For
queue commands and states, see [CLI: tasks](reference/cli.md#tasks--the-thin-work-queue).

## Observe usage and evidence

```bash
node hub.mjs report --days 7
node hub.mjs spend --days 7
node hub.mjs usage
```

Report groups outcomes and failure causes. Spend reads provider-specific local
records; usage includes provider allowance readings where configured. Codex token
and estimated-dollar accounting is supported; the provider's actual subscription
allowance is a separate measurement. See the [CLI reference](reference/cli.md)
for attribution and pricing limitations.

Audit records are appended when attempts finish, not while they run. Inspect
inflight state for active work. The default locations and environment overrides
are in [Workspace configuration](reference/workspace-configuration.md).

## Stop and recover

Stopping an MCP request or cancelling a background job asks the delegated agent
to stop and waits for its turn to end. A timeout uses the same ACP cancellation
path. `cancelAck: false` means there was no confirmation: the callee may still be
editing, especially when backed by a shared daemon. Confirm it has stopped before
reusing that tree. A process-tree kill is the backstop, not proof that a remote
or daemon-backed turn ended.

| Symptom | First action |
|---|---|
| Hub missing in OpenCode | Check `opencode mcp list`, the registered Node executable and server path |
| Authentication failure | Check the agent is signed in on the same host that runs the hub |
| Consent denied | Inspect expiry, acknowledgement, permission, write trees and caps; never widen a grant automatically |
| Codex adapter failure | Doctor detects the retired adapter; compare the local registry with the tracked example |
| Requested model unavailable | Inspect what the configured agent exposes; do not invent an alternate model ID |
| Long silence | Inspect `live`; a running build may be quiet, whereas a stalled turn needs investigation |
| Lock occupied | Wait or use a separate worktree; do not remove a live lock to force a run |
| Quota exhausted | Follow the configured fallback chain or hand off with the task and current tree state |

## Verify and clean

```bash
npm run check
node bench/collab.mjs
node hub.mjs clean
node hub.mjs worktree
```

The first two commands use offline fixtures and make no model calls. The
collaboration benchmark writes its Markdown report to
`docs/benchmarks/collaboration.md` only with `--write`; its JSON record stays in
`bench/collaboration.json`. `--real` adds provider calls. See
[Benchmarks](benchmarks/README.md) before updating measured evidence.

Clean defaults to a preview. Preserve audit records and worktrees containing
changes. Destructive cleanup requires the owner's approval. Raw benchmark output
belongs in ignored `results/bench/`; durable written evidence belongs under `docs/`.
