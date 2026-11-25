import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
// Spawned hub-acp runs write transcripts under the results dir: keep them out of the real one.
process.env.AGENT_HUB_RESULTS = mkdtempSync(join(tmpdir(), 'hub-results-'));

// A timeout has to mean "the callee stopped", not "the hub stopped listening".
// The fake agent can hold a turn open on purpose (HANG-ACK / HANG-IGNORE), so
// both outcomes are exercised without a model call:
//
//   HANG-ACK     ends the turn when session/cancel arrives  -> cancelAck true
//   HANG-IGNORE  never ends it                              -> cancelAck false,
//                and the error must say the tree may still change.
//
// Before this, hub-acp sent the cancel and killed the wrapper 1.5 s later
// without ever asking whether the turn had ended -- which is how a "finished"
// run went on editing one repo for ten minutes on 2026-11-03.

const HERE = dirname(fileURLToPath(import.meta.url));
const HUB_ACP = resolve(HERE, '..', 'hub-acp.mjs');
const FIXTURE = resolve(HERE, '..', '..', 'mcp', 'tests', 'fixtures', 'fake-acp-agent.mjs');

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'hub-acp-cancel-'));
  const paths = {
    dir,
    registry: join(dir, 'agents.json'),
    consent: join(dir, 'consent.json'),
    log: join(dir, 'runs.jsonl'),
    locks: join(dir, 'locks'),
    inflight: join(dir, 'inflight'),
    cwd: join(dir, 'tree'),
  };
  writeFileSync(
    paths.registry,
    JSON.stringify({ agents: { fake: { label: 'Fake', command: process.execPath, args: [FIXTURE] } } }),
  );
  writeFileSync(
    paths.consent,
    JSON.stringify({ fake: { enabled: true, overseerAck: true, expires: '2099-01-01T00:00:00Z' } }),
  );
  mkdirSync(paths.cwd, { recursive: true });
  return paths;
}

function argsFor(paths, prompt, timeoutMs = '1200') {
  return [
    HUB_ACP,
    '--agent',
    'fake',
    '--permission',
    'allow-all',
    '--prompt',
    prompt,
    '--cwd',
    paths.cwd,
    '--json',
    '--no-save',
    '--timeout',
    timeoutMs,
    '--registry',
    paths.registry,
  ];
}

const envFor = (paths) => ({
  ...process.env,
  AGENT_HUB_LOG: paths.log,
  AGENT_HUB_LOCKS: paths.locks,
  AGENT_HUB_INFLIGHT: paths.inflight,
  AGENT_HUB_CONSENT: paths.consent,
  HUB_CANCEL_WAIT_MS: '2500',
});

test('a cancelled turn that acknowledges the cancel is reported as clean', () => {
  const paths = sandbox();
  const result = spawnSync(process.execPath, argsFor(paths, 'HANG-ACK'), {
    encoding: 'utf8',
    timeout: 30_000,
    env: envFor(paths),
  });
  const body = JSON.parse(result.stdout);
  assert.equal(result.status, 2, 'timeout keeps exit code 2');
  assert.equal(body.status, 'timeout');
  assert.equal(body.cancelAck, true, 'the fake agent ended the turn on session/cancel');
  assert.match(body.error ?? '', /timed out/i);
  assert.doesNotMatch(body.error ?? '', /may still be changing/);
});

test('an unacknowledged cancel says the tree may still be changing', () => {
  const paths = sandbox();
  const result = spawnSync(process.execPath, argsFor(paths, 'HANG-IGNORE'), {
    encoding: 'utf8',
    timeout: 30_000,
    env: envFor(paths),
  });
  const body = JSON.parse(result.stdout);
  assert.equal(result.status, 2);
  assert.equal(body.cancelAck, false);
  assert.match(body.error, /session\/cancel was not acknowledged/);
  assert.match(body.error, /may still be changing/);
});

test('a running turn is visible in the inflight directory and cleaned up after', async () => {
  const paths = sandbox();
  const child = spawn(process.execPath, argsFor(paths, 'SLEEP:2500', '20000'), {
    stdio: 'ignore',
    env: envFor(paths),
  });

  // Poll instead of sleeping a fixed amount: the record appears once the
  // session exists, which is after initialize + session/new.
  let seen = null;
  for (let i = 0; i < 60 && !seen; i += 1) {
    if (existsSync(paths.inflight)) {
      const files = readdirSync(paths.inflight).filter((name) => name.endsWith('.json'));
      if (files.length) seen = readFileSync(join(paths.inflight, files[0]), 'utf8');
    }
    if (!seen) await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(seen, 'hub-acp wrote an inflight record while the turn was running');
  const record = JSON.parse(seen);
  assert.equal(record.agent, 'fake');
  assert.equal(record.cwd, paths.cwd);
  assert.equal(record.platform, process.platform);

  await new Promise((r) => child.on('close', r));
  const left = existsSync(paths.inflight)
    ? readdirSync(paths.inflight).filter((name) => name.endsWith('.json'))
    : [];
  assert.deepEqual(left, [], 'the record is removed when the run ends');
});

test('a finished run still writes exactly one audit line, with no cancel verdict', () => {
  const paths = sandbox();
  const result = spawnSync(process.execPath, argsFor(paths, 'hello', '20000'), {
    encoding: 'utf8',
    timeout: 30_000,
    env: envFor(paths),
  });
  const body = JSON.parse(result.stdout);
  assert.equal(body.status, 'ok');
  const lines = readFileSync(paths.log, 'utf8').trim().split('\n');
  assert.equal(lines.length, 1);
  const record = JSON.parse(lines[0]);
  assert.equal(record.status, 'ok');
  assert.equal(record.cancelAck, null, 'no cancel happened, so no cancellation verdict');
});

// A failure with write access leaves work behind, and the caller's next
// question is always "what did it touch?". The salvage record answers it
// instead of making someone reconstruct it from the transcript.

test('a failed write run records what it left in the tree', () => {
  const paths = sandbox();
  const git = (args) =>
    spawnSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.com', ...args], {
      cwd: paths.cwd,
      encoding: 'utf8',
    });
  assert.equal(git(['init', '-q']).status, 0);
  writeFileSync(join(paths.cwd, 'kept.txt'), 'before\n');
  assert.equal(git(['add', '.']).status, 0);
  assert.equal(git(['commit', '-qm', 'base']).status, 0);
  writeFileSync(join(paths.cwd, 'kept.txt'), 'edit a half-finished agent made\n');
  writeFileSync(join(paths.cwd, 'new-file.txt'), 'untracked\n');

  const args = argsFor(paths, 'QUOTA:unset break on purpose', '20000');
  args.splice(args.indexOf('--json') + 1, 0, '--permission', 'allow-all');
  const result = spawnSync(process.execPath, args, {
    encoding: 'utf8',
    timeout: 30_000,
    env: envFor(paths),
  });
  const body = JSON.parse(result.stdout);
  assert.equal(body.status, 'failed');
  assert.ok(body.salvage, 'the failure names a salvage file');
  const salvage = JSON.parse(readFileSync(body.salvage, 'utf8'));
  assert.equal(salvage.cwd, paths.cwd);
  assert.match(salvage.head, /^[0-9a-f]{7,}$/);
  assert.equal(salvage.dirtyCount, 2);
  assert.ok(salvage.dirty.some((line) => line.includes('kept.txt')));
  assert.ok(salvage.dirty.some((line) => line.includes('new-file.txt')));
});
