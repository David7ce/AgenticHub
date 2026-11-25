// hub-env.mjs — where hub-acp keeps its files and the limits it applies.
// Every path honours its AGENT_HUB_* override so tests can sandbox a run.

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HUB_CONFIG } from './config.mjs';

export const HERE = dirname(fileURLToPath(import.meta.url));
export const {
  hubDir: HUB_DIR, workspaceDir: WORKSPACE_DIR, stateDir: STATE_DIR,
  resultsDir: RESULTS_DIR, locksDir: LOCKS_DIR, logPath: LOG_PATH,
  registryPath: DEFAULT_REGISTRY, inflightDir: INFLIGHT_DIR,
} = HUB_CONFIG;
export const TRANSCRIPTS_DIR = join(RESULTS_DIR, 'transcripts');

export const MAX_PROMPT_CHARS = 4000;
export const MAX_OUTPUT_CHARS = 20000;
// Runtime activity is the point of the audit trail (see
// docs/tetragon-runtime-security.md), but a runaway agent can emit thousands
// of tool calls. Log a bounded summary plus the true count.
export const MAX_LOGGED_TOOLS = 100;

// defaultConfig is a map of ACP session config options (model=..., mode=...).
// Anything else that ends up in the registry entry must not be sent to the
// agent as a config id -- OpenCode answers "unknown config option" to that.
export const NON_CONFIG_KEYS = new Set(['modelFallbacks', 'notes', 'label']);

// How long a cancelled turn gets to stop on its own before the process is
// killed. ACP's session/cancel is a notification with no reply, so the only
// proof it worked is the turn ending -- and a model mid-tool-call needs a few
// seconds. Too short here is what leaves an agent editing after a "timeout".
export const CANCEL_WAIT_MS = Number(process.env.HUB_CANCEL_WAIT_MS ?? 8000);

