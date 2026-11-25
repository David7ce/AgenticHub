# OpenCode Control Room Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** From OpenCode, drive real Claude Code and Codex sessions by name — persistent, visible, controllable, with attended permissions, automatic worktrees and handoffs between them.

**Architecture:** Extend the existing MCP server (`mcp/`) and the per-turn ACP runner (`acp/hub-acp.mjs`). hub-acp gains a transcript writer, a redaction filter and an `ask` permission policy that holds requests over the existing IPC channel; the MCP server gains a durable session registry and five tools. One hub-acp process per turn stays.

**Tech Stack:** Node ≥22 ESM, `node:test` + `node:assert/strict`, no new dependencies. Tests run with `npm test` (`node tools/check.mjs --no-bench`), which lists every `*.test.mjs` under `acp/tests`, `mcp/tests`, `hubctl/tests`, `tools/tests`.

**Spec:** [`docs/superpowers/specs/2026-11-22-opencode-control-design.md`](../specs/2026-11-22-opencode-control-design.md)

## Global Constraints

- Windows native; no new WSL boundary. No new daemon, GUI, OpenCode plugin or fork.
- No new npm dependencies.
- All new state under `HUB_CONFIG.resultsDir` (`agent-hub/results/`, git-ignored): `results/sessions.json`, `results/transcripts/<acpSessionId>.jsonl`.
- `agent-hub/` is public: no personal paths, names or machine data in tracked files or tests (use temp dirs).
- MCP default budget stays $3 (`DEFAULT_BUDGET_USD`); hub-acp CLI default stays $0.50.
- `ask` is write-capable: same consent rank as `allow-all`, takes the tree lock, requires `background: true`.
- `ask` holds everything except in-tree `read`/`search`/`think`/`edit` requests; permission timeout default 300000 ms → reject; turn timeout pauses while a request is held.
- Never silently fall back from a subscription to paid API; never write credentials to transcripts, registry or audit log.
- Every commit passes the repo's pre-commit hook (secret scan, doc links, tests). Work on branch `opencode-control`.

## Review Focus

1. **Two OpenCode windows writing `sessions.json` at once** → no lost entries; last writer merges by label (test in Task 3).
2. **Label reused for a different agent or tree** → rejected with a clear message, never silently retargeted (test in Task 4).
3. **Permission answered after the job already ended or timed out** → `permission_answer` reports "no pending request", does not throw (test in Task 7).
4. **Transcript line containing a token or `.env` path inside a tool title** → redacted before disk (test in Task 1 + Task 2).
5. **Auto-worktree requested outside a git repo** → falls back to the existing "tree busy" refusal, with that reason (test in Task 8).

---

### Task 0: Phase 0 live checks (no code)

**Files:**
- Create: `docs/benchmarks/opencode-control-phase0-2026-11-22.md` (link it from `docs/benchmarks/README.md`)

- [ ] **Step 1:** `node acp/hub-acp.mjs --agent claude --probe --json` and the same for `codex`; record `agentCapabilities.loadSession` and `sessionCapabilities.resume` for `claude-agent-acp@0.101.0` and `codex-acp@2.6.0`.
- [ ] **Step 2:** In OpenCode, check whether a Claude Agent provider is offered (`opencode models`, `opencode auth login`); if it is, ask one trivial question through it and through one `openai/*` model. Record model id, whether it worked, and what billing source the UI names. Do not sign in to anything new without the owner.
- [ ] **Step 3:** Check whether OpenCode v2.3.2's MCP client advertises `elicitation` (log the `initialize` params the hub receives: run the server with `AGENT_HUB_DEBUG_INIT=1` if available, else add a one-off stderr log locally and revert).
- [ ] **Step 4:** Commit the benchmark note. `git commit -m "docs: phase 0 checks for OpenCode control room"`

### Task 1: Redaction filter

**Files:**
- Create: `acp/redact.mjs`
- Test: `acp/tests/redact.test.mjs`

**Interfaces:**
- Produces: `redact(text: string): string` — replaces secrets with `[redacted]`; `isSecretPath(path: string): boolean` — true for basenames `.env` / `.env.*` except `.env.example`.

- [ ] **Step 1: Write the failing tests**

