import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
// Spawned hub-acp runs write transcripts under the results dir: keep them out of the real one.
process.env.AGENT_HUB_RESULTS = mkdtempSync(join(tmpdir(), 'hub-results-'));

const here = dirname(fileURLToPath(import.meta.url));
const hub = resolve(here, '../hub-acp.mjs');
const fixture = resolve(here, '../../mcp/tests/fixtures/fake-acp-agent.mjs');

function run(mode, extra = [], previousMode = undefined, requestMode = true, defaultMode = undefined, options = {}) {
  const { permission = 'allow-all', permissionModes } = options;
  const dir = mkdtempSync(join(tmpdir(), 'hub-mode-'));
  const cwd = join(dir, 'tree');
  const registry = join(dir, 'registry.json');
  const consent = join(dir, 'consent.json');
  const log = join(dir, 'runs.jsonl');
  const marker = join(dir, 'prompt');
  mkdirSync(cwd);
  writeFileSync(registry, JSON.stringify({ agents: { fake: { command: process.execPath, args: [fixture],
    ...(defaultMode ? { defaultConfig: { mode: defaultMode } } : {}),
    ...(permissionModes ? { permissionModes } : {}) } } }));
  writeFileSync(consent, JSON.stringify({ fake: { enabled: true, overseerAck: true, expires: '2099-01-01T00:00:00Z' } }));
  if (previousMode !== undefined) {
    writeFileSync(log, JSON.stringify({ agent: 'fake', sessionId: 'fake-session-1', cwd,
      status: 'ok', requestedMode: previousMode }) + '\n');
  }
  const result = spawnSync(process.execPath, [
    hub, '--agent', 'fake', '--prompt', 'ping', '--permission', permission,
    '--cwd', cwd, '--registry', registry, '--json', '--no-save',
    ...(requestMode ? ['--config', 'mode=plan'] : []), ...extra,
  ], { encoding: 'utf8', env: { ...process.env, FAKE_MODE: mode, FAKE_PROMPT_MARKER: marker,
    AGENT_HUB_CONSENT: consent, AGENT_HUB_LOG: log, AGENT_HUB_LOCKS: join(dir, 'locks'),
    FAKE_ACP_CAPS: 'resume', HUB_CANCEL_WAIT_MS: '500' } });
  return { result, marker: existsSync(marker), record: JSON.parse(readFileSync(log, 'utf8').trim().split('\n').at(-1)) };
}

test('resume restores the last requested mode, while explicit mode wins', () => {
  const resumed = run('ok', ['--resume', 'fake-session-1'], 'read-only', false);
  assert.equal(resumed.result.status, 0, resumed.result.stderr);
  assert.equal(resumed.record.requestedMode, 'read-only');
  assert.equal(resumed.record.reportedMode, 'read-only');
  assert.equal(resumed.record.modeSource, 'restored');
  assert.equal(JSON.parse(resumed.result.stdout).modeSource, 'restored');
  assert.match(resumed.result.stderr, /restoring last requested mode: read-only/);

  const override = run('ok', ['--resume', 'fake-session-1'], 'read-only');
  assert.equal(override.result.status, 0, override.result.stderr);
  assert.equal(override.record.requestedMode, 'plan');
  assert.equal(override.record.modeSource, 'explicit');
  assert.doesNotMatch(override.result.stderr, /restoring last requested mode/);

  const missing = run('missing', ['--resume', 'fake-session-1'], 'read-only', false);
  assert.equal(missing.result.status, 1);
  assert.equal(missing.marker, false);
  assert.match(missing.record.error, /not confirmed/);
});

test('registry default is identified separately and explicit mode overrides it', () => {
  const fromRegistry = run('ok', [], undefined, false, 'build');
  assert.equal(fromRegistry.result.status, 0, fromRegistry.result.stderr);
  assert.equal(fromRegistry.record.requestedMode, 'build');
  assert.equal(fromRegistry.record.modeSource, 'registry');
  const explicit = run('ok', [], undefined, true, 'build');
  assert.equal(explicit.record.requestedMode, 'plan');
  assert.equal(explicit.record.modeSource, 'explicit');
});

test('ask runs the adapter attended mode, without restoring the previous one', () => {
  const permissionModes = { attended: { force: 'acceptEdits', allow: ['default', 'acceptEdits', 'plan'] } };
  const attended = run('ok', ['--resume', 'fake-session-1'], 'read-only', false, undefined,
    { permission: 'ask', permissionModes });
  assert.equal(attended.result.status, 0, attended.result.stderr);
  assert.equal(attended.record.requestedMode, 'acceptEdits');
  assert.equal(attended.record.reportedMode, 'acceptEdits');
  assert.equal(attended.record.modeSource, 'attended');
  assert.equal(JSON.parse(attended.result.stdout).modeSource, 'attended');
  assert.doesNotMatch(attended.result.stderr, /restoring last requested mode/);
});

