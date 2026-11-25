# bench — can an agent restore a function from its tests?

STATUS: active

One task = one exported function whose body is replaced with a stub. The
repository's own test file decides whether the agent succeeded. There is no
judge model and no rubric to argue with.

Created 2026-10-30. Zero dependencies, no network.

## Why this shape

The question the workflow needs answered is **not** "which model is best". It
is: *how often does the cheap default fail, so how often does this task have to
escalate to Claude Code?* That number decides whether a weekly plan is enough.

So the bench measures one thing well: given only the tests, can the agent
reconstruct the behaviour?

## Fairness rules (enforced, not documented)

| Risk | What the runner does |
|---|---|
| The agent reads `git log` and copies the original | Each attempt runs in a **fresh copy with a fresh single-commit repo**. There is no history to read. |
| The agent edits the test instead of the code | `git status` after the run; any file other than the task's target is a **failure**, not a note. |
| A stub that tests do not notice | Before every attempt the runner proves the stubbed tree **fails** its tests. If it passes, the harness stops (`exit 2`). |
| The rest of the workspace leaks in | Only `agent-hub/` is copied. |

## Tasks

`bench/tasks.json`. Each entry names a symbol, its file, and the test that judges it.

| id | symbol | judged by |
|---|---|---|
| `paths-to-wsl` | `toWsl` | `acp/tests/paths.test.mjs` |
| `paths-to-windows` | `toWindows` | `acp/tests/paths.test.mjs` |
| `router-decide` | `decideAgent` | `acp/tests/router.test.mjs` |
| `mcp-render-fanout` | `renderFanout` | `mcp/tests/core.test.mjs` |
| `fanout-synthesis-prompt` | `buildSynthesisPrompt` | `acp/tests/fanout.test.mjs` |
| `fanout-render-markdown` | `renderMarkdown` | `acp/tests/fanout.test.mjs` |

The table shows the six original function tasks. `bench/tasks.json` is the
current task inventory and also includes whole-module and hidden-spec tasks.

## Use

```bash
# Prove every task is actually broken. No model calls, no cost.
node bench/run.mjs --dry-run

# One attempt per task on the default model.
node bench/run.mjs --agent opencode --model opencode-go/deepseek-v4.1-flash

# Three attempts, to see variance.
node bench/run.mjs --reps 3 --tasks paths-to-wsl,router-decide

# Keep the copies under /tmp to inspect what the agent did.
node bench/run.mjs --tasks paths-to-wsl --keep

# The Claude arm, when its provider allowance is available.
# Run it from PowerShell, not WSL: the ACP adapter authenticates with the
# Windows credentials in C:\Users\<you>\.claude, and from WSL it fails with
# "session/prompt: Authentication required (code -32000)". Use --keep because
# Windows sometimes refuses to delete the temp copy while the adapter is
# shutting down (EPERM, harmless but it aborts the run).
node bench/run.mjs --agent claude --model sonnet --reps 3 --keep
```

Results land in `results/bench/` (gitignored): one JSONL line per
attempt plus a summary JSON. `bench/baseline.json` is the versioned reference: a run
that scores below it is a regression in the agent or the harness, not noise.

## What the numbers mean

| Field | Reading |
|---|---|
| `passRate` | share of attempts whose tests passed **and** touched only the target file |
| `totalCost` | reported cost, from `runs.jsonl` |
| `totalDurationMs` | wall time, including agent startup |
| `tampered` | files the agent touched beyond the task; non-empty means failure |

**Observed failure rate = 1 − passRate** for these benchmark attempts. It does
not predict the escalation rate or provider allowance needed for unrelated
production work.

## Results so far (2026-10-30)

`opencode-go/deepseek-v4.1-flash`, `$0.0000` reported (Go is flat-rate).

| Tier | Tasks | Attempts | Passed | Cost per attempt |
|---|---|---|---|---|
| easy (one function, visible tests) | 6 | 6 | 6 | ~20 s, 4 tools |
| hard (whole module, visible tests) | 4 | 5 | 5 | 32–112 s, 6–22 tools |
| ambiguous (prose spec, **hidden** verdict) | 3 | 3 | 3 | 53–59 s, 10–12 tools |
| construct (two modules, hidden verdict) | 1 | 1 | 1 | 72 s, 20 tools |

