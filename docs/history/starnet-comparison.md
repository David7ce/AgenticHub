# StarNet: what the public repo shows (verified so far)

Source: https://raw.githubusercontent.com/androoAGI/starnet/feat/harness-backend/package.json (read in full)
Repo: https://github.com/androoAGI/starnet (branch feat/harness-backend)

## Verified from package.json
- Name: starnet-harness, version 0.13.5, MIT license, author Andrew Sims.
- Description: "A local-first, gamified desktop harness for building and running real AI-agent teams."
- Entry points: `node sidecar/index.js` (start), `sidecar/mcp/serve.js` (MCP), `sidecar/acp/serve.js` (ACP). CLI bin: `bin/starnet.js`.
- Desktop shell: Tauri (`tauri` scripts, `@tauri-apps/cli` ^2).
- Runtime dependencies: @huggingface/transformers, ajv 8.20.0, kokoro-js (voice), node-pty (terminal), ogg-opus-decoder, undici.
- Node >= 18.
- Overrides: adm-zip 0.6.1, sharp 0.35.4.

## Not found in package.json
- No dependency on Hermes, OpenClaw, Paperclip, LangChain, CrewAI, AutoGen, LangGraph, or Claude Code.
- So the package manifest does not show that StarNet is built on any named open-source agent runtime.
- The README mentions importing Hermes or OpenClaw agent homes. That is an import feature, not proof of a dependency.

## Harness dependency (answered 2026-10-30)
- `sidecar/` is StarNet's own code: `index.js` (station), `acp/`, `channels/`,
  `providers/`, `execution-*`, `checkpoint-store.js`, `harness-import.js`. No
  LangChain/CrewAI/AutoGen/Claude-Code import anywhere.
- It does have an *import* path: `harness-import.js` reads an OpenClaw
  (`%USERPROFILE%\.openclaw`) or Hermes (`%LOCALAPPDATA%\hermes`) agent home and
  mints a StarNet agent from the persona + model id. Secrets are explicitly
  never transferred.

## Isolation (verified in the installed copy)
- One workspace per agent: `WORKSPACES/<agentId>`.
- Shadow git repo per agent (`.checkpoints/<agentId>/git`) driven with
  `--git-dir ... --work-tree ...` — snapshot/restore, not branches.
- Execution profiles: `safe-cell` (Docker), `remote-ssh`, `trusted-project`,
  `this-computer`.
- **No `git worktree add`.** StarNet does not share, create or see the hub's
  worktrees; its isolation is a different primitive.

## Open checks
- Compare StarNet against alternatives on the same tasks (for example the
  Composio 8-harness, 25-task test).
- Judge the desktop UI itself: only the sidecar and ACP were exercised.

See [`alternatives-2026-10.md`](alternatives-2026-10.md) for the full field and
the decision.

## Alternatives named in search results (headlines and summaries only, not full pages)
- Harness: Claude Code, Codex CLI, Gemini CLI, Cursor, Copilot, OpenCode, Hermes, Goose, Qwen Code, Zed Agent.
- Orchestrators: Paperclip, LangGraph, CrewAI, AutoGen, Mastra, AutoGPT, MetaGPT.
- Sources: cellcog.ai, winder.ai, harnessrouter.ai, edenai.co, atlan.com, composio.dev.

## Status (2026-10-30)

Installed locally at `%LOCALAPPDATA%\StarNet` (`skynet-desktop.exe`, bundled
`node.exe`, `sidecar/`, `frontend/`, `models/`). Verified:

- The sidecar starts and `/api/health` returns `"ok"`.
- Its ACP agent (`sidecar/acp/serve.js --port=8787`) completes `initialize` +
  `session/new`; `agentInfo` is `{name: "starnet", title: "StarNet",
  version: "dev"}`.
- It proxies to the running station, so the desktop shell or sidecar must be
  up first.
- Registered in `acp/agents.json` as `starnet`; no consent grant yet.

The harness-dependency question is answered: the sidecar is StarNet's own code
(see above), with no named agent runtime underneath.