test('ask attended mode replaces a registry default, while an explicit mode wins', () => {
  const permissionModes = { attended: { force: 'acceptEdits', allow: ['default', 'acceptEdits', 'plan'] } };
  const fromRegistry = run('ok', [], undefined, false, 'build', { permission: 'ask', permissionModes });
  assert.equal(fromRegistry.result.status, 0, fromRegistry.result.stderr);
  assert.equal(fromRegistry.record.requestedMode, 'acceptEdits');
  assert.equal(fromRegistry.record.modeSource, 'attended');

  const explicit = run('ok', [], undefined, true, 'build', { permission: 'ask', permissionModes });
  assert.equal(explicit.result.status, 0, explicit.result.stderr);
  assert.equal(explicit.record.requestedMode, 'plan');
  assert.equal(explicit.record.modeSource, 'explicit');
});

test('ask without a declared attended mode keeps the previous behaviour', () => {
  const { result, record } = run('ok', [], undefined, false, undefined, { permission: 'ask' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(record.requestedMode, null);
  assert.equal(record.modeSource, null);
});

test('ask still fails when the adapter does not confirm the attended mode', () => {
  const permissionModes = { attended: { force: 'acceptEdits', allow: ['default', 'acceptEdits', 'plan'] } };
  const { result, marker, record } = run('mismatch', [], undefined, false, undefined,
    { permission: 'ask', permissionModes });
  assert.equal(result.status, 1, result.stderr);
  assert.equal(marker, false);
  assert.equal(record.requestedMode, 'acceptEdits');
  assert.match(record.error, /not confirmed/);
});

test('requested mode must be explicitly reported before the prompt', () => {
  for (const mode of ['missing', 'mismatch']) {
    const { result, marker, record } = run(mode);
    assert.equal(result.status, 1, result.stderr);
    assert.equal(marker, false);
    assert.equal(record.requestedMode, 'plan');
    assert.match(record.error, /not confirmed/);
  }
});

test('confirmed mode permits a turn, including resumed sessions', () => {
  for (const extra of [[], ['--resume', 'fake-session-1']]) {
    const { result, marker, record } = run('ok', extra);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(marker, true);
    assert.equal(record.requestedMode, 'plan');
    assert.equal(record.reportedMode, 'plan');
  }
});

test('a reported mode change during a turn fails the run', () => {
  const { result, marker, record } = run('drift');
  assert.equal(result.status, 1, result.stderr);
  assert.equal(marker, true);
  assert.equal(record.modeChanged, true);
  assert.equal(record.reportedMode, 'build');
  assert.match(record.error, /cancellation acknowledged/);
  assert.equal(record.cancelAck, true);
});

test('an agent that ignores cancellation is stopped after a bounded wait', () => {
  const start = Date.now();
  const { result, record } = run('drift-ignore', ['--timeout', '30000']);
  assert.equal(result.status, 1, result.stderr);
  assert.equal(record.cancelAck, false);
  assert.match(record.error, /not acknowledged/);
  assert.ok(Date.now() - start < 10000, 'must not wait for the prompt timeout');
});

test('probe stdout stays JSON when the agent sends a resume message', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hub-probe-'));
  const cwd = join(dir, 'tree');
  const registry = join(dir, 'registry.json');
  const consent = join(dir, 'consent.json');
  mkdirSync(cwd);
  writeFileSync(registry, JSON.stringify({ agents: { fake: { command: process.execPath, args: [fixture] } } }));
  writeFileSync(consent, JSON.stringify({ fake: { enabled: true, overseerAck: true, expires: '2099-01-01T00:00:00Z' } }));
  const result = spawnSync(process.execPath, [
    hub, '--agent', 'fake', '--permission', 'allow-all', '--cwd', cwd,
    '--registry', registry, '--probe', '--resume', 'fake-session-1',
  ], { encoding: 'utf8', env: { ...process.env, FAKE_ACP_CAPS: 'resume',
    FAKE_RESUME_MESSAGE: 'yes', AGENT_HUB_CONSENT: consent,
    AGENT_HUB_LOG: join(dir, 'runs.jsonl'), AGENT_HUB_LOCKS: join(dir, 'locks') } });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).sessionMode, 'resume');
  assert.match(result.stderr, /resume warning/);
});

test('resume reports an unrequested native mode rather than assuming the previous mode', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hub-mode-observe-'));
  const cwd = join(dir, 'tree');
  const registry = join(dir, 'registry.json');
  const consent = join(dir, 'consent.json');
  const log = join(dir, 'runs.jsonl');
  mkdirSync(cwd);
  writeFileSync(registry, JSON.stringify({ agents: { fake: { command: process.execPath, args: [fixture] } } }));
  writeFileSync(consent, JSON.stringify({ fake: { enabled: true, overseerAck: true, expires: '2099-01-01T00:00:00Z' } }));
  const result = spawnSync(process.execPath, [
    hub, '--agent', 'fake', '--permission', 'allow-all', '--cwd', cwd, '--registry', registry,
    '--resume', 'fake-session-1', '--prompt', 'ping', '--json', '--no-save',
  ], { encoding: 'utf8', env: { ...process.env, FAKE_ACP_CAPS: 'resume', FAKE_RESUME_MODE: 'agent',
    AGENT_HUB_CONSENT: consent, AGENT_HUB_LOG: log, AGENT_HUB_LOCKS: join(dir, 'locks') } });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.requestedMode, null);
  assert.equal(output.reportedMode, 'agent');
  assert.match(result.stderr, /no mode requested; agent reported: agent/);
  assert.equal(JSON.parse(readFileSync(log, 'utf8').trim()).reportedMode, 'agent');
});
