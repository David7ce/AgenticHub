#!/usr/bin/env node
// cli.mjs — inventory of the git repos under the workspace root.

import { existsSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { AUTHOR } from './lib/local.mjs';
import {
  collectUsage, limitsForRun, mergeCostLedger, readCostLedger, writeCostLedger,
} from './lib/costs.mjs';
import { PROJECTS_DIR, TOOL_DIR, resolveRoot, toDisplayPath, toWindowsPath } from './lib/paths.mjs';
import { DEFAULT_DEPTH, scanRepos } from './lib/scan.mjs';
import { applyStars, fetchStars, readStarsCache, writeStarsCache } from './lib/stars.mjs';
import { syncRepos } from './lib/sync.mjs';
import { COSTS_HTML, INDEX_HTML, NOTES_HTML, REPOS_JSON, writeSite } from './page/render.mjs';

const USAGE = `projects — inventory of the git repos under the workspace root

  node projects/tool/cli.mjs [build] [--root DIR] [--depth N] [--jobs N]
      Scan every repo (state + your commits) and rewrite dist/repos.json and
      dist/index.html. Offline and read-only.

  node projects/tool/cli.mjs sync [NAME...] [--fetch] [--dry-run] [--jobs N]
      Fetch and fast-forward repos (no names = all). Uncommitted work, unpushed
      commits, no remote or no upstream -> reported and left alone. --fetch
      skips the fast-forward. Without an ssh-agent it goes one repo at a time;
      --jobs N forces N in parallel.

  node projects/tool/cli.mjs stars [--refresh] [--max-age DAYS] [build options]
      Refresh GitHub star counts in local/stars.json (network; GITHUB_TOKEN
      raises the limit from 60 to 5,000 requests/hour), then build.

  node projects/tool/cli.mjs costs [--write] [--root DIR]
      Reconcile local agent token histories into working/costs.json and
      working/COSTS.md. Dry-run by default; never stores prompts or responses
      (only Claude Code's own short limit-reached records are matched, by time).
      --write also reads the Codex/Go limits through hubctl (asks the Codex account).

  node projects/tool/cli.mjs refresh [build options]
      costs --write, then build: updates both pages (Repos + IA) in one go. This is
      what agents run when asked to update the Workspaces panel.

Options go before or after names; --help prints this.`;

const COMMANDS = new Set(['build', 'sync', 'stars', 'costs', 'refresh']);

export function parseArgs(argv) {
  const options = {
    command: 'build', commandSet: false, names: [], root: null, depth: DEFAULT_DEPTH, jobs: 8, jobsSet: false,
    fetch: false, dryRun: false, refresh: false, write: false, maxAge: 7,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => {
      if (argv[i + 1] === undefined) throw new Error(`${arg} needs a value`);
      return argv[++i];
    };
    switch (arg) {
      case '-h': case '--help': options.command = 'help'; break;
      case '--root': options.root = value(); break;
      case '--depth': options.depth = Number(value()); break;
      case '--jobs': options.jobs = Number(value()); options.jobsSet = true; break;
      case '--fetch': options.fetch = true; break;
      case '--dry-run': options.dryRun = true; break;
      case '--refresh': options.refresh = true; break;
      case '--write': options.write = true; break;
      case '--max-age': options.maxAge = Number(value()); break;
      default:
        if (arg.startsWith('-')) throw new Error(`unknown option: ${arg}`);
        // Only the first word can be a command: an unknown one is a typo, not a repo name.
        if (!options.commandSet && !options.names.length && COMMANDS.has(arg)) {
          options.command = arg;
          options.commandSet = true;
        } else {
          options.names.push(arg);
        }
    }
  }
  if (!options.commandSet && options.names.length) throw new Error(`unknown command: ${options.names[0]}`);
  if (options.names.length && options.command !== 'sync') throw new Error(`${options.command} does not take repo names`);
  if (options.write && options.command !== 'costs') throw new Error('--write is only valid with costs');
  if (!Number.isInteger(options.depth) || options.depth < 1) throw new Error('--depth must be a positive integer');
  if (!Number.isInteger(options.jobs) || options.jobs < 1) throw new Error('--jobs must be a positive integer');
  if (!Number.isFinite(options.maxAge) || options.maxAge < 0) throw new Error('--max-age must be zero or a positive number of days');
  return options;
}

async function commandBuild(options, { withStars = false } = {}) {
  const started = Date.now();
  const { root, rows, days, activity } = await scanRepos({ root: options.root, depth: options.depth, jobs: options.jobs });
  if (!rows.length) throw new Error(`no git repos found under ${root}`);

  let stars = readStarsCache();
  let failed = false;
  if (withStars) {
    // Read inside the process and never printed.
    const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || process.env.AGENTHUB_GITHUB_TOKEN || null;
    const result = await fetchStars({
      rows, entries: stars, token, refresh: options.refresh, ttlDays: options.maxAge, log: console.log,
    });
    writeStarsCache(result.entries);
    stars = result.entries;
    failed = result.rateLimited && result.fetched === 0;
    console.log(`stars: ${result.fetched} fetched of ${result.total} GitHub repos${result.failed ? `, ${result.failed} without data` : ''}`);
  }
  applyStars(rows, stars);

  writeSite(rows, days, {
    root: toDisplayPath(root),
    generatedAt: `${new Date().toISOString().replace('T', ' ').slice(0, 16)} UTC`,
    author: AUTHOR,
    toolDir: toWindowsPath(TOOL_DIR),
  }, readCostLedger(), activity);
  const commits = days.reduce((sum, d) => sum + Object.values(d).reduce((a, b) => a + b, 0), 0);
  console.log(`wrote ${REPOS_JSON}`);
  console.log(`wrote ${INDEX_HTML}`);
  console.log(`wrote ${COSTS_HTML}`);
  console.log(`wrote ${NOTES_HTML}`);
  console.log(`repos: ${rows.length}, working: ${rows.filter((r) => r.working).length}, `
    + `your commits: ${commits} (${((Date.now() - started) / 1000).toFixed(1)}s)`);
  return failed ? 1 : 0;
}

async function commandSync(options) {
  if (!existsSync(REPOS_JSON)) throw new Error('dist/repos.json is missing — run: node projects/tool/cli.mjs build');
  const rows = JSON.parse(readFileSync(REPOS_JSON, 'utf8'));
  const { summary } = await syncRepos(rows, {
    names: options.names, pull: !options.fetch, dryRun: options.dryRun, parallel: options.jobsSet, jobs: options.jobs,
  });
  return summary.failed ? 1 : 0;
}

function commandCosts(options) {
  const previous = readCostLedger();
  const incoming = collectUsage({ workspaceRoot: options.root || resolveRoot() });
  const ledger = mergeCostLedger(previous, incoming);
  console.log(`costs: ${incoming.rows.length} buckets seen, ${ledger.rows.length} retained`);
  for (const [name, source] of Object.entries(incoming.sources)) {
    console.log(`  ${name}: ${source.available ? `${source.records} records` : 'unavailable'}`
      + `${source.firstDate ? ` (${source.firstDate} → ${source.lastDate})` : ''}`);
  }
  console.log(renderCostTotals(ledger));
  ledger.limits = limitsForRun({ rows: ledger.rows, write: options.write });
  console.log(renderLimitsLine(ledger.limits));
  if (!options.write) {
    console.log('dry-run; add --write to update working/costs.json and working/COSTS.md');
    return 0;
  }
  writeCostLedger(ledger);
  console.log(`wrote ${PROJECTS_DIR}/working/costs.json`);
  console.log(`wrote ${PROJECTS_DIR}/working/COSTS.md`);
  return 0;
}

/** costs --write, then build. Build runs even if costs fails, so Repos stays fresh. */
export async function commandRefresh(options, steps = { costs: commandCosts, build: commandBuild }) {
  let failed = false;
  try {
    if (steps.costs({ ...options, write: true }) !== 0) failed = true;
  } catch (error) {
    console.error(`refresh: costs failed: ${error.message}`);
    failed = true;
  }
  if ((await steps.build(options)) !== 0) failed = true;
  return failed ? 1 : 0;
}

function renderLimitsLine(limits) {
  const codex = limits.codex?.windows?.map((w) => `${w.label} ${w.usedPercent}%`).join(', ');
  const goMax = Math.max(0, ...(limits.go ?? []).map((m) => m.pct ?? 0));
  const c = limits.claude;
  const record = c.record5h.tokens ? `${Math.round((c.window5h.tokens / c.record5h.tokens) * 100)}% of record` : 'no record';
  return `  limits: codex ${codex || '—'} · go max ${(goMax * 100).toFixed(1)}%`
    + ` · claude 5h ${c.window5h.tokens} work tokens (${record}${c.reference ? `, ref ${c.reference.source}` : ', no plan reference'})`
    + `${limits.error ? ` · ${limits.error}` : ''}`;
}

function renderCostTotals(ledger) {
  const sums = ledger.rows.reduce((total, row) => {
    for (const key of ['input_tokens', 'cache_write_tokens', 'cache_read_tokens', 'output_tokens', 'reasoning_tokens', 'unknown_tokens']) {
      total[key] += Number(row[key]) || 0;
    }
    return total;
  }, { input_tokens: 0, cache_write_tokens: 0, cache_read_tokens: 0, output_tokens: 0, reasoning_tokens: 0, unknown_tokens: 0 });
  return `  tokens: entrada ${sums.input_tokens}, escritura caché ${sums.cache_write_tokens}, `
    + `lectura caché ${sums.cache_read_tokens}, salida ${sums.output_tokens}, `
    + `razonamiento ${sums.reasoning_tokens}, sin desglose ${sums.unknown_tokens}`;
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`${error.message}\n\n${USAGE}`);
    return 2;
  }
  try {
    switch (options.command) {
      case 'help': console.log(USAGE); return 0;
      case 'sync': return await commandSync(options);
      case 'stars': return await commandBuild(options, { withStars: true });
      case 'costs': return commandCosts(options);
      case 'refresh': return await commandRefresh(options);
      default: return await commandBuild(options);
    }
  } catch (error) {
    console.error(`projects: ${error.message}`);
    return 1;
  }
}

// Importable for tests: run only when invoked directly.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => process.exit(code));
}