```js
test('masks token shapes', () => {
  for (const s of ['sk-abc123def456ghi789', 'ghp_' + 'a'.repeat(36), 'Bearer eyJhbGciOi.x.y', 'github_pat_' + 'b'.repeat(40)])
    assert.equal(redact(`key ${s} end`), 'key [redacted] end');
});
test('masks .env paths but not .env.example', () => {
  assert.equal(redact('cat D:/repo/.env.local'), 'cat [redacted]');
  assert.equal(redact('read .env.example'), 'read .env.example');
});
test('isSecretPath', () => {
  assert.equal(isSecretPath('/a/.env'), true);
  assert.equal(isSecretPath('C:\\a\\.env.prod'), true);
  assert.equal(isSecretPath('/a/.env.example'), false);
});
test('leaves ordinary text alone', () => assert.equal(redact('ran npm test'), 'ran npm test'));
```

- [ ] **Step 2:** `node --test acp/tests/redact.test.mjs` → FAIL (module missing).
- [ ] **Step 3:** Implement both exports in `acp/redact.mjs` with a small regex list (`sk-[A-Za-z0-9_-]{16,}`, `gh[pousr]_[A-Za-z0-9]{30,}`, `github_pat_[A-Za-z0-9_]{30,}`, `Bearer\s+[A-Za-z0-9._~+/=-]{8,}`, path tokens whose basename matches `^\.env(\..+)?$` and is not `.env.example`).
- [ ] **Step 4:** Test passes.
- [ ] **Step 5:** `git commit -m "acp: redaction filter for transcripts and registry"`

### Task 2: Transcript capture in hub-acp

**Files:**
- Create: `acp/transcript.mjs`
- Modify: `acp/hub-acp.mjs` (inside `onNotification`, the permission handler callback, and turn end), `acp/run-record.mjs` (`writeLog` record gains `label`)
- Modify: `acp/hub-args.mjs` (new `--label NAME`)
- Test: `acp/tests/transcript.test.mjs`

**Interfaces:**
- Consumes: `redact` (Task 1).
- Produces:
  - `transcriptPath(dir: string, acpSessionId: string): string` → `<dir>/<id>.jsonl` (id sanitized to `[A-Za-z0-9._-]`).
  - `toRecord(update: object, now: string): object | null` — maps a `session/update` to `{ t, kind, ... }` where `kind ∈ 'text'|'tool'|'stop'|'usage'`; `agent_message_chunk` → `{kind:'text', text}`; `tool_call`/`tool_call_update` → `{kind:'tool', id, title, toolKind, status}`; `usage_update` → `{kind:'usage', cost}`; others → `null`. All strings pass through `redact`, titles truncated to 300 chars, text chunks to 4000.
  - `appendTranscript(dir, acpSessionId, record): void` — appends one JSON line; never throws.
  - `readTranscript(dir, acpSessionId, { before?: number, limit = 50, textOnly = false }): { records: object[], total: number }` — newest first; `before` is a record index for paging; adjacent `text` records are merged into one before paging.
  - Also recorded by hub-acp: `{kind:'prompt', text}` at turn start, `{kind:'permission', title, toolKind, decision}`, `{kind:'stop', reason, status}` at turn end.
  - Transcript dir: `join(RESULTS_DIR, 'transcripts')`, exported from `acp/hub-env.mjs` as `TRANSCRIPTS_DIR`.

- [ ] **Step 1: Write failing tests** — `toRecord` for each mapped kind and `null` for `config_option_update`; `toRecord` redacts `ghp_…` in a tool title; `appendTranscript` + `readTranscript` round-trip in a temp dir with merge of three consecutive text chunks into one record; paging: 120 records, `limit 50` returns newest 50 and `total 120`, `before: 70` returns indices 69…20; `textOnly` filters to `text` and `prompt`.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement `acp/transcript.mjs`; in `hub-acp.mjs` call `appendTranscript` for non-replay updates once `sessionId` is known (buffer records received before that), for the prompt, each permission decision and the stop. Add `--label` to `hub-args.mjs` (`opts.label`) and pass `label` into every `writeLog` call that has a session.
- [ ] **Step 4:** Tests pass; `node --test acp/tests/*.test.mjs` still green (fake agent in `mcp/tests/fixtures/fake-acp-agent.mjs` writes a transcript in the e2e tests — assert one exists in `mcp/tests/end-to-end.test.mjs`).
- [ ] **Step 5:** `git commit -m "acp: per-session transcripts with redaction"`

### Task 3: Durable session registry

**Files:**
- Create: `mcp/sessions.mjs`
- Test: `mcp/tests/sessions.test.mjs`

