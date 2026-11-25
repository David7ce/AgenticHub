#!/usr/bin/env node
// vscode-models.mjs -- keeps VS Code's BYOK model list in the repo.
//
//   node agent-hub/tools/vscode-models.mjs            # same as --check
//   node agent-hub/tools/vscode-models.mjs --apply    # write the curated ids into the user config
//   node agent-hub/tools/vscode-models.mjs --online   # also ask OpenRouter whether each id still exists
//   node agent-hub/tools/vscode-models.mjs --json
//
// Why: `%APPDATA%\Code\User\chatLanguageModels.json` is user config, not repo state. It is lost with the
// VS Code profile, and a provider retires models without telling anyone, so a selector that worked
// yesterday quietly offers a dead id. `tools/vscode-models.json` holds the curated list; the script keeps
// the two in sync and `hubctl doctor` reports drift. Only the `models` array is touched: the vendor and
// the key reference (${input:chat.lm.secret.…}) stay as they are.
//
// CHAT_LANGUAGE_MODELS overrides the user config path (tests, another profile).

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const CURATED = join(HERE, 'vscode-models.json');

function codeUserDir() {
  if (process.env.CHAT_LANGUAGE_MODELS) return dirname(process.env.CHAT_LANGUAGE_MODELS);
  if (process.platform === 'win32') return join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'Code', 'User');
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'Code', 'User');
  return join(homedir(), '.config', 'Code', 'User');
}

export function userConfigPath() {
  return process.env.CHAT_LANGUAGE_MODELS ?? join(codeUserDir(), 'chatLanguageModels.json');
}

export function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

/** Drift between one curated group and the user's group of the same vendor, or null when there is none. */
export function diffGroup(curatedGroup, userGroup) {
  if (!userGroup) return { missingGroup: true, name: curatedGroup.name, missing: [], extra: [], unknown: [] };
  const want = curatedGroup.models ?? [];
  const have = Array.isArray(userGroup.models) ? userGroup.models : [];
  return {
    missingGroup: false,
    name: curatedGroup.name,
    // No `models` at all means "every model the provider offers": report it as drift, not as empty.
    missing: want.filter((id) => !have.includes(id)),
    extra: have.filter((id) => !want.includes(id)),
    unknown: [],
  };
}

export function diffByok(curated, user) {
  if (!Array.isArray(curated?.groups)) return [];
  if (!Array.isArray(user)) return curated.groups.map((g) => diffGroup(g, null));
  return curated.groups.map((g) => diffGroup(g, user.find((u) => u.vendor === g.vendor && u.name === g.name) ?? null));
}

/** Rows for `hubctl doctor`: one per group, warn on drift, ok when in sync. */
export function checkByokModels(curated, user) {
  if (!curated) return [{ check: 'vscode', level: 'warn', detail: 'tools/vscode-models.json is missing or not valid JSON' }];
  const diffs = diffByok(curated, user);
  if (!user) return [{ check: 'vscode', level: 'ok', detail: `no VS Code BYOK config at ${userConfigPath()} (skipped)` }];
  return diffs.map((d) => {
    if (d.missingGroup) return { check: 'vscode', level: 'warn', detail: `BYOK group ${d.name} is not in the VS Code config` };
    const parts = [];
    if (d.missing.length) parts.push(`${d.missing.length} to add`);
    if (d.extra.length) parts.push(`${d.extra.length} not in the curated list`);
    if (!parts.length) return { check: 'vscode', level: 'ok', detail: `${d.name}: ${(curated.groups.find((g) => g.name === d.name)?.models ?? []).length} models match the curated list` };
    return { check: 'vscode', level: 'warn', detail: `BYOK ${d.name} drifted (${parts.join(', ')}); run node agent-hub/tools/vscode-models.mjs --apply` };
  });
}

async function onlineRetired(curated, { fetchImpl = fetch } = {}) {
  const retired = [];
  for (const group of curated.groups ?? []) {
    if (group.vendor !== 'openrouter') continue;
    let body;
    try {
      const res = await fetchImpl('https://openrouter.ai/api/v1/models');
      if (!res.ok) return { retired, note: `OpenRouter answered ${res.status}` };
      body = await res.json();
    } catch (error) {
      return { retired, note: `cannot reach OpenRouter: ${error.message}` };
    }
    const live = new Set((body.data ?? []).map((m) => m.id));
    for (const id of group.models ?? []) if (!live.has(id)) retired.push({ group: group.name, id });
    return { retired, note: null };
  }
  return { retired, note: null };
}

export function applyByok(curated, user) {
  if (!Array.isArray(user)) return { written: false, reason: 'no VS Code BYOK config to edit' };
  let changed = 0;
  for (const group of curated.groups ?? []) {
    const target = user.find((u) => u.vendor === group.vendor && u.name === group.name);
    if (!target) continue;
    const before = JSON.stringify(target.models ?? null);
    target.models = [...group.models];
    if (JSON.stringify(target.models) !== before) changed++;
  }
  return { written: changed > 0, groups: user.map((u) => `${u.name} (${(u.models ?? []).length})`), changed };
}

async function main() {
  const argv = process.argv.slice(2);
  const curated = readJson(CURATED);
  if (!curated) {
    process.stderr.write(`vscode-models: cannot read ${CURATED}\n`);
    process.exitCode = 1;
    return;
  }
  const path = userConfigPath();
  const user = readJson(path);

  if (argv.includes('--apply')) {
    const result = applyByok(curated, user);
    if (!result.written) {
      process.stdout.write(`${result.reason ?? 'already in sync'}\n`);
      return;
    }
    writeFileSync(path, `${JSON.stringify(user, null, 2)}\n`);
    process.stdout.write(`wrote ${path}: ${result.groups.join(' · ')}\n`);
    return;
  }

  const diffs = diffByok(curated, user ?? []);
  const online = argv.includes('--online') ? await onlineRetired(curated) : null;
  const report = { path, present: Boolean(user), diffs, online };
  if (argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else if (!user) {
    process.stdout.write(`no VS Code BYOK config at ${path} (nothing to check)\n`);
  } else {
    for (const d of diffs) {
      const state = d.missingGroup ? 'group missing'
        : !d.missing.length && !d.extra.length ? 'in sync'
          : `${d.missing.length} to add, ${d.extra.length} to drop`;
      process.stdout.write(`${d.name.padEnd(12)} ${state}\n`);
    }
    if (online?.note) process.stdout.write(`${online.note}\n`);
    for (const r of online?.retired ?? []) process.stdout.write(`retired at the provider: ${r.group} ${r.id}\n`);
  }

  const drift = diffs.some((d) => d.missingGroup || d.missing.length || d.extra.length) || (online?.retired.length ?? 0) > 0;
  process.exitCode = drift && argv.includes('--check') ? 1 : process.exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
