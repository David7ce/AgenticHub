#!/usr/bin/env node
// gateway-run.mjs -- starts the pinned AHP-ACP gateway from a local install, with the changes
// in gateway-patch.mjs. Replaces `npx --yes ahp-acp-gateway@x`, which re-resolves a package
// from the npm cache on every start; this runs exactly the version installed under
// logs/ahp-gateway-pkg (see tools/run-ahp-gateway.ps1, which installs it with --ignore-scripts).
//
//   node agent-hub/ahp/gateway-run.mjs --config logs/ahp-gateway.json
//
// The rest mirrors the gateway's own cli.js: load the config, listen, close on SIGINT/SIGTERM.

import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { appendRotating, patchGateway } from './gateway-patch.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const STATE_DIR = process.env.AGENT_HUB_STATE ? resolve(process.env.AGENT_HUB_STATE) : join(resolve(HERE, '..', '..'), 'projects');
export const PACKAGE_DIR = join(STATE_DIR, 'logs', 'ahp-gateway-pkg', 'node_modules', 'ahp-acp-gateway', 'dist', 'src');
const RPC_LOG = join(STATE_DIR, 'logs', 'ahp-gateway-rpc.log');

const { values } = parseArgs({ options: { config: { type: 'string', short: 'c' } }, strict: true });

const load = (name) => import(pathToFileURL(join(PACKAGE_DIR, name)).href);
let gateway;
let configModule;
try {
  [gateway, configModule] = await Promise.all([load('gateway.js'), load('config.js')]);
} catch (error) {
  process.stderr.write(`gateway-run: the gateway is not installed under ${PACKAGE_DIR} (${error.code ?? error.message}); run tools/run-ahp-gateway.ps1\n`);
  process.exit(1);
}

mkdirSync(dirname(RPC_LOG), { recursive: true });
patchGateway(gateway.GatewayServer, {
  log: (entry) => {
    try {
      appendRotating(RPC_LOG,`${JSON.stringify({ t: new Date().toISOString(), ...entry })}\n`);
    } catch {
      // Logging must never take a request down with it.
    }
  },
});

const config = await configModule.loadConfig(values.config);
await configModule.ensureConfigDirectories(config);
const server = new gateway.GatewayServer(config);
const address = await server.listen();
process.stdout.write(`AHP-ACP Gateway listening on ws://${address.host}:${address.port}${address.path}\n`);

let closing = false;
const shutdown = async (signal) => {
  if (closing) return;
  closing = true;
  process.stderr.write(`Received ${signal}; shutting down\n`);
  await server.close();
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
