// live.mjs — what the hub is doing right now, from files and the OS.
//
// `status` answers "is the fleet healthy"; `live` answers "who is working,
// where, and is anything moving". It stays read-only and daemonless: the
// hub's own inflight files are the primary source, the OS process table
// covers agents started outside the hub, and fs.watch reports edits without
// running `git status` on a loop.
//
// Platform note: a process cannot see the other side of the WSL/Windows
// boundary. Hub runs are still visible from both sides because inflight is a
// file; only *external* agents are platform-local.

import { execFile } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, watch } from 'node:fs';
import { join, basename } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

const AGENT_RE = /opencode|codex|claude|hermes|hub-acp|hub-mcp|acp-client/i;
const WATCH_SKIP = /[\\/](\.git|node_modules|\.gradle|\.idea|build|dist|obj|bin|target|\.venv|venv)([\\/]|$)/i;

/** Locks written by acp/tree-lock.mjs while an allow-all run holds a tree. */
export function readLocks(locksDir, { now = Date.now() } = {}) {
  if (!existsSync(locksDir)) return [];
  const rows = [];
  for (const name of readdirSync(locksDir)) {
    if (!name.endsWith('.lock')) continue;
    let body = null;
    try { body = JSON.parse(readFileSync(join(locksDir, name), 'utf8')); } catch { continue; }
    if (!body || typeof body !== 'object') continue;
    let alive = null;
    if (Number.isInteger(body.pid)) {
      try { process.kill(body.pid, 0); alive = true; }
      catch (error) { alive = error.code === 'EPERM'; }
    }
    rows.push({
      cwd: body.cwd ?? null,
      agent: body.agent ?? null,
      pid: body.pid ?? null,
      alive,
      startedAt: body.startedAt ?? null,
      ageMs: Number.isFinite(body.startedAt) ? now - body.startedAt : null,
      path: join(locksDir, name),
    });
  }
  return rows.sort((a, b) => String(a.cwd).localeCompare(String(b.cwd)));
}

/** Processes that look like coding agents and were not necessarily started by the hub. */
export async function scanExternalProcesses() {
  if (process.platform === 'win32') {
    const script = [
      "$ErrorActionPreference='SilentlyContinue'",
      'Get-CimInstance Win32_Process',
      "| Where-Object { $_.CommandLine -match 'opencode|codex|claude|hermes|hub-acp|hub-mcp' }",
      '| Select-Object ProcessId,Name,CommandLine',
      '| ConvertTo-Json -Compress',
    ].join(' ');
    try {
      const { stdout } = await run('powershell.exe', ['-NoProfile', '-Command', script], {
        encoding: 'utf8', windowsHide: true, timeout: 5_000, maxBuffer: 4 * 1024 * 1024,
      });
      const parsed = JSON.parse(stdout || '[]');
      const list = Array.isArray(parsed) ? parsed : [parsed];
      return list
        .filter((row) => AGENT_RE.test(String(row.CommandLine ?? '')))
        .map((row) => ({
          pid: row.ProcessId,
          name: row.Name ?? '',
          cmd: String(row.CommandLine ?? '').replace(/\s+/g, ' ').slice(0, 160),
        }));
    } catch {
      return [];
    }
  }
  // Linux/WSL: /proc is cheap and already tells us the command line.
  const rows = [];
  let entries = [];
  try { entries = readdirSync('/proc'); } catch { return rows; }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const cmd = readFileSync(`/proc/${entry}/cmdline`, 'utf8').replace(/\0/g, ' ').trim();
      if (!cmd || !AGENT_RE.test(cmd)) continue;
      rows.push({ pid: Number(entry), name: basename(cmd.split(' ')[0]), cmd: cmd.slice(0, 160) });
    } catch {}
  }
  return rows;
}

/**
 * Watch the trees that hub runs are actually editing. Recursive fs.watch is
 * supported on Windows and modern Linux; when a path cannot be watched the
 * tree is reported as "not watched" instead of failing the command.
 */
export function watchTrees(paths) {
  const trees = new Map();
  for (const cwd of [...new Set(paths)].filter(Boolean)) {
    const state = { cwd, changes: 0, lastChange: null, watching: false };
    trees.set(cwd, state);
    try {
      const watcher = watch(cwd, { recursive: true }, (_event, filename) => {
        const name = String(filename ?? '');
        if (name && WATCH_SKIP.test(name)) return;
        state.changes += 1;
        state.lastChange = Date.now();
      });
      watcher.on('error', () => { state.watching = false; try { watcher.close(); } catch {} });
      watcher.unref?.();
      state.watcher = watcher;
      state.watching = true;
    } catch {
      state.watching = false;
    }
  }
  return trees;
}

export function snapshotTrees(trees, { now = Date.now() } = {}) {
  return [...trees.values()].map((tree) => ({
    cwd: tree.cwd,
    changes: tree.changes,
    watching: tree.watching,
    lastChangeMs: tree.lastChange == null ? null : now - tree.lastChange,
  }));
}

