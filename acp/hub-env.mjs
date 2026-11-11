// hub-env.mjs — where hub-acp keeps its files and the limits it applies.
// Every path honours its AGENT_HUB_* override so tests can sandbox a run.

import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const HERE = dirname(fileURLToPath(import.meta.url));
export const HUB_DIR = resolve(HERE, '..');
// The folder that holds agent-hub/ and projects/. Not a repository.
export const WORKSPACE_DIR = resolve(HUB_DIR, '..');
// Per-machine state (logs/, working/) lives in projects/, never in a repo's tracked files.
export const STATE_DIR = process.env.AGENT_HUB_STATE
  ? resolve(process.env.AGENT_HUB_STATE)
  : join(WORKSPACE_DIR, 'projects');
export const RESULTS_DIR = process.env.AGENT_HUB_RESULTS
  ? resolve(process.env.AGENT_HUB_RESULTS)
  : join(HUB_DIR, 'results');
export const LOCKS_DIR = process.env.AGENT_HUB_LOCKS
  ? resolve(process.env.AGENT_HUB_LOCKS)
  : join(RESULTS_DIR, 'locks');
export const LOG_PATH = process.env.AGENT_HUB_LOG
  ? resolve(process.env.AGENT_HUB_LOG)
  : join(STATE_DIR, 'logs', 'runs.jsonl');
// Local registry first; a fresh clone runs with the shipped example.
export const DEFAULT_REGISTRY = existsSync(join(HERE, 'agents.json'))
  ? join(HERE, 'agents.json')
  : join(HERE, 'agents.example.json');
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

// Written while a run is in flight so `hubctl status` and the MCP status tool
// can show what is happening now. logs/runs.jsonl only gets its line at the
// end, which is why a stuck turn used to be invisible everywhere.
export const INFLIGHT_DIR = process.env.AGENT_HUB_INFLIGHT
  ? resolve(process.env.AGENT_HUB_INFLIGHT)
  : join(RESULTS_DIR, 'inflight');
