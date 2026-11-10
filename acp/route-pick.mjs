// route-pick.mjs — the router's decision, callable from hub-acp itself.
//
// Kept out of hub-acp.mjs so tests can import it without starting the CLI
// (hub-acp runs main() at module load, like the other entry points).
import { resolve } from 'node:path';
import { DEFAULT_LOG } from './router-config.mjs';
import { decideRoute } from './router-decide.mjs';
import { readRunStats } from './router-stats.mjs';

// Honour the same override hub-acp uses, so a sandboxed run never reads this
// machine's real audit history to decide.
const LOG = process.env.AGENT_HUB_LOG ? resolve(process.env.AGENT_HUB_LOG) : DEFAULT_LOG;

/** Same prompt rules and 24 h health overlay as router.mjs, resolved in-process. */
export function chooseAutoAgent(prompt, { stats = readRunStats(LOG) } = {}) {
  return decideRoute(prompt, { stats });
}
