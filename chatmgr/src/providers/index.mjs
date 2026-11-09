import * as codex from "./codex.mjs";
import * as claude from "./claude.mjs";
import * as hermes from "./hermes.mjs";
import * as opencode from "./opencode.mjs";

/** Registry used by the CLI and the TUI. Same keys as core/capabilities.mjs. */
export const adapters = { opencode, codex, claude, hermes };

export const adapterList = () =>
  Object.entries(adapters).map(([id, module]) => ({ id, ...module }));