/** Assemble one frame; pure enough to test without touching the OS. */
export function buildLiveModel({
  status, locks = [], external = [], trees = [], now = Date.now(),
}) {
  const inflight = (status.inflight ?? []).map((row) => ({
    ...row,
    silentMs: row.silentMs ?? null,
    phase: row.stalled ? 'stalled?' : row.lastTool?.includes('(running)') ? 'tool' : 'prompt',
  }));
  return {
    now,
    platform: process.platform,
    inflight,
    locks,
    external,
    trees,
    runs: status.runs ?? [],
    services: {
      bridge: status.bridge?.up ?? null,
      memory: status.memory?.up ?? null,
      starnet: status.starnet?.up ?? null,
    },
  };
}

function ago(ms) {
  if (ms == null || !Number.isFinite(ms)) return '?';
  if (ms < 1_000) return `${Math.max(0, Math.round(ms))}ms`;
  if (ms < 60_000) return `${Math.round(ms / 1_000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  return `${Math.round(ms / 3_600_000)}h`;
}

function clip(value, width) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > width ? `${text.slice(0, width - 1)}…` : text;
}

export function renderLive(model, { color = true, width = 110 } = {}) {
  const paint = color
    ? {
        bold: (s) => `\x1b[1m${s}\x1b[0m`,
        dim: (s) => `\x1b[2m${s}\x1b[0m`,
        green: (s) => `\x1b[32m${s}\x1b[0m`,
        yellow: (s) => `\x1b[33m${s}\x1b[0m`,
      }
    : { bold: (s) => s, dim: (s) => s, green: (s) => s, yellow: (s) => s };

  const lines = [];
  const stamp = new Date(model.now).toISOString().replace('T', ' ').slice(0, 19);
  lines.push(`${paint.bold('AGENTHUB LIVE')} ${paint.dim(stamp)}${paint.dim(
    `  ·  ${model.platform === 'win32' ? 'Windows' : 'Linux/WSL'}  ·  read-only`,
  )}`);
  lines.push('');

  lines.push(paint.bold(`runs · ${model.inflight.length}`));
  if (!model.inflight.length) lines.push(paint.dim('  none'));
  for (const row of model.inflight) {
    const where = row.cwd ? basename(row.cwd) : '?';
    const silent = row.silentMs == null ? '?' : `${ago(row.silentMs)} silent`;
    const head = `  ${row.pid ?? '?'}  ${String(row.agent).padEnd(9)} ${clip(where, 28).padEnd(28)}`;
    const tail = `${row.stalled ? 'STALLED' : row.phase}  ${silent}  ${row.toolCount ?? 0} tools` +
      (row.model ? `  ${clip(row.model.split('/').pop(), 22)}` : '');
    lines.push(head + (row.stalled ? paint.yellow(tail) : tail));
    if (row.lastTool) lines.push(paint.dim(`       ${clip(row.lastTool, width - 8)}`));
  }
  lines.push('');

  lines.push(paint.bold(`trees · ${model.locks.length} locked`));
  if (!model.locks.length) lines.push(paint.dim('  none'));
  for (const lock of model.locks) {
    const state = lock.alive === false ? paint.yellow('stale?') : paint.green('held');
    lines.push(`  ${clip(lock.cwd, 52).padEnd(52)} ${lock.agent ?? '?'}(${lock.pid ?? '?'})  ${state}  ${ago(lock.ageMs)}`);
  }
  for (const tree of model.trees) {
    const activity = tree.lastChangeMs == null
      ? (tree.watching ? 'watching, no edits yet' : 'not watched')
      : `${tree.changes} change(s), last ${ago(tree.lastChangeMs)} ago`;
    lines.push(paint.dim(`  ${clip(tree.cwd, 52).padEnd(52)} ${activity}`));
  }
  lines.push('');

  lines.push(paint.bold(`external · ${model.external.length}`));
  if (!model.external.length) lines.push(paint.dim('  none from this side of the WSL/Windows boundary'));
  for (const row of model.external) {
    lines.push(`  ${String(row.pid).padEnd(7)} ${clip(row.name, 12).padEnd(12)} ${clip(row.cmd, width - 24)}`);
  }
  lines.push('');

  lines.push(paint.bold(`recent · ${model.runs.length}`));
  if (!model.runs.length) lines.push(paint.dim('  none'));
  for (const run of model.runs) {
    const seconds = run.durationMs == null ? '?' : (run.durationMs / 1000).toFixed(1);
    const head = `  ${String(run.time ?? '').slice(11, 19)}  ${String(run.agent).padEnd(9)} ${String(run.status).padEnd(8)} ${seconds}s`;
    lines.push((run.status === 'ok' ? paint.green(head) : paint.yellow(head)) +
      (run.model ? paint.dim(`  ${clip(run.model.split('/').pop(), 20)}`) : ''));
  }
  const services = Object.entries(model.services)
    .map(([name, up]) => `${name} ${up == null ? '?' : up ? 'up' : 'down'}`)
    .join('  ·  ');
  lines.push('', paint.dim(`services  ${services}`));
  return lines.join('\n');
}
