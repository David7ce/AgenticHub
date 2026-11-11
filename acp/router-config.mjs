// router-config.mjs — paths and thresholds shared by the router modules.
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { STATE_DIR } from './hub-env.mjs';

export const HERE = dirname(fileURLToPath(import.meta.url));
// Local registry first; a fresh clone runs with the shipped example.
export const DEFAULT_REGISTRY = existsSync(join(HERE, 'agents.json'))
  ? join(HERE, 'agents.json')
  : join(HERE, 'agents.example.json');
export const HUB = join(HERE, 'hub-acp.mjs');
export const DEFAULT_LOG = join(STATE_DIR, 'logs', 'runs.jsonl');
export const MODELS_PATH = join(HERE, '..', 'models.json');

export const CHEAP_AGENT = 'opencode';
export const STRONG_AGENT = 'claude';

export const RECENT_FAILURE_WINDOW_MS = 15 * 60 * 1000;
export const STATS_WINDOW_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_COST_CEILING = 3.0;
