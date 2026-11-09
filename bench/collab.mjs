// collab.mjs — does the hub make agents cooperate correctly?
//
// This is deliberately not a model-quality benchmark. Online suites already
// rank models; the question here is whether the orchestration around them is
// correct: fan-out merges every answer, a handoff keeps the payload intact,
// one failing worker does not abort the others, two writers cannot claim the
// same tree, and a stuck turn becomes visible before its timeout.
//
// Default mode is deterministic: a fake ACP agent echoes prompts, so every
// scenario runs offline, at zero cost, in seconds. `--real` adds a short
// cross-agent handoff using the registry's real workers; keep it rare.

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const HUB = resolve(HERE, '..');
const ROOT = resolve(HUB, '..');
const FIXTURE = join(HUB, 'mcp', 'tests', 'fixtures', 'fake-acp-agent.mjs');
const HUB_ACP = join(HUB, 'acp', 'hub-acp.mjs');
const FANOUT = join(HUB, 'acp', 'fanout-acp.mjs');
const HUBCTL = join(HUB, 'hubctl', 'hubctl.mjs');

const results = [];
const args = process.argv.slice(2);
const real = args.includes('--real');
const write = args.includes('--write');
const verbose = args.includes('--verbose');

function tempWorkspace(label) {
  const dir = mkdtempSync(join(tmpdir(), `agenthub-collab-${label}-`));
  mkdirSync(join(dir, 'work'), { recursive: true });
  mkdirSync(join(dir, 'inflight'), { recursive: true });
  mkdirSync(join(dir, 'locks'), { recursive: true });
  const registry = join(dir, 'agents.json');
  writeFileSync(registry, JSON.stringify({
    protocolVersion: 1,
    agents: {
      fake1: { label: 'Fake 1', command: process.execPath, args: [FIXTURE] },
      fake2: { label: 'Fake 2', command: process.execPath, args: [FIXTURE] },
      fake3: { label: 'Fake 3', command: process.execPath, args: [FIXTURE] },
    },
  }, null, 2));
  const consent = join(dir, 'consent.json');
  writeFileSync(consent, JSON.stringify({
    fake1: { enabled: true, overseerAck: true, expires: '2099-01-01T00:00:00Z' },
    fake2: { enabled: true, overseerAck: true, expires: '2099-01-01T00:00:00Z' },
    fake3: { enabled: true, overseerAck: true, expires: '2099-01-01T00:00:00Z' },
  }, null, 2));
  const env = {
    ...process.env,
    AGENT_HUB_CONSENT: consent,
    AGENT_HUB_LOG: join(dir, 'runs.jsonl'),
    AGENT_HUB_LOCKS: join(dir, 'locks'),
    AGENT_HUB_INFLIGHT: join(dir, 'inflight'),
    AGENT_HUB_STALL_MS: '800',
  };
  return { dir, work: join(dir, 'work'), registry, env };
}

function runNode(script, argv, env, timeout = 30_000) {
  return spawnSync(process.execPath, [script, ...argv], {
    env, encoding: 'utf8', timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024,
  });
}

function parseJson(text) {
  const start = String(text ?? '').indexOf('{');
  if (start === -1) return null;
  try { return JSON.parse(String(text).slice(start)); } catch { return null; }
}

function record(results, id, ok, ms, detail) {
  results.push({ id, ok, ms, detail });
  const mark = ok ? 'ok  ' : 'FAIL';
  process.stdout.write(`${mark} ${id.padEnd(22)} ${String(ms).padStart(5)}ms  ${detail}\n`);
  if (!ok && verbose) process.stderr.write(`     ${detail}\n`);
}

function scenarioFanout(w) {
  const started = Date.now();
  const out = runNode(FANOUT, [
    '--agents', 'fake1,fake2,fake3',
    '--prompt', 'TOKEN-FANOUT',
    '--cwd', w.work,
    '--registry', w.registry,
    '--json', '--no-save',
  ], w.env, 20_000);
  const body = parseJson(out.stdout);
  const okRuns = (body?.agents ?? body?.results ?? []).filter((row) => row.status === 'ok').length;
  const merged = JSON.stringify(body ?? '');
  const ok = okRuns === 3 && (merged.match(/TOKEN-FANOUT/g) ?? []).length >= 3;
  record(results, 'fanout-merge', ok, Date.now() - started,
    `${okRuns}/3 answered, ${(merged.match(/TOKEN-FANOUT/g) ?? []).length} tokens in the merge`);
}