**The bench does not discriminate, and that is the result.** 15 attempts across
14 tasks, zero failures. The hidden verdict is the honest test — the agent never
sees the file that judges it, so it cannot iterate to green — and the
cross-module task, where a new export in `paths.mjs` had to be wired into a
`hubctl` flag, still passed.

So the escalation rule changes, and this time with evidence behind it:

- **Not** "this looks hard". Perceived difficulty predicted no failure at all.
- **Scope**: the change spans modules the agent cannot see at once, or there is
  no test to pin the contract.
- **Consequence**: credentials, permissions, money, public API.

Until a task exists that this model fails, the bench is a **regression suite**,
not a model comparison: it will catch a change that breaks an agent's ability
to do the basics, which is worth having on its own.

Running it also found a real bug outside the bench: `hub-acp.mjs` called
`process.exit()` after writing `--json`, which truncated a 146 KB document
mid-string on a pipe. It now sets `process.exitCode` and lets stdout flush.

### Variance (2026-10-31, 3 reps)

Four tasks from the three hardest tiers, three attempts each: **12/12 passed**.

| Task | Seconds | Mean | Tools |
|---|---|---|---|
| `router-module` | 57.6 · 43.3 · 42.6 | 47.8 | 21–25 |
| `core-render-module` | 46.5 · 45.0 · 59.7 | 50.4 | 16–22 |
| `spec-paths-relative` | 30.6 · 28.1 · 39.1 | 32.6 | 8–13 |
| `construct-relative-cli` | 70.5 · 84.9 · 64.7 | 73.4 | 22–27 |

**Outcome is stable; effort is not.** Time swings by roughly a third run to
run, so a single slow run is not a regression — only a lower pass count is.
That is now recorded in `bench/baseline.json`.

## Adding a model to the hub's chain (2026-11-04)

`acp/agents.json` carries `modelFallbacks`: when a pool reports exhaustion the
hub climbs that list. A model may only join it after this bench says it can do
the work, because the whole point of the ladder is that the task still finishes
after the step up:

```bash
node bench/run.mjs --model opencode-go/<candidate> --json
# two models, one command, one comparison table:
node bench/run.mjs --models opencode-go/deepseek-v4.1-flash,opencode-go/beam-free
```

- **Pass ≥ baseline** (the versioned baseline) → it may join the chain, and the run's
  summary goes to `docs/routing.md` with its price.
- **Below baseline** → it may still be a good *cheap* first step if the failure
  is a clean error rather than a broken tree, but it may never be the model the
  ladder falls back to.
- Pin the model in the bench with `--model`: the runner passes it straight to
  `hub-acp`, so a chain that would otherwise substitute does not hide the
  candidate's own score.

First measured application (2026-11-04): `opencode-go/beam-free`, which is $0
inside the Go plan, scored **14/14 in 33.6 min**. Re-running the baseline model
the same day gave **14/14 in 10.3 min** under the same harness, so the gap is
2-4× per task. Because Go is flat-rate, a $0 model on the same plan saves
nothing, so it joined the ladder **last**, as insurance rather than as the usual
step up. See `docs/routing.md`.

## Limits

- v1 is single-agent. The `fanout` and `swarm` configurations are the next
  iteration, not a claim made here.
- `stubFunction` counts braces. That is exact for these files and throws rather
  than guessing, but it is not a parser; a task whose symbol moves to a class or
  a different export form needs a different stubber.
- These bounded fixtures are a proxy for real work, not a substitute. A model can
  score well here and still fail a 12-file refactor.

## Collaboration bench

`bench/run.mjs` asks whether a model can rebuild a function. `bench/collab.mjs`
asks a different question: does the hub make agents cooperate correctly?

```bash
node bench/collab.mjs                 # deterministic, offline, free
node bench/collab.mjs --real --write  # adds one OpenCode -> Claude handoff
```

It covers fan-out merge, payload handoff, partial failure isolation, tree-lock
conflict, live visibility and stall detection. The default mode uses the fake
ACP fixture and a temporary registry, so it never calls a model. `--real` adds
one short cross-agent handoff (OpenCode writes a token, Claude repeats it).

[collaboration.md](collaboration.md) and `bench/collaboration.json` are the durable record; [workflow.md](workflow.md)
is the durable recommendation (which worker, which topology). They are
tracked, unlike the raw JSONL under `results/bench/`. This is intentionally a
single current report, not a growing history: re-run it when the hub's routing
or ACP layer changes.

