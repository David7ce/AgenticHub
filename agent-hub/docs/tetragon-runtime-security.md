# Tetragon and the hub: watching what agents actually do

Read 2026-10-29 from [`doniacld/gh26-tetragon`](https://github.com/doniacld/gh26-tetragon)
(Apache-2.0, GitHub Universe 2026 demo, "Who's watching the agents?").

## What the demo shows

A small ticket site has three services: frontend, gallery, payments. An agent
is asked to add image upload to the gallery and to use a thumbnail helper,
`github.com/octopkg/upload`. The helper works, but on every call it also dials
the payments service and reads its vault — a gallery→payments call that should
never exist.

Every static check stays green: build, test, vet, gofmt, and `govulncheck` (the
module has no CVE). The PR ships. What catches it is **Tetragon**, an eBPF
runtime-security tool, watching the connection at runtime:

| Mode       | Action | Result                                           |
|------------|--------|--------------------------------------------------|
| monitor    | report | the forbidden call is logged, upload still works |
| `Override` | deny   | connect gets EPERM, only `/upload` returns 503   |
| `Sigkill`  | kill   | the gallery container dies, CrashLoopBackOff     |

The demo also ships a CI job that runs the same policy in a `kind` cluster, so
the runtime check fails the pull request. Its own honesty note is the important
part: **CI only sees what runs in CI** — it is one layer, not a substitute for
watching production.

## Why it matters for this hub

The hub's ACP documentation already says it plainly:

> **Not a sandbox (decided 2026-10-29).** The client advertises no `fs/*` or
> `terminal/*` capabilities … The controls are the consent gate, the
> default-deny permission policy, and the per-run budget.

Those are **pre-flight** controls: they decide whether a run may start and what
it may answer when asked. They do not observe what the agent then executes with
its own tools. That is exactly the gap the Tetragon demo names.

| Question                      | Hub answer before this change                                            |
|-------------------------------|--------------------------------------------------------------------------|
| May this agent run?           | Yes — `consent.json`, enabled + acknowledged + unexpired                 |
| May it use this tool?         | Policy answer when the agent asks (`deny` / `allow-reads` / `allow-all`) |
| How much may it spend?        | `--budget`, cancels on reported cost                                     |
| **What did it actually run?** | **Only in `--json` output or `--verbose` stderr; not in the audit log**  |

Two caveats matter more than the table:

1. **Permission policy is not enforcement.** OpenCode executes its own built-in
   tools without asking, so the policy only sees requests the agent chooses to
   raise. A tool the agent never asks about is invisible to it.
2. **Fan-out workers share a working tree.** The README already warns that
   parallel workers should get separate subfolders or worktrees before they
   edit. Nothing enforces that today.

## Adopted now

`hub-acp.mjs` now records the run's tool activity in `projects/logs/runs.jsonl`
alongside the existing permission decisions:

- `toolCount` — total distinct tool calls seen.
- `tools` — up to 100 entries of `{ id, title, kind, status }`.

That turns the audit line from "what policy allowed" into "what the agent did",
without letting one noisy run bloat the log. It is still **after the fact**: it
records, it does not block. Tests: `node --test agent-hub/acp/tests/*.test.mjs`
(33 pass; this change is log-shape only).

## Adopted: one worktree per parallel editor

`fanout-acp.mjs --worktree` now creates a detached checkout per agent under
`<git-dir>/agent-worktrees/<stamp>-<agent>` before any agent starts, and points
that agent's session `--cwd` at it. A worktree the agent changed is kept and
reported; a clean one is removed after the run. That closes the shared-tree
risk the README already flagged, and it is the mechanical half of the demo's
"one workload must not reach another's data" lesson. Worktrees start from
`HEAD`, so uncommitted changes are not copied in.

## Adopted: egress posture check

`agent-hub/tools/egress-posture.mjs` reports whether the machine is actually
using the protections that already exist, rather than adding another network
filter:

- VS Code's agent shell sandbox (`chat.agent.sandbox.enabled`, on by default).
- Its network switch (`chat.agent.sandbox.network.allowNetwork`, **on by
  default** — this is the usual gap).
- Hub consent expiry.

It exits non-zero on any warning and prints the exact setting to change. ACP
agents are reported as info, never a pass: VS Code's sandbox does not cover
them.

## What is worth doing next

Ranked by value for this workstation, not by how closely it resembles the demo:

1. **Container egress denial for untrusted ACP runs (deferred 2026-10-30).**
   Not built now: routine work needs package installs and API calls, and VS
   Code's sandbox covers editor sessions. Trigger: before running an agent on
   an untrusted repo or a third-party dependency, run it in a container with
   default-deny egress.
2. **A CI runtime gate for generated services.** If an agent writes a service
   that ships, run the demo's pattern — a policy that asserts only the expected
   service-to-service calls — in that project's own CI. Do not centralise it in
   this repo; it belongs where the service lives.
3. **Blocking, if ever needed.** Only after (1) and (2) prove insufficient. A
   blocking layer means a real sandbox, and that is a different project.

## What does not transfer

- **Tetragon itself needs Linux and eBPF.** The hub runs on Windows with WSL2.
  Running a `kind` cluster in WSL just to watch a personal agent run is more
  machinery than the risk justifies today.
- **The demo's trap is deliberate.** Its `.github/copilot-instructions.md`
  steers the agent to the shady dependency. That is a teaching device, not a
  pattern to copy into a real repo.
- **Static checks are still worth having.** The demo's point is that they are
  necessary and insufficient, not that they are useless.

## Sources

- [`doniacld/gh26-tetragon`](https://github.com/doniacld/gh26-tetragon) —
  README, architecture, safety and honesty notes.
- [`lizrice/tetragon-ci`](https://github.com/lizrice/tetragon-ci) — the
  upstream idea for a Tetragon runtime check in GitHub Actions.
- [`../docs/reference/acp.md`](reference/acp.md) — the hub's permission, consent,
  audit and "not a sandbox" sections.
- [`../README.md`](../README.md) — the fan-out shared-working-tree gotcha.