**Interfaces:**
- Consumes: `redact` (Task 1) for stored prompt previews.
- Produces: `createSessionRegistry({ path: string, now = () => Date.now() })` returning:
  - `get(label): Session | null`
  - `upsert(label, patch: Partial<Session>): Session` — re-reads the file, merges by label, writes `path.tmp` then renames (atomic on the same volume); creation requires `agent` and `cwd`.
  - `list({ agent?, state? } = {}): Session[]` — newest `lastActivity` first.
  - `close(label): Session | null` — sets `state: 'closed'`.
  - `reconcile(isJobLive: (jobId) => boolean): Session[]` — any `running`/`waiting-permission` session whose `jobId` is not live becomes `idle` with `lastTurn: 'cancelled'`, `jobId: null`, and `queued` moved to `dropped`; returns changed sessions.
  - `Session = { label, agent, acpSessionId, cwd, worktree: string|null, model, effort, state: 'idle'|'running'|'waiting-permission'|'closed', resumable: boolean|null, createdAt, lastActivity, spendUsd, jobId, lastTurn: 'ok'|'failed'|'cancelled'|null, queued: string[], dropped: string[] }`
  - `validLabel(label): boolean` — `^[a-z0-9][a-z0-9-]{0,47}$`.

- [ ] **Step 1: Write failing tests** — create/get/list ordering; `close`; `reconcile` turns a dead running session idle/cancelled and moves `queued` → `dropped`; **two registries on the same file** (simulating two OpenCode windows) each `upsert` a different label → both labels present after both writes; corrupted file → registry starts empty and keeps a `.bad` copy; `validLabel` accepts `claude-auth-fix`, rejects `Claude Fix`, `-x`, 49 chars.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement `mcp/sessions.mjs`.
- [ ] **Step 4:** Tests pass.
- [ ] **Step 5:** `git commit -m "mcp: durable session registry"`

### Task 4: Named sessions through `ask_agent`; `sessions`, `session_close`, `session_config`

**Files:**
- Modify: `mcp/tools.mjs` (schemas + descriptions), `mcp/core.mjs` (dispatch + `INSTRUCTIONS`), `mcp/server.mjs` (`ask`, `startJob`, handlers, startup `reconcile`), `mcp/hub-process.mjs` (`hubArgsFor` gains `label`), `mcp/render.mjs`
- Test: `mcp/tests/core.test.mjs`, `mcp/tests/end-to-end.test.mjs`

**Interfaces:**
- Consumes: `createSessionRegistry` (Task 3), `--label` (Task 2).
- Produces:
  - `ask_agent` new args: `label?: string`, `worktree?: boolean`. With `label`: unknown label → new session; known label → continue with its `acpSessionId`, `cwd`/`worktree`, `model`, `effort` unless overridden. `label` + `sessionId` together → ToolError. Known label with a different `agent`, or a `cwd` different from the session's tree → ToolError `label <x> belongs to <agent> in <cwd>`.
  - A turn on a session already `running` → its prompt is appended to `queued` and the answer says `queued (n waiting)`; when the running job settles, the server starts the next queued prompt as a background job.
  - `sessions` tool: args `{ agent?, state?, includeClosed?: boolean }` → table via `renderSessions(rows)`.
  - `session_close` tool: `{ label }` → closes; for a worktree session reports `worktreeHasChanges` result and the path; never deletes a worktree with changes.
  - `session_config` tool: `{ label, model?, effort? }` → stored for the next turn.
  - Handlers added: `sessions(filter)`, `sessionClose(label)`, `sessionConfig(label, patch)`.
  - The registry lives at `join(HUB_CONFIG.resultsDir, 'sessions.json')`; `reconcile` runs at server start with `isJobLive = () => false`.

- [ ] **Step 1: Write failing tests** in `core.test.mjs` (handlers stubbed): label+sessionId rejected; label reused with another agent rejected with the message above; `sessions` renders label/agent/state/tree/model/last activity/spend columns; `session_close` on unknown label → isError. In `end-to-end.test.mjs` (fake agent): first `ask_agent {label:'t-one'}` creates the session with the fake's session id; second call with the same label passes `--continue <id>`; a new server instance on the same results dir lists `t-one` (persistence across restart).
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement. Add to `INSTRUCTIONS`: "Give every Claude/Codex conversation a short `label` and reuse it for follow-ups; `sessions` lists them; `session_close` ends one."
- [ ] **Step 4:** `npm test` green.
- [ ] **Step 5:** `git commit -m "mcp: named, persistent agent sessions"`

