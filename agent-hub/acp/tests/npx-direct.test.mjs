import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { directCommand, npmCacheDir } from '../npx-direct.mjs';

function cacheWith(name, version, bin = { tool: 'dist/index.js' }) {
  const cacheDir = mkdtempSync(join(tmpdir(), 'hub-npx-'));
  const dir = join(cacheDir, '_npx', 'abc123', 'node_modules', ...name.split('/'));
  mkdirSync(join(dir, 'dist'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version, bin }));
  writeFileSync(join(dir, 'dist', 'index.js'), '');
  return { cacheDir, bin: join(dir, 'dist', 'index.js') };
}

test('a pinned, cached adapter runs with node instead of npx', (t) => {
  const { cacheDir, bin } = cacheWith('@scope/adapter', '2.6.0');
  t.after(() => rmSync(cacheDir, { recursive: true, force: true }));
  for (const npx of ['npx', 'npx.cmd', 'C:\\Program Files\\nodejs\\npx.cmd']) {
    assert.deepEqual(directCommand(npx, ['-y', '@scope/adapter@2.6.0', '--flag'], { cacheDir, env: {} }), {
      command: process.execPath,
      args: [bin, '--flag'],
    });
  }
});

test('anything that is not exactly that stays with npx', (t) => {
  const { cacheDir } = cacheWith('@scope/adapter', '2.6.0');
  t.after(() => rmSync(cacheDir, { recursive: true, force: true }));
  const not = (command, args, env = {}) => assert.equal(directCommand(command, args, { cacheDir, env }), null);
  not('npx', ['-y', '@scope/adapter@2.6.1']); // another version is cached
  not('npx', ['-y', '@scope/adapter@^2.6.0']); // a range
  not('npx', ['-y', '@scope/adapter@latest']); // a tag
  not('npx', ['-y', '@scope/adapter']); // unpinned
  not('npx', ['--package', 'x', '@scope/adapter@2.6.0']); // other npx flags
  not('opencode', ['acp']); // not npx
  not('npx', ['-y', '@scope/adapter@2.6.0'], { HUB_NO_NPX_SHORTCUT: '1' });
  assert.equal(directCommand('npx', ['-y', '@scope/adapter@2.6.0'], { cacheDir: join(cacheDir, 'missing'), env: {} }), null);
});

test('a bin that node cannot run is left to npx', (t) => {
  const { cacheDir } = cacheWith('native-tool', '1.0.0', { tool: 'dist/tool.exe' });
  t.after(() => rmSync(cacheDir, { recursive: true, force: true }));
  assert.equal(directCommand('npx', ['-y', 'native-tool@1.0.0'], { cacheDir, env: {} }), null);
});

test('the cache directory follows npm: override, then the platform default', () => {
  assert.equal(npmCacheDir({ npm_config_cache: '/x' }, 'linux'), '/x');
  assert.equal(npmCacheDir({ LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' }, 'win32'), join('C:\\Users\\u\\AppData\\Local', 'npm-cache'));
  assert.match(npmCacheDir({}, 'linux'), /\.npm$/);
});
