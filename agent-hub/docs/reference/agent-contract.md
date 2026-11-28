# Operating contract

The hub is a backend for agent delegation over ACP and MCP. For the component
map, read [Architecture](../architecture.md); for commands, read the
[CLI reference](cli.md). OpenCode and Claude Code are the supported daily chat
surfaces; see [Chat surfaces](../harness.md).

## Tree ownership

One writing orchestrator per working tree. Parallel writers need separate
worktrees, even when their intended edits appear disjoint. Do not edit a worker's
tree while its run is active. Native UI verification shares the desktop even
across repositories: serialize mouse, keyboard and focus operations.

## Consent and audit — the contract

**Current safety limitation:** live tests showed Claude, Codex and OpenCode can
write without sending an ACP permission request, even under `allow-reads`. The
hub therefore rejects all `deny` and `allow-reads` dispatches before startup.
Only `allow-all` can run within an existing grant; it is write-capable, and
neither that grant nor a cwd is an OS sandbox. Other adapters are not assumed
safe. This is a temporary fail-closed mitigation, not read-only support.
`hubctl doctor` warns about this limitation and reports a failure for an enabled,
acknowledged grant capped at `deny` or `allow-reads`, because no dispatch can
currently satisfy it. Do not widen a grant to clear the diagnostic.

- `consent.json` is the gate: `enabled`, `overseerAck`, unexpired `expires`, and
  `limits` (`maxPermission`, `writeTrees`, `maxBudgetUsd`, `maxDailyUsd`, for flat subscriptions like Codex `maxDailyTokens`, and `maxContextTokens` to cut a turn whose context window crosses it) checked
  against the exact request. No grant, no run — including `--probe`. It is local and
  ignored: copy `consent.example.json` and edit it. Never widen a grant to make
  something work. Ask.
- Every attempt, denied or not, appends one JSON line to `workspaces-panel/logs/runs.jsonl`. Past
  10 MB it rotates to `runs-<timestamp>.jsonl`; nothing is deleted.
- An `allow-all` run checks `acp/tree-lock.mjs` for another live write run on the
  same cwd. Conflicts reject unless the caller passes `--allow-concurrent-write`;
  the conflict is audited. Agents started outside the hub do not take this lock.
- A timed-out turn is cancelled, not abandoned: `session/cancel` is sent and the hub
  waits (`HUB_CANCEL_WAIT_MS`, default 8 s). `cancelAck: false` means the callee never
  confirmed: treat its tree as live, because a daemon-backed agent (OpenCode) can keep
  going after the client is killed.
- Stop means stop: when the chat cancels a tool call (or `job_cancel` is used) the run is asked to
  stop, cancels its agent and is audited as `cancelled`, with `cancelAck` as for a timeout.
- A run still going has no audit line yet; it is `results/inflight/<pid>.json` and
  shows in `hubctl status`. Never write to a tree that line names.
- The daily dollar cap counts the audit log's reported cost plus, for Codex (which
  reports none), the estimated cost of the sessions the hub started.


## Routing and models

Use [Routing](../routing.md) as the policy reference and the local registry as the
configured source of defaults and fallback chains. An explicit model is never
substituted by the model fallback chain. Frontier models (Astra, Opus) require
explicit selection; never route to them automatically. Do not use a model that
may train on data in a session able to read credentials or another tool's memory.
In particular, `muse-spark-*` is allowed only when that session cannot read `.env`
or another tool's memory store.

## Paths and verification

`acp/paths.mjs` owns Windows/WSL translation (`toWsl`, `toWindows`, `translate`,
`describe`). Do not add another drive-letter translator.

Run `npm run check` from the repository root. It checks documentation links,
offline tests and the benchmark dry-run. Windows CI repeats it; the pre-commit
hook runs the faster subset. The benchmark baseline is a regression reference,
not proof of performance on arbitrary projects. See [Benchmarks](../benchmarks/README.md).

Keep a session handoff when local working notes exist; see
[Session continuity](session-continuity.md). Never assume another harness can read
the current chat transcript.

## Rules

1. **No secrets in a transcript.** `.env*` reads are denied in both harnesses. Read a
   credential inside a process and pass it on; never print it. The pre-commit hook
   scans staged files for key shapes (`tools/secret-scan.mjs`) before the tests;
   `--history` audits what is already committed (the next commit cannot fix it).
2. **Escalate on scope or consequence**, not on perceived difficulty (the bench showed
   difficulty predicts nothing): a change spanning untested modules, or anything touching
   credentials, permissions, money or a public API.
3. **Verify before claiming.** Re-fetch, re-run, re-read. A tool saying "ok" is not
   evidence.
4. **Never delete a consent grant, a run line or a worktree with changes** without asking.
