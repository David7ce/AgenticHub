// route-pick.mjs — the router's decision, callable from hub-acp itself.
//
// Kept out of hub-acp.mjs so tests can import it without starting the CLI
// (hub-acp runs main() at module load, like the other entry points).
import { DEFAULT_LOG } from './router-config.mjs';
import { decideRoute } from './router-decide.mjs';
import { readRunStats } from './router-stats.mjs';

/** Same prompt rules and 24 h health overlay as router.mjs, resolved in-process. */
export function chooseAutoAgent(prompt, { stats = readRunStats(DEFAULT_LOG), registryPath } = {}) {
  return decideRoute(prompt, { stats, registryPath });
}

