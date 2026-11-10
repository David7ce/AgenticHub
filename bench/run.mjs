#!/usr/bin/env node
// run.mjs — the internal benchmark: can an agent restore a function from its tests?
//
//   node agent-hub/bench/run.mjs --dry-run          # prove every task is broken
//   node agent-hub/bench/run.mjs --agent opencode --model opencode-go/deepseek-v4.1-flash
//   node agent-hub/bench/run.mjs --tasks paths-to-wsl --reps 3 --keep
//
// One task = one function whose body is replaced with a stub. The repository's
// own tests decide whether the agent succeeded, so there is no judge model and
// no rubric to argue with.
//
// Fairness rules, enforced rather than documented:
//   - Each attempt runs in a fresh copy with a fresh single-commit git repo, so
//     `git log` / `git diff` cannot hand the agent the original implementation.
//   - Only agent-hub/ is copied; the rest of the workspace never enters the run.
//   - The test command is fixed per task; the agent is told not to touch tests.
//
// Exit: 0 if every attempt passed, 1 otherwise, 2 if the harness itself broke.

import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';

// Windows keeps handles on a fresh tree for a moment after the agent exits, and
// antivirus scans it at the same time. A single rmSync turned that into a fatal
// harness error after a passing task, so retry and, if it still fails, keep the
// copy and carry on: the task result is valid, the leftover is noise.
function removeTree(dir) {
  const remove = () => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  try {
    remove();
    return true;
  } catch (error) {
    // Node's `force` does not clear the read-only attribute that git sets on
    // some files; PowerShell's Remove-Item -Force does, and attrib reproduces
    // that without depending on PowerShell.
    if (process.platform === 'win32') {
      spawnSync('attrib', ['-R', '-H', '/S', '/D', dir], { windowsHide: true });
      try {
        remove();
        return true;
      } catch { /* report below */ }
    }
    process.stderr.write(`[bench] could not remove ${dir} (${error.code ?? error.message}); kept\n`);
    return false;
  }
}
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const HUB = resolve(HERE, '..');
const ROOT = resolve(HUB, '..');
const HUB_ACP = join(HUB, 'acp', 'hub-acp.mjs');
const TASKS_PATH = join(HERE, 'tasks.json');
const RESULTS_DIR = join(HUB, 'results', 'bench');

const USAGE = `usage: node agent-hub/bench/run.mjs [options]

  --agent NAME        registry agent to drive (default: opencode)
  --model ID          session model, passed to hub-acp --model
  --models A,B,C      run the suite once per model, sequentially, and print a
                      comparison table (writes one summary per model plus a
                      matrix summary)
  --tasks A,B         subset of task ids (default: all)
  --reps N            attempts per task (default: 1)
  --timeout MS        per-turn timeout (default: 300000)
  --keep              keep the task copies under /tmp for inspection
  --dry-run           stub each task and assert its tests fail; no model calls
  --json              print the summary as JSON
`;

function parseArgs(argv) {
  const opts = { agent: 'opencode', reps: 1, timeout: 300_000, keep: false, dryRun: false, json: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) fail(`${arg} needs a value`);
      return argv[++i];
    };
    switch (arg) {
      case '--agent': opts.agent = next(); break;
      case '--model': opts.model = next(); break;
      case '--models':
        opts.models = next().split(',').map((value) => value.trim()).filter(Boolean);
        if (opts.models.length < 2) fail('--models needs two or more models, comma-separated');
        break;
      case '--tasks': opts.tasks = next().split(',').map((s) => s.trim()).filter(Boolean); break;
      case '--reps': opts.reps = Number(next()); break;
      case '--timeout': opts.timeout = Number(next()); break;
      case '--keep': opts.keep = true; break;
      case '--dry-run': opts.dryRun = true; break;
      case '--json': opts.json = true; break;
      case '-h': case '--help': opts.help = true; break;
      default: fail(`unknown option: ${arg}`);
    }
  }
  if (!opts.model && !opts.dryRun && !opts.models) {
    opts.model = registryDefaultModel(opts.agent) ?? undefined;
    if (opts.model) {
      process.stderr.write(`[bench] no --model: pinning the registry default ${opts.model}\n`);
    }
  }
  return opts;
}

// A benchmark has to name the model it measured. When --model is omitted the
// registry default would still be applied by hub-acp, so resolve it here and
// pin it: the summary then says what actually ran, and no fallback chain can
// quietly substitute a different model mid-run.
function registryDefaultModel(agent) {
  const path = process.env.AGENT_HUB_REGISTRY ?? join(HERE, '..', 'acp', 'agents.json');
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    return raw?.agents?.[agent]?.defaultConfig?.model ?? null;
  } catch {
    return null;
  }
}

function fail(message) {
  process.stderr.write(`[bench] ${message}\n\n${USAGE}`);
  process.exit(2);
}

