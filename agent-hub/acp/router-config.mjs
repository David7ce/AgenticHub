// router-config.mjs — paths and thresholds shared by the router modules.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HUB_CONFIG } from './config.mjs';

export const HERE = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_REGISTRY = HUB_CONFIG.registryPath;
export const HUB = join(HERE, 'hub-acp.mjs');
export const DEFAULT_LOG = HUB_CONFIG.logPath;
export const MODELS_PATH = join(HERE, '..', 'models.json');

export const CHEAP_AGENT = 'opencode';
export const STRONG_AGENT = 'claude';

export const RECENT_FAILURE_WINDOW_MS = 15 * 60 * 1000;
export const STATS_WINDOW_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_COST_CEILING = 3.0;

