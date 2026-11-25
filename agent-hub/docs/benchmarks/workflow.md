# Which agent, which workflow

Run 2026-11-08 on this machine. This is not a model leaderboard: online suites
already rank raw model quality. The question here is narrower — **which worker
should the hub launch, and when is a second one worth its cost?**

## Measured

| Check | OpenCode `deepseek-v4.1-flash` | Claude `sonnet` | Hermes free | Codex |
|---|---|---|---|---|
| Two bench fixes (`paths-to-wsl`, `router-decide`) | **2/2**, 87 s, 9/7 tools, $0 | **2/2**, 89 s, 4/5 tools, $0.32 | **0/2**, both timeout ~310 s, 0 tools | not runnable via ACP |
| Hard construct (`construct-relative-cli`) | **1/1**, 92 s, 18 tools, $0 | **1/1**, 68 s, 10 tools, $0.25 | not attempted (tool use unreliable) | — |
| Review one seeded off-by-one | **correct, 8 s** | **correct, 54 s** | not reliable | — |
| Resume two turns (recall `ORANGE-77`) | yes | yes | text-only | — |
| Echo one token | yes | yes | yes, 22 s | CLI only |
| Real handoff OpenCode → Claude | — | **token preserved, 65 s** | — | — |
| Cost model | Go flat rate ($0 reported) | ~$0.16 per short task | $0 | subscription |

Server/clients: Windows hub, OpenCode in WSL through `wsl.exe`. Codex CLI
0.167.0 answers `gpt-6.1-sol`, but `@zed-industries/codex-acp@0.16.0` ends every
prompt in `Internal error (-32603)`; the account rejects the adapter's older
models. It is not registered, so there is nothing to route to.

Hermes free failed differently per model: `stepfun/step-3.7-flash:free` timed
out on both tool tasks; `upstage/solar-mini4:free` answered a file read but
emitted raw `<|tool_call|>` text instead of ACP tool events; `beam` timed out.
Text replies work; tool use is not dependable.

## Recommendation

**Default: OpenCode.** It matched Claude on the two deterministic fixes, found
the seeded bug in 8 s, resumed correctly, and used tools properly. It is
flat-rate, already the daily surface, and the fastest safe default.

**Escalate: Claude `sonnet`.** Same correctness on this small sample and
noticeably more efficient on the hard construct (68 s / 10 tools vs 92 s / 18),
but ~7× slower on review and ~$0.16–0.25 per short task. Use it when the task
spans several modules, touches permissions/secrets/money, or OpenCode already
failed. Do not use it for routine edits.

**Hermes free: text only.** Good for summaries, naming, brainstorming and
drafting prose. Do not give it code edits, tool-heavy tasks or any secret:
free providers may retain data and its tool calls are unreliable.

**Codex: wait.** Keep it out of the routing table until its ACP adapter supports
the account's model. Using it by hand through `codex exec` is possible, but it
is outside the consent gate, audit log and tree lock.

## Workflow

```
L0  OpenCode solo                     normal work, the default
L1  Claude sonnet solo                multi-file, high consequence, or L0 failed
L2  OpenCode -> Claude review         risky change; Claude is read-only reviewer
L3  OpenCode + Hermes (text)          independent ideas/summaries, Claude synth
```

- **L0** covers almost everything; 2/2 on the deterministic pair and the bug
  review. One writer per tree; `--worktree` before parallel edits.
- **L1** is the same shape with a stronger worker. Use `--permission deny` for
  review and `allow-all` only inside a worktree.
- **L2** only when a wrong answer is expensive. The measured review added no
  correctness on the seeded bug (OpenCode already found it), so do not pay for
  a reviewer by default.
- **L3** only for ambiguous text work where independent opinions help. Hermes
  must not be the implementer. Synthesis is one extra call; skip it when the
  answers already agree.
- **Never** fan out to four agents "because they exist". Each extra worker adds
  latency, quota and a merge step; the audit already shows timeouts at 20–40
  minutes when a turn goes wrong.
- Observe with `hubctl live`; stop a run whose `silent` time passes the stall
  threshold instead of waiting for the full timeout.
- All of this stays under `consent.json`, the budget and the audit log.

## Reproduce

```powershell
node bench/run.mjs --agent opencode --model opencode-go/deepseek-v4.1-flash --tasks paths-to-wsl,router-decide --reps 1 --keep
node bench/run.mjs --agent claude --model sonnet --tasks paths-to-wsl,router-decide --reps 1 --keep
node bench/run.mjs --agent hermes --model nous:stepfun/step-3.7-flash:free --tasks paths-to-wsl,router-decide --reps 1 --keep
node bench/collab.mjs --real --write
```

Raw per-attempt JSONL stays in `results/bench/` (gitignored); this
report is the durable result.

## Full suite, 2026-11-10

`node bench/run.mjs --agent claude --model sonnet` — **14/14 in 602.7 s,
$2.38** (one attempt per task; raw rows in
`results/bench/2026-11-10T20-22-38-651-claude.jsonl`). Same pass count as
the OpenCode baseline and the repeated Codex/OpenCode runs. Claude is slower and
paid, which is the routing rule working as intended: escalate on scope or
consequence, not by default.

## Codex via codex-acp 2.6.0 (2026-11-08)

Probe: ACP v1, adapter 2.6.0; `session/new` offers gpt-6.1-terra (default), gpt-6.1-sol,
gpt-6-luna, gpt-6-astra; options `reasoning_effort` (low..ultra) and `fast-mode`. `CODEX_OK` in
7.3 s on Terra. `allow-all` outside AgentHub is denied by the consent limits.

| Model | paths-to-wsl | construct-relative-cli | Time |
|---|---|---|---|
| gpt-6.1-sol | PASS | PASS | 133.5 s |
| gpt-6.1-terra | PASS | FAIL | 56.5 s |
| gpt-6-luna | FAIL | FAIL | 20.4 s |

One repetition each. Conclusion: Sol for code (2/2), Terra for review/text, Luna not for code.