### Task 5: `session_log` and richer `job_status`

**Files:**
- Modify: `mcp/tools.mjs`, `mcp/core.mjs`, `mcp/server.mjs`, `mcp/render.mjs`, `acp/run-record.mjs` (`writeInflight` body)
- Test: `mcp/tests/core.test.mjs`, `acp/tests/transcript.test.mjs`

**Interfaces:**
- Consumes: `readTranscript` (Task 2), registry `get` (Task 3).
- Produces:
  - `session_log` tool: `{ label, before?: integer, limit?: integer (1–200, default 30), textOnly?: boolean }` → `renderSessionLog({ label, records, total, before })`, newest first, with a "older: before=<n>" hint when more exist.
  - `writeInflight` body adds `recentText: string` (last ≤600 chars of agent text this turn, redacted) and `pendingPermission: {requestId, title, toolKind, heldMs} | null` (filled in Task 7).
  - `withLiveJobDetails` and `renderJobStatus` show `recentText`, `pendingPermission`, label.

- [ ] **Step 1: Failing tests** — `session_log` on a 3-record fixture transcript renders newest first; unknown label → isError; `limit 201` → ToolError; `renderJobStatus` includes `recentText` when present.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** `npm test` green.
- [ ] **Step 5:** `git commit -m "mcp: session_log and live job text"`

### Task 6: Cancel keeps the session usable

**Files:**
- Modify: `mcp/server.mjs` (job settle hook updates the registry: `state`, `lastTurn`, `spendUsd += cost`, `acpSessionId` on first turn, `lastActivity`)
- Test: `mcp/tests/cancellation-e2e.test.mjs`

- [ ] **Step 1: Failing test** — fake agent: start labelled background job, `job_cancel`, then registry shows `idle`/`cancelled`; a follow-up with the same label runs with `--continue` and succeeds.
- [ ] **Step 2:** FAIL. **Step 3:** Implement the settle hook. **Step 4:** green.
- [ ] **Step 5:** `git commit -m "mcp: session state follows job lifecycle"`

### Task 7: Attended policy `ask` and `permission_answer`

**Files:**
- Modify: `acp/consent.mjs` (`PERMISSION_RANK.ask = 2`; `permissionSafetyReason` treats `ask` like `allow-all`), `acp/acp-client.mjs` (`makePermissionHandler('ask', log, { hold, treeRoot })`), `acp/hub-acp.mjs` (IPC hold/answer, pausable turn timer, tree lock for `ask`), `acp/hub-args.mjs` (`--permission ask`, `--permission-timeout MS` default 300000), `mcp/validate.mjs` (`PERMISSIONS` includes `ask`), `mcp/tools.mjs`, `mcp/core.mjs`, `mcp/server.mjs`, `mcp/hub-process.mjs` (IPC message routing to the job), `mcp/jobs.mjs` (job keeps `pendingPermission`)
- Test: `acp/tests/permissions.test.mjs`, `acp/tests/consent.test.mjs`, `mcp/tests/jobs.test.mjs`, `mcp/tests/end-to-end.test.mjs`

**Interfaces:**
- Produces:
  - `makePermissionHandler('ask', log, { hold: (request) => Promise<'allow_once'|'reject'>, treeRoot: string })`: auto-allow when `kind ∈ {read, search, think}`, or `kind === 'edit'` and every path in `toolCall.locations[].path` is inside `treeRoot`; otherwise `await hold(...)` and map the answer to the matching option (`allow_once` → first `allow_once`; `reject` → first `reject_once`).
  - IPC child → parent: `{ type: 'permission-request', requestId, title, toolKind, locations }`; parent → child: `{ type: 'permission-answer', requestId, decision: 'allow_once'|'reject' }`. Timeout in the child → `reject`, recorded as `decision: 'timeout'`.
  - Turn timer: hub-acp passes `timeoutMs: 0` (no client timer — add support in `AcpClient.request` for `0` meaning none) and runs its own deadline that is paused while any request is held; on expiry it calls the existing `requestStop()`.
  - `ask_agent` with `permission: 'ask'` and no `background: true` → ToolError `permission "ask" needs background: true`.
  - `permission_answer` tool: `{ jobId, decision: 'allow_once'|'reject' }` → sends the IPC answer for the job's pending request; no pending request → `{ isError: true, text: 'no pending permission request for <jobId>' }`.
  - Job state while held: `waiting-permission` (mirrored into the session registry).

