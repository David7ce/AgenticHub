# agent-hub as the swarm control center

agent-hub itself has no screen. It is the backend gate that a dashboard —
StarNet today, possibly others later — calls into when it wants an agent to
actually do something. Each agent still runs and is viewed inside its own
harness (Claude Code's own session, OpenCode's TUI, Hermes's runtime).
agent-hub's job is only to decide whether a run is allowed, run it, and
write down what happened.

## Where it sits

    Dashboard (StarNet, or any other UI)
            |  -Worker <key> -Prompt "..."
            v
       hub.ps1  --consent.json-->  allow / deny
            |
            v
       runs the worker's CLI with stdin closed (claude direct,
       opencode via the WSL bridge, hermes direct)
            |
            v
       ..\logs\runs.jsonl  (every attempt, including denied/rejected)
       results\<stamp>-<worker>.md  (the full answer, gitignored)
            |
            v
       result text back to the dashboard

A "swarm" in this hub means several workers called from one script, each
still a separate OS process (`Start-Job` + the worker's own CLI), each
still gated by its own `consent.json` entry. agent-hub does not merge them
into one agent or one context — it is the common chokepoint they all pass
through, so one place can grant, revoke, and log every run regardless of
which harness produced it.

`fanout.ps1` is the parallel form: it calls `hub.ps1` once per worker as a
background job, so the consent gate and logging apply exactly the same way
whether a worker is called alone or as part of a fan-out.

## Current swarm membership

| Key        | Harness      | Runnable through the hub | Lives in                                                            |
|------------|--------------|--------------------------|---------------------------------------------------------------------|
| `claude`   | Claude Code  | yes                      | its own CLI session, called with `--permission-prompts none`        |
| `hermes`   | Hermes Agent | yes                      | `hermes -z`, told its working folder in-prompt (ignores cwd)        |
| `opencode` | OpenCode     | yes, via WSL             | `run-opencode.sh` inside WSL2 Ubuntu, path-converted with `wslpath` |

All three verified 2026-10-23 (see `roster.md`); the consent gate and audit
log were ported in 2026-10-24 from a since-retired Node implementation
(`hub.js`) that had the governance model but only ever verified Claude.

## Adding a harness to the swarm

1. Add a case to the `switch ($Worker)` block in `hub.ps1`'s job script,
   and add the key to the `-Worker` parameter's `ValidateSet`.
2. Add a matching entry in `consent.json` with `enabled: false` until the
   worker is hand-verified with one real prompt.
3. Run `hub.ps1 -Worker <key> -Prompt "test prompt"`, confirm the record in
   `..\logs\runs.jsonl` looks right, then flip `enabled` to `true`.
4. A worker not yet in the `ValidateSet` is rejected by PowerShell's own
   parameter binding before the script body — and therefore before
   consent — runs at all, the same "unverified things don't even reach the
   gate" property `hub.js` had.

## What the dashboard side still needs

- **StarNet is installed and reachable, but not wired to the hub as a UI.**
  Verified 2026-10-30: the sidecar answers `/api/health` and its ACP agent
  (`sidecar/acp/serve.js`) completes `initialize` + `session/new`. That means
  the hub can call **StarNet as an agent** (`agents.json` → `starnet`), but
  StarNet still does not call `hub.ps1`, show `runs.jsonl`, or reflect
  `consent.json` in its own interface.
- StarNet's ACP agent needs a consent entry before `hub-acp --agent starnet`
  will run; it is registered but deliberately not granted.
- Any other dashboard (a second StarNet-like app, a web UI) can plug into
  the same `hub.ps1`/`consent.json`/`runs.jsonl` trio — the contract is
  just "call `hub.ps1 -Worker <key> -Prompt <text>`, read stdout and the
  exit code."