const stamp = () => new Date().toISOString().replace(/[:.]/g, '-').replace('Z', '');

function git(args, cwd) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${(result.stderr || '').trim()}`);
  }
  return (result.stdout || '').trim();
}

// Replace a top-level function body with a throwing stub. Brace counting is
// enough for the files this bench targets: they contain no unbalanced braces
// inside strings or comments, and a mismatch throws instead of silently
// producing a task that tests nothing.
export function stubFunction(source, symbol) {
  const needle = `export function ${symbol}(`;
  const start = source.indexOf(needle);
  if (start === -1) throw new Error(`cannot find "export function ${symbol}("`);
  if (source.indexOf(needle, start + 1) !== -1) throw new Error(`"${symbol}" is defined twice`);

  const braceStart = source.indexOf('{', start);
  let depth = 0;
  let end = -1;
  for (let i = braceStart; i < source.length; i++) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) { end = i; break; }
    }
  }
  if (end === -1) throw new Error(`unbalanced braces in ${symbol}`);

  const stub = `{\n  throw new Error('BENCH_STUB: reimplement ${symbol} from the tests');\n}`;
  return source.slice(0, braceStart) + stub + source.slice(end + 1);
}

function copyWorkspace(dir) {
  cpSync(join(ROOT, 'agent-hub'), join(dir, 'agent-hub'), {
    recursive: true,
    filter: (src) => !src.includes(`${join('agent-hub', 'results')}`),
  });
  git(['init', '-q', '-b', 'main'], dir);
  git(['-c', 'user.email=bench@local', '-c', 'user.name=bench', 'add', '-A'], dir);
  git(['-c', 'user.email=bench@local', '-c', 'user.name=bench', 'commit', '-q', '-m', 'bench: baseline'], dir);
}

function runTests(dir, testPath) {
  const result = spawnSync(process.execPath, ['--test', testPath], { cwd: dir, encoding: 'utf8' });
  return { pass: result.status === 0, exit: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

// The agent is told to edit one file. Nothing stops it from editing the test
// instead and "passing", so the files it actually touched are part of the
// verdict, not a footnote.
//
// Porcelain lines are `XY <path>`; the status columns can be spaces, so this
// parses the shape instead of slicing a fixed offset (and does not go through
// git(), which trims the output).
export function changedFiles(dir, allowed) {
  const allow = Array.isArray(allowed) ? allowed : [allowed];
  const result = spawnSync('git', ['status', '--porcelain'], { cwd: dir, encoding: 'utf8' });
  if (result.status !== 0) return [];
  return (result.stdout || '')
    .split('\n')
    .filter(Boolean)
    .map((line) => line.slice(2).trim().replace(/^"|"$/g, ''))
    .filter((path) => path && !allow.includes(path));
}

function agentPrompt(task) {
  const symbols = task.symbols ?? (task.symbol ? [task.symbol] : []);
  const files = task.files ?? [task.file];
  const lead = symbols.length
    ? `Restore the implementation of ${symbols.map((s) => `\`${s}\``).join(', ')} in \`${task.file}\`.`
    : `Implement the change described below.`;
  return [
    lead,
    '',
    task.prompt,
    '',
    'The tests in this repository define the expected behaviour. Run:',
    `  node --test ${task.test}`,
    'until it passes.',
    '',
    `Rules: edit only ${files.map((f) => `\`${f}\``).join(', ')}; do not modify tests; do not read git history.`,
  ].join('\n');
}

function runAgent({ agent, model, cwd, prompt, timeout }) {
  return new Promise((resolvePromise) => {
    const args = [
      HUB_ACP,
      '--agent', agent,
      '--cwd', cwd,
      '--prompt', '-',
      '--json',
      '--no-save',
      '--permission', 'allow-all',
      '--timeout', String(timeout),
    ];
    if (model) args.push('--model', model);

    const child = spawn(process.execPath, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => resolvePromise({ ok: false, status: 'spawn-failed', error: error.message }));
    child.on('close', () => {
      try {
        const parsed = JSON.parse(stdout);
        resolvePromise({
          ok: parsed.ok === true,
          status: parsed.status ?? 'unknown',
          durationMs: parsed.durationMs,
          cost: parsed.cost ?? null,
          toolCount: Array.isArray(parsed.tools) ? parsed.tools.length : 0,
          sessionId: parsed.sessionId ?? null,
          error: parsed.error ?? null,
        });
      } catch (error) {
        resolvePromise({
          ok: false,
          status: 'unparseable',
          parseError: error.message,
          stdoutTail: stdout.trim().slice(-200),
          error: (stderr.trim() || stdout.trim()).slice(0, 400),
        });
      }
    });
    child.stdin.end(prompt, 'utf8');
  });
}

// ── model matrix ────────────────────────────────────────────────────────────
//
// Comparing two models used to mean two commands and two readings of the,
// terminal. `--models a,b` re-runs this same script once per model (same tasks,
// same reps, sequentially so they do not compete for the account) and writes
// one comparison.

function newestSummaryFor(model, since) {
  const dir = join(RESULTS_DIR);
  if (!existsSync(dir)) return null;
  const names = readdirSync(dir)
    .filter((name) => name.endsWith('-summary.json'))
    .sort()
    .reverse();
  for (const name of names) {
    const candidate = JSON.parse(readFileSync(join(dir, name), 'utf8'));
    if (candidate.dryRun) continue;
    if (candidate.model !== model) continue;
    // The child stamps its summary after we start looping; ignore older runs.
    if (since && candidate.stamp && candidate.stamp < since) continue;
    return candidate;
  }
  return null;
}

async function runMatrix(opts) {
  const passthrough = [];
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--models') {
      i += 1; // drop the value too
      continue;
    }
    if (argv[i].startsWith('--models=')) continue;
    passthrough.push(argv[i]);
  }

  const stampStart = stamp();
  const summaries = [];
  for (const model of opts.models) {
    process.stderr.write(`\n[bench] === ${model} ===\n`);
    const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url), ...passthrough, '--model', model], {
      stdio: ['ignore', 'inherit', 'inherit'],
      windowsHide: true,
    });
    const summary = newestSummaryFor(model, stampStart);
    summaries.push(
      summary ?? {
        model,
        passed: null,
        attempts: null,
        totalDurationMs: null,
        note: `run exited ${result.status} with no summary`,
      },
    );
  }

  const rows = summaries.map((entry) => ({
    model: entry.model,
    passed: entry.passed,
    attempts: entry.attempts,
    minutes: entry.totalDurationMs == null ? null : Number((entry.totalDurationMs / 60000).toFixed(1)),
  }));
  const comparison = {
    stamp: stampStart,
    tasks: summaries[0]?.tasks ?? null,
    reps: opts.reps,
    rows,
  };
  mkdirSync(RESULTS_DIR, { recursive: true });
  const file = join(RESULTS_DIR, `${stampStart}-matrix-summary.json`);
  writeFileSync(file, JSON.stringify(comparison, null, 2) + '\n', 'utf8');

  const width = Math.max(...rows.map((row) => row.model.length), 5);
  const lines = ['', `model matrix · ${comparison.tasks ?? '?'} tasks · ${opts.reps} rep(s)`, ''];
  for (const row of rows) {
    const score = row.passed == null ? '   ?  ' : `${row.passed}/${row.attempts}`.padStart(6);
    const time = row.minutes == null ? '     ?' : `${row.minutes} min`.padStart(8);
    lines.push(`  ${row.model.padEnd(width)}  ${score}  ${time}`);
  }
  lines.push('', file);
  process.stdout.write(lines.join('\n') + '\n');

  const failed = rows.filter((row) => row.passed == null || row.passed !== row.attempts);
  return failed.length ? 1 : 0;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { process.stdout.write(USAGE); return 0; }
  if (!Number.isInteger(opts.reps) || opts.reps < 1) fail('--reps must be a positive integer');
  if (opts.models) {
    if (opts.dryRun) fail('--models runs the suite; drop --dry-run');
    return runMatrix(opts);
  }

  const all = JSON.parse(readFileSync(TASKS_PATH, 'utf8'));
  const selected = opts.tasks ? all.filter((task) => opts.tasks.includes(task.id)) : all;
  if (!selected.length) fail(`no tasks matched: ${opts.tasks?.join(',')}`);

  const runStamp = stamp();
  const records = [];
  let harnessBroken = false;

  for (const task of selected) {
    for (let rep = 1; rep <= opts.reps; rep++) {
      const dir = mkdtempSync(join(tmpdir(), `hub-bench-${task.id}-`));
      let record = { time: runStamp, task: task.id, rep, agent: opts.agent, model: opts.model ?? null };

      try {
        copyWorkspace(dir);

        const symbols = task.symbols ?? (task.symbol ? [task.symbol] : []);
        if (symbols.length) {
          const target = join(dir, task.file);
          let source = readFileSync(target, 'utf8');
          for (const symbol of symbols) source = stubFunction(source, symbol);
          writeFileSync(target, source, 'utf8');
        }

        // Spec tasks ship the failing test instead of a stub: the function does
        // not exist yet, so the failure comes from the missing export. A hidden
        // task keeps that test out of the tree entirely, so the agent has to
        // get the contract right without iterating against it.
        if (task.fixture && !task.hidden) {
          cpSync(join(HERE, task.fixture), join(dir, task.test));
        }

        git(['-c', 'user.email=bench@local', '-c', 'user.name=bench', 'add', '-A'], dir);
        // A hidden spec task changes nothing in the tree (its test stays out),
        // so only commit when there is something staged.
        const staged = spawnSync('git', ['diff', '--cached', '--quiet'], { cwd: dir }).status !== 0;
        if (staged) {
          git(
            ['-c', 'user.email=bench@local', '-c', 'user.name=bench', 'commit', '-q', '-m', `bench: ${symbols.length ? `stub ${symbols.join(', ')}` : 'spec'}`],
            dir,
          );
        }

        if (task.hidden) cpSync(join(HERE, task.fixture), join(dir, task.test));
        const broken = runTests(dir, task.test);
        if (task.hidden) rmSync(join(dir, task.test), { force: true });
        if (broken.pass) {
          // A stub whose tests still pass measures nothing. Fail loudly.
          throw new Error(
            `applying ${task.id} left ${task.test} passing`,
          );
        }

        if (opts.dryRun) {
          // A fixture that does not even parse "fails its tests" for the wrong
          // reason, so no agent could ever pass it (spec-paths-same did once).
          if (task.fixture) {
            const parse = spawnSync(process.execPath, ['--check', join(HERE, task.fixture)], { encoding: 'utf8' });
            if (parse.status !== 0) throw new Error(`fixture ${task.fixture} does not parse: ${parse.stderr.trim().split('\n')[0]}`);
          }
          record = { ...record, dryRun: true, stubBreaksTests: true, pass: false };
          process.stderr.write(`[bench] ${task.id}: stub breaks the tests as expected\n`);
        } else {
          const answer = await runAgent({
            agent: opts.agent,
            model: opts.model,
            cwd: dir,
            prompt: agentPrompt(task),
            timeout: opts.timeout,
          });
          const tampered = changedFiles(dir, task.files ?? task.file);
          if (task.hidden) cpSync(join(HERE, task.fixture), join(dir, task.test));
          const verified = runTests(dir, task.test);
          record = {
            ...record,
            ...answer,
            pass: verified.pass && tampered.length === 0,
            testExit: verified.exit,
            tampered,
            testTail: verified.pass ? null : verified.output.slice(-600),
          };
          process.stderr.write(
            `[bench] ${task.id} rep ${rep}: ${record.pass ? 'PASS' : 'FAIL'} ` +
            `(${answer.status}, ${((answer.durationMs ?? 0) / 1000).toFixed(1)}s, ${answer.toolCount ?? 0} tools)` +
            (tampered.length ? ` — touched ${tampered.join(', ')}` : '') + '\n',
          );
        }
      } catch (error) {
        harnessBroken = true;
        record = { ...record, pass: false, status: 'harness-error', error: error.message };
        process.stderr.write(`[bench] ${task.id}: harness error — ${error.message}\n`);
      } finally {
        records.push(record);
        if (!opts.keep) removeTree(dir);
      }
    }
  }

  // A dry run proves the tasks are broken; it is not a result worth keeping, and
  // check.mjs runs it on every commit.
  const file = join(RESULTS_DIR, `${runStamp}-${opts.agent}.jsonl`);
  if (!opts.dryRun) {
    mkdirSync(RESULTS_DIR, { recursive: true });
    for (const record of records) appendFileSync(file, JSON.stringify(record) + '\n', 'utf8');
  }

  const attempts = records.filter((r) => !r.dryRun);
  const passed = attempts.filter((r) => r.pass).length;
  const summary = {
    stamp: runStamp,
    agent: opts.agent,
    model: opts.model ?? null,
    tasks: selected.length,
    reps: opts.reps,
    attempts: attempts.length,
    passed,
    passRate: attempts.length ? Number((passed / attempts.length).toFixed(3)) : null,
    totalCost: attempts.reduce((sum, r) => sum + (r.cost?.amount ?? 0), 0),
    totalDurationMs: attempts.reduce((sum, r) => sum + (r.durationMs ?? 0), 0),
    results: file,
    dryRun: opts.dryRun,
  };
  if (!opts.dryRun) {
    writeFileSync(join(RESULTS_DIR, `${runStamp}-${opts.agent}-summary.json`), JSON.stringify(summary, null, 2) + '\n', 'utf8');
  }

  if (opts.json) {
    process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
  } else if (opts.dryRun) {
    process.stdout.write(`\ndry run: ${records.length} task(s) stubbed, every one breaks its tests\n`);
  } else {
    process.stdout.write(
      `\n${passed}/${attempts.length} passed · ${(summary.totalDurationMs / 1000).toFixed(1)}s · ` +
      `$${summary.totalCost.toFixed(4)} · ${summary.model ?? 'registry default'} · ${file}\n`,
    );
  }

  if (harnessBroken) return 2;
  if (opts.dryRun) return 0;
  return passed === attempts.length ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    process.stderr.write(`[bench] fatal: ${error?.stack ?? error}\n`);
    process.exit(2);
  });