- [ ] **Step 1: Failing tests** — handler: in-tree edit allowed without hold; out-of-tree edit, `execute`, `fetch`, `other` each call `hold`; `hold → 'reject'` selects `reject-once`. Consent: `ask` exceeds a `maxPermission: 'allow-reads'` grant; `permissionSafetyReason('ask', claude)` is `null`. Jobs/e2e (fake agent extended to send one `execute` permission request): job reaches `waiting-permission`, `job_status` shows `pendingPermission`; `permission_answer reject` → transcript has `decision: reject` and the turn completes; second run with `--permission-timeout 200` → `decision: timeout`; with `--timeout 300` and a 600 ms hold the turn is *not* killed (timer paused); `permission_answer` after the job ended → "no pending permission request".
- [ ] **Step 2:** FAIL. **Step 3:** Implement. Instructions text: "For Claude/Codex work you want to supervise, use `permission: \"ask\"` with `background: true`; when `job_status` shows a pending permission, ask the person, then call `permission_answer`."
- [ ] **Step 4:** `npm test` green.
- [ ] **Step 5:** `git commit -m "hub: attended permission policy with owner answers"`

### Task 8: Worktrees for `ask_agent`, automatic on a busy tree

**Files:**
- Modify: `mcp/server.mjs` (`startJob`, `ask`), `acp/worktree.mjs` (export `ensureWorktree(cwd, label, agent): {ok:true, path} | {ok:false, reason}` built on `repoInfo`/`worktreePath`/`createWorktree`)
- Test: `acp/tests/worktree.test.mjs`, `mcp/tests/core.test.mjs`

**Interfaces:**
- Produces: `ask_agent {worktree: true}` runs in `ensureWorktree(...)`'s path; a write-capable (`allow-all`/`ask`) job whose tree is busy is placed in a worktree automatically and the answer says `placed in worktree <path> because <tree> is busy`; the session records `worktree` and keeps it for later turns. Outside a git repo → existing busy refusal plus `(no worktree: <reason>)`.

- [ ] **Step 1: Failing tests** — `ensureWorktree` in a temp git repo returns an existing directory under the repo's git dir; in a non-repo temp dir returns `ok:false`; core: busy tree + allow-all → handler called with the worktree cwd and the message above.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** green.
- [ ] **Step 5:** `git commit -m "mcp: worktrees for named sessions"`

### Task 9: Handoff by reference

**Files:**
- Modify: `mcp/tools.mjs`, `mcp/core.mjs`, `mcp/server.mjs`
- Test: `mcp/tests/core.test.mjs`

**Interfaces:**
- Consumes: `readTranscript` (Task 2), registry (Task 3).
- Produces: `ask_agent` arg `from: { label: string, turns?: integer (default 1, max 3) }` → prompt becomes `<prompt>\n\n--- from session <label> (<agent>), last <n> turn(s) ---\n<agent text of those turns>\n--- full transcript: <path> ---`, trimmed from the oldest side so the whole prompt stays ≤ 4000 chars (hub-acp's `MAX_PROMPT_CHARS`). Unknown `from.label` → ToolError.

- [ ] **Step 1: Failing tests** — expansion includes the source agent text and the transcript path; a 10000-char source is trimmed so total ≤ 4000; unknown label → isError.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** green.
- [ ] **Step 5:** `git commit -m "mcp: hand one session's output to another"`

### Task 10: Docs and live acceptance

**Files:**
- Modify: `docs/reference/` MCP tool reference (wherever `ask_agent` is documented — find with `rg -l "job_status" docs`), `README.md` tool list, `docs/decisions.md` (one dated entry)
- Create: `docs/benchmarks/opencode-control-acceptance-<date>.md`

- [ ] **Step 1:** Update docs for the new args/tools; `npm run docs:check` passes.
- [ ] **Step 2:** Run the spec's acceptance 1–8 live from OpenCode with `claude` and `codex`; record pass/fail per item and, for acceptance 4, which permission requests each adapter actually sent.
- [ ] **Step 3:** `rg -n "sk-|ghp_|github_pat_|Bearer " results/sessions.json results/transcripts projects/logs/runs.jsonl` → no matches (acceptance 7).
- [ ] **Step 4:** `npm test` green; commit `docs: OpenCode control room reference and acceptance`.
