// Runtime paths shared by execution and diagnostics. This resolves names only:
// it never reads grants, creates directories or relaxes a missing override.
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_HUB = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function resolveHubConfig({ hubDir = DEFAULT_HUB, env = process.env, cwd = process.cwd(), exists = existsSync, stateDir } = {}) {
  const path = (value, fallback) => value ? resolve(cwd, value) : fallback;
  hubDir = resolve(cwd, hubDir);
  const workspaceDir = dirname(hubDir);
  const panel = join(workspaceDir, 'workspaces-panel');
  const previousPanel = join(workspaceDir, 'workspace-panel');
  const legacy = join(workspaceDir, 'projects');
  const hasState = (dir) => [['logs', 'runs.jsonl'], ['logs', 'hub.db'], ['working', '.git']]
    .some((parts) => exists(join(dir, ...parts)));
  // Pulling a newer checkout must not silently abandon the old audit or notes.
  const existingState = [panel, previousPanel, legacy].find(hasState) ?? panel;
  stateDir = path(stateDir ?? env.AGENT_HUB_STATE, existingState);
  const resultsDir = path(env.AGENT_HUB_RESULTS, join(hubDir, 'results'));
  const localRegistry = join(hubDir, 'acp', 'agents.json');
  const exampleRegistry = join(hubDir, 'acp', 'agents.example.json');
  const defaultRegistryPath = exists(localRegistry) ? localRegistry : exampleRegistry;
  const registryPath = path(env.AGENT_HUB_REGISTRY, defaultRegistryPath);
  return Object.freeze({
    hubDir, workspaceDir, stateDir, resultsDir,
    registryPath, defaultRegistryPath,
    usingExampleRegistry: registryPath === exampleRegistry,
    consentPath: path(env.AGENT_HUB_CONSENT, join(hubDir, 'consent.json')),
    logPath: path(env.AGENT_HUB_LOG, join(stateDir, 'logs', 'runs.jsonl')),
    locksDir: path(env.AGENT_HUB_LOCKS, join(resultsDir, 'locks')),
    inflightDir: path(env.AGENT_HUB_INFLIGHT, join(resultsDir, 'inflight')),
    tasksDb: path(env.AGENT_HUB_TASKS_DB, join(stateDir, 'logs', 'hub.db')),
    indexPath: path(env.AGENT_HUB_INDEX, join(stateDir, 'logs', 'index.db')),
  });
}

export const HUB_CONFIG = resolveHubConfig();

// Routing helpers may receive an environment override after module loading.
// Keep the startup fallback stable rather than probing for a different local
// registry halfway through a server's lifetime.
export function configuredRegistryPath(env = process.env) {
  return env.AGENT_HUB_REGISTRY ? resolve(env.AGENT_HUB_REGISTRY) : HUB_CONFIG.registryPath;
}
