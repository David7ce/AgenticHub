// registry.mjs — the agent registry (agents.json) and MCP server config.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { fail } from './hub-args.mjs';

export function commandExists(command) {
  // An absolute path is a file to check, not a name to search PATH for --
  // and on at least this machine, Windows' `where` rejects a full path
  // outright ("Invalid pattern is specified in path:pattern") rather than
  // resolving it, so this is correctness, not just a shortcut.
  if (isAbsolute(command)) return existsSync(command);
  if (process.platform === 'win32') {
    return spawnSync('where', [command], { stdio: 'ignore' }).status === 0;
  }
  return spawnSync('sh', ['-c', 'command -v "$1"', 'sh', command], { stdio: 'ignore' }).status === 0;
}

export function loadRegistry(file) {
  if (!existsSync(file)) fail(`registry not found: ${file}`);
  let raw;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    fail(`registry is not valid JSON (${file}): ${err.message}`);
  }
  if (!raw?.agents || typeof raw.agents !== 'object') fail(`registry has no "agents" object: ${file}`);
  return raw;
}

export function resolveAgent(registry, name) {
  const entry = registry.agents[name];
  if (!entry) {
    fail(`unknown agent "${name}" -- known: ${Object.keys(registry.agents).join(', ')}`);
  }
  // Platform overrides win over the cross-platform default. `pathStyle:
  // "wsl"` means the agent lives inside WSL even when the hub runs on
  // Windows, so session paths must be translated before session/new.
  const platform = entry.platforms?.[process.platform] ?? {};
  const command = platform.command ?? entry.command;
  const args = platform.args ?? entry.args ?? [];
  const pathStyle = platform.pathStyle ?? entry.pathStyle ?? 'native';
  const env = { ...(entry.env ?? {}), ...(platform.env ?? {}) };
  if (!command) fail(`agent "${name}" has no command for ${process.platform}`);
  return {
    name,
    label: entry.label ?? name,
    command,
    args,
    pathStyle,
    env,
    notes: entry.notes,
    defaultConfig: entry.defaultConfig,
    // The modes each permission policy may force (attended/restricted). `ask`
    // reads `attended.force`, so the resolver must not drop it.
    permissionModes: entry.permissionModes,
    effort: entry.effort,
  };
}

export function listAgents(registry, opts) {
  const rows = Object.entries(registry.agents).map(([name, entry]) => {
    const resolved = resolveAgent(registry, name);
    const available = commandExists(resolved.command);
    const launcherOnly = /(^|[\\/])npx(\.cmd|\.exe)?$/i.test(resolved.command);
    return {
      name,
      label: resolved.label,
      command: [resolved.command, ...resolved.args].join(' '),
      available,
      launcherOnly,
    };
  });

  if (opts.json) {
    process.stdout.write(JSON.stringify(rows, null, 2) + '\n');
    return;
  }
  for (const row of rows) {
    const status = !row.available
      ? 'not found on PATH'
      : row.launcherOnly
        ? 'launcher found (npx fetches on first run)'
        : 'available';
    process.stdout.write(
      `${row.name.padEnd(10)} ${row.label.padEnd(26)} ${status}\n  ${row.command}\n`,
    );
  }
}

export function normalizeEnv(env) {
  if (Array.isArray(env)) return env;
  if (env && typeof env === 'object') {
    return Object.entries(env).map(([name, value]) => ({ name, value: String(value) }));
  }
  return [];
}

export function normalizeMcpServers(rawList) {
  if (!Array.isArray(rawList)) fail('MCP config must be an array, or { "mcpServers": [...] }');
  return rawList.map((server, index) => {
    const where = `mcpServers[${index}]`;
    if (!server?.name) fail(`${where} has no name`);
    if (server.type === 'http' || server.type === 'sse') {
      if (!server.url) fail(`${where} (${server.type}) has no url`);
      return {
        type: server.type,
        name: server.name,
        url: server.url,
        headers: Array.isArray(server.headers) ? server.headers : [],
      };
    }
    if (!server.command) fail(`${where} has no command (or type: http/sse)`);
    return {
      name: server.name,
      command: server.command,
      args: Array.isArray(server.args) ? server.args : [],
      env: normalizeEnv(server.env),
    };
  });
}

export function loadMcpServers(file) {
  if (!file) return [];
  if (!existsSync(file)) fail(`MCP config not found: ${file}`);
  let raw;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    fail(`MCP config is not valid JSON (${file}): ${err.message}`);
  }
  return normalizeMcpServers(Array.isArray(raw) ? raw : raw?.mcpServers);
}

export function checkMcpCapabilities(servers, capabilities) {
  const http = capabilities?.mcpCapabilities?.http === true;
  const sse = capabilities?.mcpCapabilities?.sse === true;
  for (const server of servers) {
    if (server.type === 'http' && !http) {
      throw new Error(`agent does not advertise MCP http transport (needed by "${server.name}")`);
    }
    if (server.type === 'sse' && !sse) {
      throw new Error(`agent does not advertise MCP sse transport (needed by "${server.name}")`);
    }
  }
  if (servers.length) {
    const unknown = servers.filter((s) => s.type !== 'http' && s.type !== 'sse');
    for (const s of unknown) {
      if (!isAbsolute(s.command) && process.platform !== 'win32') {
        process.stderr.write(
          `[acp] note: MCP command "${s.command}" is not an absolute path; ACP asks for one. ` +
            `The agent may resolve it from its own PATH.\n`,
        );
      }
    }
  }
}
