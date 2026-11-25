#!/usr/bin/env node
// vscode-state.mjs -- prune VS Code's remembered model list of providers that no longer exist.
//
//   node agent-hub/tools/vscode-state.mjs                 # dry run: what would go
//   node agent-hub/tools/vscode-state.mjs --apply         # edit state.vscdb (VS Code must be closed)
//   node agent-hub/tools/vscode-state.mjs --apply --force # same, while VS Code runs (see below)
//   node agent-hub/tools/vscode-state.mjs --json
//
// Why: VS Code remembers, per harness, the model you last used (`chat.currentLanguageModel.panel.<harness>`)
// and a configuration entry per model (`chat.modelConfiguration.panel.<harness>`). Those ids carry the
// provider, e.g. `agent-host-copilotcli:customendpoint/OpenCode Go/iceman-contributor-free`. Delete a BYOK
// group and the entry survives: the model picker keeps showing a provider tab that no longer exists, and
// the draft points at a model that cannot answer (seen 2026-11-13). Reloading is not enough; the rows have
// to go. This script removes only entries whose BYOK provider is not in `chatLanguageModels.json`; secrets
// and any VS Code model are untouched. It never runs while VS Code is open: the storage service would
// overwrite the edit. `--force` skips that guard; measured 2026-11-13, VS Code picked the change up on the
// next window reload, so a full restart was not needed — but the value can be rewritten at any time, so
// closing VS Code first is still the safer way.
//
// CHAT_LANGUAGE_MODELS overrides the config path; VSCODE_STATE_DB overrides the state database path.

import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import { readJson, userConfigPath } from './vscode-models.mjs';

const BYOK_VENDORS = new Set(['openrouter', 'customendpoint', 'customoai', 'openai', 'anthropic', 'gemini', 'ollama', 'azure', 'xai']);

export function stateDbPath() {
  if (process.env.VSCODE_STATE_DB) return process.env.VSCODE_STATE_DB;
  const user = dirname(userConfigPath());
  return join(user, 'globalStorage', 'state.vscdb');
}

/** `agent-host-copilotcli:customendpoint/OpenCode Go/iceman-contributor-free` -> `customendpoint/OpenCode Go` */
export function providerOf(key) {
  const afterColon = key.includes(':') ? key.slice(key.indexOf(':') + 1) : key;
  for (const vendor of BYOK_VENDORS) {
    if (afterColon.startsWith(`${vendor}/`)) {
      const rest = afterColon.slice(vendor.length + 1);
      const slash = rest.indexOf('/');
      return slash === -1 ? null : `${vendor}/${rest.slice(0, slash)}`;
    }
  }
  return null;
}

/** Known BYOK providers as `vendor/name`. */
export function knownProviders(groups) {
  return new Set((groups ?? []).filter((g) => BYOK_VENDORS.has(g.vendor)).map((g) => `${g.vendor}/${g.name}`));
}

/** Model-id map (or single id) with the entries of unknown BYOK providers removed. */
export function pruneModelMap(value, known) {
  const isByok = (key) => providerOf(key) !== null;
  if (typeof value === 'string') {
    return isByok(value) && !known.has(providerOf(value)) ? { value: null, dropped: [value] } : { value, dropped: [] };
  }
  if (!value || typeof value !== 'object') return { value, dropped: [] };
  const out = {};
  const dropped = [];
  for (const [key, v] of Object.entries(value)) {
    const provider = providerOf(key);
    if (provider && !known.has(provider)) dropped.push(key);
    else out[key] = v;
  }
  return { value: out, dropped };
}

function isVSCodeRunning() {
  const out = spawnSync('tasklist', ['/FI', 'IMAGENAME eq Code.exe', '/NH'], { encoding: 'utf8' });
  return /Code\.exe/i.test(String(out.stdout ?? ''));
}

function main() {
  const argv = process.argv.slice(2);
  const apply = argv.includes('--apply');
  const force = argv.includes('--force');
  const grouped = argv.includes('--json');
  const config = readJson(userConfigPath());
  const known = knownProviders(config);
  const dbPath = stateDbPath();
  if (!existsSync(dbPath)) {
    process.stdout.write(`no VS Code state database at ${dbPath}\n`);
    return;
  }
  if (apply && !force && isVSCodeRunning()) {
    process.stderr.write('VS Code is running: close every window (the storage service rewrites the file) and run it again, or pass --force\n');
    process.exitCode = 1;
    return;
  }
  if (apply && force) {
    process.stderr.write('--force: writing while VS Code runs; its storage service may keep the old value in memory until every window closes\n');
  }  const db = new DatabaseSync(dbPath, { readOnly: !apply });
  const keys = ['chat.currentLanguageModel.panel.agent-host-copilotcli', 'chat.modelConfiguration.panel.agent-host-copilotcli',
    'chat.currentLanguageModel.panel', 'chat.modelConfiguration.panel'];
  const report = [];
  for (const key of keys) {
    const row = db.prepare('select value from ItemTable where key = ?').get(key);
    if (!row) continue;
    const raw = String(row.value);
    let parsed;
    let isJson = true;
    try { parsed = JSON.parse(raw); } catch { parsed = raw; isJson = false; }
    const { value, dropped } = pruneModelMap(parsed, known);
    if (dropped.length) report.push({ key, dropped });
    if (apply && dropped.length) {
      // A plain-string row (the "current model" pointer) is removed; VS Code then picks a default.
      if (value === null) db.prepare('delete from ItemTable where key = ?').run(key);
      else db.prepare('update ItemTable set value = ? where key = ?').run(isJson ? JSON.stringify(value) : String(value), key);
    }
  }
  db.close();

  if (grouped) {
    process.stdout.write(`${JSON.stringify({ dbPath, known: [...known], report }, null, 2)}\n`);
  } else if (!report.length) {
    process.stdout.write('nothing to prune\n');
  } else {
    for (const r of report) {
      process.stdout.write(`${r.key}: ${r.dropped.length} stale entr${r.dropped.length === 1 ? 'y' : 'ies'}\n`);
      for (const d of r.dropped) process.stdout.write(`  - ${d}\n`);
    }
    process.stdout.write(apply ? 'written\n' : 'dry run: add --apply with VS Code closed\n');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
