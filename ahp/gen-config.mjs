#!/usr/bin/env node
// gen-config.mjs -- writes the AHP-ACP gateway configuration from the hub's own
// registry and consent file, so there is one source of truth.
//
//   node agent-hub/ahp/gen-config.mjs [--out FILE] [--port 8765] [--all]
//
// - Only agents with an enabled grant become providers (--all adds the rest,
//   which then refuse at start-up with the gate's reason).
// - Each provider launches consent-proxy.mjs, never the agent directly, so the
//   gate, the audit line and the spend caps stay in front of it.
// - Every built-in provider of the gateway that is not ours is switched off:
//   the gateway would otherwise advertise (and launch with an unpinned
//   `npx --yes`) agents the hub knows nothing about.
// - The listener is loopback with a strict Origin allowlist (VS Code's renderer).
// Pinned versions come from agents.json, the same ones the hub runs.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CONSENT_PATH, readConsent } from '../acp/consent.mjs';
import { DEFAULT_REGISTRY, STATE_DIR } from '../acp/hub-env.mjs';
import { loadRegistry } from '../acp/registry.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const PROXY = join(HERE, 'consent-proxy.mjs');
export const DEFAULT_OUT = join(STATE_DIR, 'logs', 'ahp-gateway.json');

// ahp-acp-gateway 0.2.2 built-in provider ids (its ahp-acp-gateway.default.json).
export const GATEWAY_BUILTINS = [
  'copilot', 'claude', 'gemini', 'qwen', 'auggie', 'qoder', 'codex',
  'opencode', 'openclaw', 'kiro', 'hermes', 'kimi', 'pi',
];

export function buildConfig({ registry, consent, port = 8765, all = false, proxy = PROXY, node = process.execPath }) {
  const grants = consent?.grants ?? consent ?? {};
  const chosen = Object.keys(registry.agents).filter((name) => all || grants[name]?.enabled === true);

  const providers = chosen.map((name) => {
    const entry = registry.agents[name];
    return {
      id: name,
      displayName: entry.label ?? name,
      description: `Through the AgentHub consent gate (${name}).`,
      command: node,
      args: [proxy, '--agent', name],
      startupTimeoutMs: 120000,
    };
  });
  const off = GATEWAY_BUILTINS.filter((id) => !chosen.includes(id)).map((id) => ({ id, enabled: false }));

  return {
    version: 1,
    listener: {
      host: '127.0.0.1',
      port,
      allowAnyOrigin: false,
      allowedOrigins: ['vscode-file://vscode-app'],
    },
    providers: [...providers, ...off],
  };
}

function parseArgs(argv) {
  const out = { out: DEFAULT_OUT, port: 8765, all: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out') out.out = resolve(argv[++i]);
    else if (argv[i] === '--port') out.port = Number(argv[++i]);
    else if (argv[i] === '--all') out.all = true;
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  return out;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const read = readConsent(CONSENT_PATH);
  if (!read.ok) throw new Error(`cannot read the consent file: ${read.reason}`);
  const config = buildConfig({
    registry: loadRegistry(DEFAULT_REGISTRY),
    consent: read,
    port: opts.port,
    all: opts.all,
  });
  mkdirSync(dirname(opts.out), { recursive: true });
  writeFileSync(opts.out, `${JSON.stringify(config, null, 2)}\n`);
  const names = config.providers.filter((p) => p.enabled !== false).map((p) => p.id);
  process.stdout.write(`wrote ${opts.out}: providers ${names.join(', ') || '(none: no grant is enabled)'}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