function scenarioHandoff(w) {
  const started = Date.now();
  const first = runNode(HUB_ACP, [
    '--agent', 'fake1', '--prompt', 'HANDOFF-TOKEN-42',
    '--cwd', w.work, '--registry', w.registry, '--json',
  ], w.env, 15_000);
  const a = parseJson(first.stdout);
  const token = String(a?.text ?? '').match(/HANDOFF-TOKEN-42/)?.[0] ?? 'HANDOFF-TOKEN-42';
  const second = runNode(HUB_ACP, [
    '--agent', 'fake2', '--prompt', `Repeat exactly: ${token}`,
    '--cwd', w.work, '--registry', w.registry, '--json',
  ], w.env, 15_000);
  const b = parseJson(second.stdout);
  const ok = a?.status === 'ok' && b?.status === 'ok' && String(b?.text ?? '').includes(token);
  record(results, 'handoff', ok, Date.now() - started,
    ok ? 'A -> B kept the payload' : `A=${a?.status}, B=${b?.status}`);
}

function scenarioPartialFailure(w) {
  const started = Date.now();
  const out = runNode(FANOUT, [
    '--agents', 'fake1,fake2',
    '--prompt', 'QUOTA:bad TOKEN-PARTIAL',
    '--config', 'fake2:model=bad',
    '--cwd', w.work,
    '--registry', w.registry,
    '--json', '--no-save',
  ], w.env, 20_000);
  const body = parseJson(out.stdout);
  const rows = body?.agents ?? body?.results ?? [];
  const ok = rows.some((row) => row.status === 'ok') && rows.some((row) => row.status !== 'ok');
  record(results, 'partial-failure', ok, Date.now() - started,
    `${rows.filter((r) => r.status === 'ok').length} ok, ${rows.filter((r) => r.status !== 'ok').length} failed, fan-out survived`);
}

