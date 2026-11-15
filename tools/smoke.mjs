#!/usr/bin/env node
// Exercise a clean local Git clone, using only the tracked working-tree files
// and a fake ACP agent. No installed provider, credentials or network needed.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { killTree } from '../acp/process-utils.mjs';

const REPO = fileURLToPath(new URL('../', import.meta.url));
const TIMEOUT_MS = 30000;

function run(command, args, { cwd, env, status = 0 } = {}) {
  const result = spawnSync(command, args, {
    cwd, env, encoding: 'utf8', timeout: TIMEOUT_MS,
    windowsHide: true, maxBuffer: 2 * 1024 * 1024,
  });
  assert.equal(result.status, status,
    `${command} ${args.join(' ')}: ${result.error?.message ?? ''}\n${result.stderr ?? ''}\n${result.stdout ?? ''}`);
  return result.stdout;
}
const json = (path) => JSON.parse(readFileSync(path, 'utf8'));
const files = (dir) => existsSync(dir) ? readdirSync(dir) : [];
async function withTimeout(promise, ms, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); }),
    ]);
  } finally { clearTimeout(timer); }
}

function isolatedEnvironment(root) {
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (name.startsWith('AGENT_HUB_') || name.startsWith('GIT_') || name.startsWith('FAKE_ACP_')) delete env[name];
  }
  // No inherited hooks, Git credentials, configuration includes or provider
  // refresh. HOME and the user's real configuration files are left untouched.
  env.GIT_CONFIG_GLOBAL = join(root, 'empty-gitconfig');
  writeFileSync(env.GIT_CONFIG_GLOBAL, '');
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.GIT_TERMINAL_PROMPT = '0';
  env.GIT_ALLOW_PROTOCOL = 'file';
  env.CHAT_LANGUAGE_MODELS = join(root, 'absent-models.json');
  env.CODEX_MODELS_CACHE = join(root, 'absent-codex-cache.json');
  env.AGENT_HUB_NO_REFRESH = '1';
  return env;
}

function cleanClone(root, env) {
  const source = join(root, 'snapshot');
  const workspace = join(root, 'fresh workspace');
  const clone = join(workspace, 'Renamed Agent Hub');
  mkdirSync(source); mkdirSync(workspace);
  // Copy tracked bytes from the working tree, not just HEAD: a local smoke
  // run must exercise staged/modified code while excluding ignored machine data.
  const tracked = run('git', ['ls-files', '-z'], { cwd: REPO, env }).split('\0').filter(Boolean);
  for (const name of tracked) {
    if (!existsSync(join(REPO, name))) continue;
    const to = join(source, name);
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(join(REPO, name), to);
  }
  run('git', ['init', '-q', '--initial-branch=main'], { cwd: source, env });
  run('git', ['add', '.'], { cwd: source, env });
  run('git', ['-c', 'user.name=Smoke Test', '-c', 'user.email=smoke@example.invalid', 'commit', '-qm', 'tracked snapshot'], { cwd: source, env });
  run('git', ['clone', '--quiet', '--no-local', source, clone], { cwd: root, env });
  return { workspace, clone };
}

