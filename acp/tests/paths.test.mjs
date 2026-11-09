import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, styleOf, toWsl, toWindows, translate } from '../paths.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ACP = resolve(HERE, '..');
const HUB = resolve(ACP, '..');

const UNC = String.raw`\\wsl.localhost\Ubuntu\home\user\project`;

// ── detection ───────────────────────────────────────────────────────────────

test('recognises every spelling this machine actually produces', () => {
  assert.equal(styleOf(String.raw`D:\Workspaces\AgentHub`), 'windows-drive');
  assert.equal(styleOf('D:/Workspaces/AgentHub'), 'windows-drive');
  assert.equal(styleOf(UNC), 'windows-unc-wsl');
  assert.equal(styleOf(String.raw`\\wsl$\Ubuntu\home\user`), 'windows-unc-wsl');
  assert.equal(styleOf('/mnt/d/Workspaces/AgentHub'), 'wsl-mount');
  assert.equal(styleOf('/home/user/x'), 'posix');
});

test('a relative path is a programming error, not a value to guess at', () => {
  assert.throws(() => styleOf('agent-hub/acp'), /absolute/);
  assert.throws(() => styleOf(''), /non-empty/);
  assert.throws(() => styleOf(undefined), /non-empty/);
});

// ── Windows -> WSL ──────────────────────────────────────────────────────────

test('a drive path becomes a /mnt mount, case-insensitively on the drive', () => {
  assert.equal(toWsl(String.raw`D:\Workspaces\AgentHub`), '/mnt/d/Workspaces/AgentHub');
  assert.equal(toWsl(String.raw`c:\Users\user`), '/mnt/c/Users/user');
  assert.equal(toWsl('D:/Workspaces/AgentHub/agent-hub'), '/mnt/d/Workspaces/AgentHub/agent-hub');
  assert.equal(toWsl('D:\\Workspaces\\AgentHub\\'), '/mnt/d/Workspaces/AgentHub');
});

test('a bare drive root maps to the mount root', () => {
  assert.equal(toWsl('D:'), '/mnt/d');
  assert.equal(toWsl('D:\\'), '/mnt/d');
});

test('the WSL share becomes the real POSIX path', () => {
  assert.equal(toWsl(UNC), '/home/user/project');
  assert.equal(toWsl(String.raw`\\wsl.localhost\Ubuntu`), '/');
  assert.equal(toWsl(String.raw`\\wsl$\Ubuntu\home\user\x`), '/home/user/x');
});

test('a WSL path is left alone, trailing slash included', () => {
  assert.equal(toWsl('/mnt/d/Workspaces/AgentHub'), '/mnt/d/Workspaces/AgentHub');
  assert.equal(toWsl('/mnt/d/Workspaces/AgentHub/'), '/mnt/d/Workspaces/AgentHub');
  assert.equal(toWsl('/home/user/x'), '/home/user/x');
});

// ── WSL -> Windows ──────────────────────────────────────────────────────────

test('a /mnt path becomes a drive path with backslashes', () => {
  assert.equal(toWindows('/mnt/d/Workspaces/AgentHub'), String.raw`D:\Workspaces\AgentHub`);
  assert.equal(toWindows('/mnt/d/Workspaces/AgentHub/agent-hub'), String.raw`D:\Workspaces\AgentHub\agent-hub`);
  assert.equal(toWindows('/mnt/c'), 'C:\\');
});

test('a path outside /mnt goes through the WSL share', () => {
  assert.equal(toWindows('/home/user/x'), UNC.replace(/project$/, 'x'));
  assert.equal(toWindows('/home/user/x', { distro: 'Debian' }), String.raw`\\wsl.localhost\Debian\home\user\x`);
});

test('a Windows path is left alone in either direction', () => {
  assert.equal(toWindows(String.raw`D:\Workspaces\AgentHub`), String.raw`D:\Workspaces\AgentHub`);
  assert.equal(toWindows(UNC), UNC);
});

// ── round trips ─────────────────────────────────────────────────────────────

test('a drive path survives Windows -> WSL -> Windows', () => {
  for (const original of [
    String.raw`D:\Workspaces\AgentHub`,
    String.raw`C:\Users\user\AppData\Local\StarNet`,
    String.raw`D:\Workspaces\someone\Interneto\interneto-website`,
  ]) {
    assert.equal(toWindows(toWsl(original)), original);
  }
});

test('a POSIX path survives WSL -> Windows -> WSL', () => {
  for (const original of ['/mnt/d/Workspaces/AgentHub', '/home/user/.opencode/bin/opencode', '/']) {
    assert.equal(toWsl(toWindows(original)), original);
  }
});

test('the same file has exactly two stable names', () => {
  const wsl = toWsl(String.raw`D:\Workspaces\AgentHub\agent-hub\mcp\server.mjs`);
  assert.equal(wsl, '/mnt/d/Workspaces/AgentHub/agent-hub/mcp/server.mjs');
  assert.equal(toWsl(wsl), wsl);
  assert.equal(toWindows(wsl), String.raw`D:\Workspaces\AgentHub\agent-hub\mcp\server.mjs`);
});

// ── target selection ────────────────────────────────────────────────────────

test('native follows the platform the code is running on', () => {
  const expected = process.platform === 'win32' ? String.raw`D:\x` : '/mnt/d/x';
  assert.equal(translate('/mnt/d/x', 'native'), expected);
});

test('an unknown target is refused instead of silently passed through', () => {
  assert.throws(() => translate('/mnt/d/x', 'darwin'), /unknown target/);
});

test('describe reports both spellings for the CLI', () => {
  const out = describe('/mnt/d/Workspaces/AgentHub');
  assert.equal(out.style, 'wsl-mount');
  assert.equal(out.wsl, '/mnt/d/Workspaces/AgentHub');
  assert.equal(out.windows, String.raw`D:\Workspaces\AgentHub`);
});

// ── the boundary rule ───────────────────────────────────────────────────────

// The point of this module is that nobody else re-implements it. A stray
// `p.replace(/^([A-Za-z]):/, ...)` is how the two spellings drift apart again.
function mjsFiles(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.git' || entry === 'results') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === 'tests') continue;
      mjsFiles(full, out);
    } else if (entry.endsWith('.mjs')) {
      out.push(full);
    }
  }
  return out;
}

test('no module outside paths.mjs re-implements drive-letter translation', () => {
  const offenders = [];
  for (const file of mjsFiles(HUB)) {
    if (file.endsWith('paths.mjs')) continue;
    const source = readFileSync(file, 'utf8');
    // The two shapes that only paths.mjs is allowed to know about.
    if (/\[\s*A-Za-z\s*\]\s*\)\s*:\s*[\\/]/.test(source) || /\/mnt\/\$\{/.test(source)) {
      offenders.push(file.replace(HUB, 'agent-hub'));
    }
  }
  assert.deepEqual(offenders, [], `translate paths through acp/paths.mjs, not inline: ${offenders.join(', ')}`);
});