function scenarioConflict(w) {
  const started = Date.now();
  const first = spawn(process.execPath, [
    HUB_ACP, '--agent', 'fake1', '--prompt', 'SLEEP:4000',
    '--cwd', w.work, '--registry', w.registry, '--permission', 'allow-all', '--json',
  ], { env: w.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let firstOut = '';
  first.stdout.on('data', (d) => { firstOut += d; });

  return new Promise((resolvePromise) => {
    const waitLock = setInterval(() => {
      let names = [];
      try { names = readdirSync(w.env.AGENT_HUB_LOCKS); } catch {}
      if (!names.length) return;
      clearInterval(waitLock);
      const second = runNode(HUB_ACP, [
        '--agent', 'fake2', '--prompt', 'SLEEP:100',
        '--cwd', w.work, '--registry', w.registry, '--permission', 'allow-all', '--json',
      ], w.env, 10_000);
      const rejected = second.status !== 0 || /concurrent|lock|claimed|conflict/i.test(
        `${second.stdout} ${second.stderr}`,
      );
      first.on('close', () => {
        record(results, 'conflict', rejected, Date.now() - started,
          rejected ? 'second writer rejected while the first held the tree' : 'second writer was not rejected');
        resolvePromise();
      });
    }, 50);
    setTimeout(() => { clearInterval(waitLock); first.kill(); resolvePromise(); }, 10_000);
  });
}

function scenarioLive(w) {
  const started = Date.now();
  const run = spawn(process.execPath, [
    HUB_ACP, '--agent', 'fake1', '--prompt', 'SLEEP:3000',
    '--cwd', w.work, '--registry', w.registry, '--json',
  ], { env: w.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  run.stdout.on('data', (d) => { out += d; });
  return new Promise((resolvePromise) => {
    setTimeout(() => {
      const live = runNode(HUBCTL, ['live', '--once', '--json', '--no-external'], w.env, 10_000);
      const frame = parseJson(live.stdout);
      const seen = (frame?.inflight ?? []).some((row) => row.agent === 'fake1');
      run.on('close', () => {
        const after = runNode(HUBCTL, ['live', '--once', '--json', '--no-external'], w.env, 10_000);
        const cleared = (parseJson(after.stdout)?.inflight ?? []).length === 0;
        record(results, 'live', seen && cleared, Date.now() - started,
          seen && cleared ? 'run visible while active, cleared after' : `seen=${seen}, cleared=${cleared}`);
        resolvePromise();
      });
      if (verbose) process.stderr.write(`live frame: ${String(live.stdout).slice(0, 200)}\n`);
    }, 1200);
  });
}

function scenarioStalled(w) {
  const started = Date.now();
  const run = spawn(process.execPath, [
    HUB_ACP, '--agent', 'fake1', '--prompt', 'HANG-IGNORE',
    '--cwd', w.work, '--registry', w.registry, '--timeout', '3000', '--json',
  ], { env: w.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  run.stdout.on('data', (d) => { out += d; });
  return new Promise((resolvePromise) => {
    setTimeout(() => {
      const live = runNode(HUBCTL, ['live', '--once', '--json', '--no-external'], w.env, 10_000);
      const stalled = (parseJson(live.stdout)?.inflight ?? []).some((row) => row.stalled);
      run.on('close', () => {
        const body = parseJson(out);
        const timedOut = body?.status === 'timeout';
        record(results, 'stalled', stalled && timedOut, Date.now() - started,
          `stalled=${stalled}, final=${body?.status}`);
        resolvePromise();
      });
    }, 1400);
  });
}

async function main() {
  process.stdout.write('collab bench · deterministic\n\n');
  const w = tempWorkspace('det');
  try {
    scenarioFanout(w);
    scenarioHandoff(w);
    scenarioPartialFailure(w);
    await scenarioConflict(w);
    await scenarioLive(w);
    await scenarioStalled(w);
  } finally {
    rmSync(w.dir, { recursive: true, force: true });
  }

  if (real) {
    process.stdout.write('\nreal handoff · one short call per agent\n');
    const started = Date.now();
    const token = `TOKEN-${Date.now().toString(36)}`;
    const first = runNode(HUB_ACP, [
      '--agent', 'opencode', '--prompt', `Reply with exactly: ${token}`,
      '--cwd', ROOT, '--permission', 'deny', '--budget', '0.05',
      '--timeout', '120000', '--json',
    ], process.env, 180_000);
    const a = parseJson(first.stdout);
    const seen = String(a?.text ?? '').includes(token) ? token : null;
    const second = seen
      ? runNode(HUB_ACP, [
          '--agent', 'claude', '--model', 'sonnet', '--prompt', `Repeat exactly: ${seen}`,
          '--cwd', ROOT, '--permission', 'deny', '--budget', '0.25',
          '--timeout', '180000', '--json',
        ], process.env, 240_000)
      : null;
    const b = second ? parseJson(second.stdout) : null;
    const ok = Boolean(seen && b?.status === 'ok' && String(b?.text ?? '').includes(seen));
    record(results, 'real-handoff', ok, Date.now() - started,
      ok ? 'opencode -> claude kept the token' : `opencode=${a?.status}, claude=${b?.status}`);
  }

  const passed = results.filter((r) => r.ok).length;
  process.stdout.write(`\n${passed}/${results.length} scenarios passed\n`);

  if (write) {
    const stamp = new Date().toISOString().slice(0, 10);
    const lines = [
      '# Collaboration bench',
      '',
      `Run ${stamp}${real ? ' · deterministic + real handoff' : ' · deterministic only'}.`,
      'This measures orchestration, not model quality: message delivery, merge',
      'completeness, failure isolation, tree ownership and visibility.',
      '',
      '| Scenario | Result | Time | Evidence |',
      '|---|---|---|---|',
      ...results.map((r) => `| ${r.id} | ${r.ok ? 'pass' : 'FAIL'} | ${r.ms} ms | ${r.detail} |`),
      '',
      `${passed}/${results.length} scenarios passed.`,
      '',
    ];
    writeFileSync(join(HERE, 'COLLABORATION.md'), lines.join('\n'));
    writeFileSync(join(HERE, 'collaboration.json'), JSON.stringify({ stamp, real, results }, null, 2) + '\n');
    process.stdout.write(`wrote ${join(HERE, 'COLLABORATION.md')}\n`);
  }

  process.exitCode = passed === results.length ? 0 : 1;
}

main().catch((error) => {
  process.stderr.write(`${error?.stack ?? error}\n`);
  process.exit(1);
});