async function mcpCall(command, args, { cwd, env, prompt }) {
  const child = spawn(command, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const closed = new Promise((resolve) => child.once('close', resolve));
  const pending = new Map();
  let sequence = 0, stderr = '', failure = null;
  const fail = (error) => {
    failure = error;
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
  };
  child.on('error', fail);
  child.stdin.on('error', fail);
  child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-8000); });
  const reader = createInterface({ input: child.stdout });
  reader.on('line', (line) => {
    try {
      const reply = JSON.parse(line);
      pending.get(reply.id)?.resolve(reply);
      pending.delete(reply.id);
    } catch (error) { fail(error); }
  });
  child.once('close', (code) => {
    if (pending.size) fail(new Error(`MCP closed with ${code}: ${stderr}`));
  });
  function request(method, params) {
    if (failure) return Promise.reject(failure);
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`MCP ${method} timed out: ${stderr}`));
      }, TIMEOUT_MS);
      pending.set(id, {
        resolve: (reply) => { clearTimeout(timer); resolve(reply); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }
  try {
    const init = await request('initialize', {
      protocolVersion: '2025-06-18', clientInfo: { name: 'fresh-clone-smoke', version: '1' },
    });
    assert.equal(init.result?.serverInfo?.name, 'agent-hub');
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    const catalogue = await request('tools/list', {});
    assert.ok(catalogue.result.tools.some((tool) => tool.name === 'ask_agent'));
    const answer = await request('tools/call', {
      name: 'ask_agent', arguments: { agent: 'smoke', prompt, permission: 'deny' },
    });
    assert.equal(answer.result?.isError, false, JSON.stringify(answer));
    assert.ok(answer.result.content.some((part) => part.text?.includes(`ECHO:${prompt}`)));
    child.stdin.end();
    const code = await withTimeout(closed, TIMEOUT_MS, 'MCP did not exit after EOF');
    assert.equal(code, 0, stderr);
  } finally {
    reader.close();
    if (child.exitCode === null && child.signalCode === null) {
      child.stdin.end();
      try {
        await withTimeout(closed, 18000, 'MCP cleanup timed out');
      } catch {
        killTree(child);
        await withTimeout(closed, 2000, 'MCP process did not exit after cleanup');
      }
    }
    for (const waiter of pending.values()) waiter.reject(new Error('smoke transport closed'));
  }
}

async function main() {
  const root = mkdtempSync(join(tmpdir(), 'hub-install-'));
  let stage = 'clean clone';
  try {
    const env = isolatedEnvironment(root);
    const { workspace, clone } = cleanClone(root, env);
    const cli = (args, status = 0) => run(process.execPath, ['hub.mjs', ...args], { cwd: clone, env, status });
    for (const name of ['consent.json', 'acp/agents.json', 'results']) assert.equal(existsSync(join(clone, name)), false);
    process.stdout.write('ok  cloned tracked files into a renamed path with spaces\n');

    stage = 'initialization';
    cli(['init', '--workspace', '--dry-run']);
    assert.equal(existsSync(join(clone, 'consent.json')), false);
    assert.equal(existsSync(join(workspace, '.mcp.json')), false);
    cli(['init', '--workspace']);
    const consentPath = join(clone, 'consent.json');
    const registryPath = join(clone, 'acp', 'agents.json');
    assert.ok(Object.entries(json(consentPath)).filter(([name]) => !name.startsWith('_')).every(([, grant]) => grant.enabled === false));
    assert.equal(run('git', ['config', '--get', 'core.hooksPath'], { cwd: clone, env }).trim(), '.githooks');
    const claude = json(join(workspace, '.mcp.json')).mcpServers['agent-hub'];
    const opencode = json(join(workspace, 'opencode.json')).mcp.servers['agent-hub'];
    assert.equal(claude.args[0], 'Renamed Agent Hub/mcp/server.mjs');
    assert.equal(opencode.command.at(-1), join(clone, 'mcp', 'server.mjs'));
    assert.equal(readFileSync(join(workspace, 'README.md'), 'utf8').includes('__HUB_DIR__'), false);
    process.stdout.write('ok  initialization keeps grants disabled and generates workspace launchers\n');

    stage = 'fake-only configuration and denial';
    writeFileSync(registryPath, JSON.stringify({ agents: { smoke: {
      command: process.execPath,
      args: [join(clone, 'mcp', 'tests', 'fixtures', 'fake-acp-agent.mjs')],
      defaultConfig: { model: 'smoke/model' },
    } } }));
    const grant = { enabled: false, overseerAck: false, expires: '2099-01-01', limits: { maxPermission: 'deny', writeTrees: [], maxBudgetUsd: 1 } };
    writeFileSync(consentPath, JSON.stringify({ smoke: grant }));
    const disabled = JSON.parse(cli(['ask', 'smoke', 'SMOKE_DISABLED', '--json', '--permission', 'deny'], 1));
    assert.equal(disabled.status, 'denied');
    grant.enabled = true; grant.overseerAck = true;
    writeFileSync(consentPath, JSON.stringify({ smoke: grant }));
    const forbidden = JSON.parse(cli(['ask', 'smoke', 'SMOKE_FORBIDDEN', '--json', '--permission', 'allow-all'], 1));
    assert.equal(forbidden.status, 'denied');
    const before = [readFileSync(consentPath, 'utf8'), readFileSync(registryPath, 'utf8')];
    cli(['init', '--workspace']);
    assert.deepEqual([readFileSync(consentPath, 'utf8'), readFileSync(registryPath, 'utf8')], before);
    assert.equal(JSON.parse(cli(['doctor', '--fast', '--json'])).ok, true);
    process.stdout.write('ok  disabled and excessive-permission requests are denied; re-init preserves config\n');

    stage = 'CLI delegation';
    const answer = JSON.parse(cli(['ask', 'smoke', 'SMOKE_CLI', '--json', '--permission', 'deny']));
    assert.equal(answer.ok, true);
    assert.match(answer.text, /ECHO:SMOKE_CLI/);
    assert.equal(dirname(answer.savedTo), join(clone, 'results'));
    assert.ok(readFileSync(answer.savedTo, 'utf8').includes('SMOKE_CLI'));
    process.stdout.write('ok  CLI delegates to the fake agent and saves its answer\n');

    stage = 'generated Claude MCP launcher';
    await mcpCall(claude.command, claude.args, { cwd: workspace, env, prompt: 'SMOKE_CLAUDE_MCP' });
    stage = 'generated OpenCode MCP launcher';
    await mcpCall(opencode.command[0], opencode.command.slice(1), { cwd: workspace, env, prompt: 'SMOKE_OPENCODE_MCP' });
    process.stdout.write('ok  both generated launchers complete MCP delegation and graceful EOF\n');

    stage = 'audit and cleanup';
    const records = readFileSync(join(workspace, 'projects', 'logs', 'runs.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.deepEqual(records.map((record) => record.status), ['denied', 'denied', 'ok', 'ok', 'ok']);
    assert.ok(records.every((record) => record.agent === 'smoke'));
    assert.deepEqual(records.slice(2).map((record) => record.prompt), ['SMOKE_CLI', 'SMOKE_CLAUDE_MCP', 'SMOKE_OPENCODE_MCP']);
    for (const name of ['inflight', 'locks']) assert.deepEqual(files(join(clone, 'results', name)), []);
    assert.equal(run('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: clone, env }).trim(), '');
    process.stdout.write('ok  five attempts audited once, no live records/locks, clone stays clean\n');
  } catch (error) {
    throw new Error(`${stage}: ${error.message}`, { cause: error });
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  }
}

main().catch((error) => {
  process.stderr.write(`FAIL fresh-clone smoke: ${error.message}\n`);
  process.exitCode = 1;
});
