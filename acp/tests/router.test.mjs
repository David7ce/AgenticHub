import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  decideAgent,
  decideRoute,
  describeAttempts,
  isQuotaError,
  modelChain,
  otherAgent,
  readAgentEntry,
  readCatalog,
  readRunStats,
  shouldTryNextModel,
} from '../router.mjs';

const NOW = Date.parse('2026-10-29T12:00:00Z');
const iso = (msAgo) => new Date(NOW - msAgo).toISOString().replace(/\.\d{3}Z$/, 'Z');
const zero = () => ({
  runs: 0, ok: 0, failures: 0, recentFailures: 0, timeouts: 0,
  cost: 0, lastRun: null, lastFailure: null,
});
const statsWith = (overrides = {}) => ({
  opencode: { ...zero(), ...overrides.opencode },
  claude: { ...zero(), ...overrides.claude },
});

test('defaults to the cheap worker for a plain prompt', () => {
  assert.deepEqual(decideAgent('what is this file', { health: false }), {
    agent: 'opencode',
    reason: 'no scope or consequence signal; the cheap worker handles it',
  });
});

test('escalates on scope, and difficulty words do not', () => {
  assert.equal(decideAgent('refactor this across every module', { health: false }).agent, 'claude');
  assert.equal(decideAgent('this is a multi-file change', { health: false }).agent, 'claude');
  assert.equal(decideAgent('migrate the schema', { health: false }).agent, 'claude');

  // The bench found no failure for the cheap worker on these, so they are not
  // signals: escalating them spends the weekly quota on ordinary work.
  assert.equal(decideAgent('please do a CODE REVIEW', { health: false }).agent, 'opencode');
  assert.equal(decideAgent('debug this', { health: false }).agent, 'opencode');
  assert.equal(decideAgent('why does this hang', { health: false }).agent, 'opencode');
  assert.equal(decideAgent('explain the trade-offs', { health: false }).agent, 'opencode');
  assert.equal(decideAgent('what edge cases are there', { health: false }).agent, 'opencode');
});

test('escalates on Spanish scope and consequence too', () => {
  assert.equal(decideAgent('revisa este cambio de permisos en varios módulos', { health: false }).agent, 'claude');
  assert.equal(decideAgent('renombrar la API en todos los paquetes', { health: false }).agent, 'claude');
  assert.equal(decideAgent('arregla este test que falla', { health: false }).agent, 'opencode');
});

test('escalates on consequence', () => {
  assert.equal(decideAgent('rotate the credentials', { health: false }).agent, 'claude');
  assert.equal(decideAgent('security review of the auth flow', { health: false }).agent, 'claude');
  assert.equal(decideAgent('the billing retry charges twice', { health: false }).agent, 'claude');
  assert.equal(decideAgent('this touches production permissions', { health: false }).agent, 'claude');
});

test('escalates a large prompt even without a signal', () => {
  assert.equal(decideAgent('x'.repeat(1201), { health: false }).agent, 'claude');
  assert.equal(decideAgent('x'.repeat(1200), { health: false }).agent, 'opencode');
});

test('a recent claude failure moves an escalation to opencode', () => {
  const decision = decideAgent('rotate the credentials', {
    stats: statsWith({ claude: { recentFailures: 1 } }),
  });
  assert.equal(decision.agent, 'opencode');
  assert.match(decision.reason, /claude has 1 failure\/timeout/);
});

test('two recent opencode failures escalate a plain prompt to claude', () => {
  const decision = decideAgent('hello', {
    stats: statsWith({ opencode: { recentFailures: 2 } }),
  });
  assert.equal(decision.agent, 'claude');
  assert.match(decision.reason, /opencode has 2 failure\/timeout/);
});

test('one recent opencode failure does not escalate', () => {
  const decision = decideAgent('hello', {
    stats: statsWith({ opencode: { recentFailures: 1 } }),
  });
  assert.equal(decision.agent, 'opencode');
});

test('claude spend above the ceiling keeps the cheap worker', () => {
  const decision = decideAgent('rotate the credentials', {
    stats: statsWith({ claude: { cost: 2.5 } }),
    costCeiling: 2,
  });
  assert.equal(decision.agent, 'opencode');
  assert.match(decision.reason, /spent \$2\.50 in 24 h/);
});

test('ceiling 0 disables the cost rule', () => {
  const decision = decideAgent('rotate the credentials', {
    stats: statsWith({ claude: { cost: 999 } }),
    costCeiling: 0,
  });
  assert.equal(decision.agent, 'claude');
});

test('health:false ignores stats entirely', () => {
  const decision = decideAgent('rotate the credentials', {
    stats: statsWith({ claude: { recentFailures: 5, cost: 99 } }),
    health: false,
  });
  assert.equal(decision.agent, 'claude');
});

test('both agents unhealthy keeps the base pick', () => {
  const decision = decideAgent('hello', {
    stats: statsWith({
      opencode: { recentFailures: 2 },
      claude: { recentFailures: 1 },
    }),
  });
  assert.equal(decision.agent, 'opencode');
});

test('readRunStats counts only finished ACP turns inside the 24h window', () => {
  const dir = mkdtempSync(join(tmpdir(), 'router-test-'));
  const log = join(dir, 'runs.jsonl');
  try {
    const records = [
      // counted: recent ok, recent failure, claude spend
      { time: iso(60_000), agent: 'opencode', transport: 'acp', status: 'ok', cost: { amount: 0.001 } },
      { time: iso(120_000), agent: 'opencode', transport: 'acp', status: 'timeout' },
      { time: iso(180_000), agent: 'claude', transport: 'acp', status: 'ok', cost: { amount: 0.25 } },
      // not counted: denied, probe, non-acp, fanout summary, too old, corrupt
      { time: iso(10_000), agent: 'opencode', transport: 'acp', status: 'denied' },
      { time: iso(10_000), agent: 'opencode', transport: 'acp', status: 'probe' },
      { time: iso(10_000), agent: 'opencode', transport: 'cli', status: 'ok' },
      { time: iso(10_000), mode: 'fanout', agents: [], status: 'ok' },
      { time: iso(25 * 60 * 60 * 1000), agent: 'claude', transport: 'acp', status: 'ok', cost: { amount: 5 } },
    ];
    writeFileSync(log, records.map((r) => JSON.stringify(r)).join('\n') + '\nnot json\n');

    const stats = readRunStats(log, NOW);
    assert.equal(stats.opencode.runs, 2);
    assert.equal(stats.opencode.failures, 1);
    assert.equal(stats.opencode.recentFailures, 1);
    assert.equal(stats.opencode.timeouts, 1);
    assert.equal(stats.opencode.cost, 0.001);
    assert.equal(stats.claude.runs, 1);
    assert.equal(stats.claude.cost, 0.25);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readRunStats tolerates a missing log', () => {
  const stats = readRunStats('/nonexistent/runs.jsonl', NOW);
  assert.equal(stats.opencode.runs, 0);
  assert.equal(stats.claude.runs, 0);
});

test('a quota error is recognised, an ordinary failure is not', () => {
  assert.equal(isQuotaError('429 Too Many Requests'), true);
  assert.equal(isQuotaError('weekly limit reached'), true);
  assert.equal(isQuotaError('insufficient credits'), true);
  assert.equal(isQuotaError('rate limit exceeded'), true);
  assert.equal(isQuotaError('monthly allowance exhausted'), true);

  assert.equal(isQuotaError('SyntaxError: unexpected token'), false);
  assert.equal(isQuotaError('session/prompt timed out after 300000ms'), false);
  assert.equal(isQuotaError(''), false);
  assert.equal(isQuotaError(null), false);
});

test('failover targets the other pool', () => {
  assert.equal(otherAgent('opencode'), 'claude');
  assert.equal(otherAgent('claude'), 'opencode');
});

test('the model chain is free first, then the paid fallbacks in order', () => {
  const entry = {
    defaultConfig: { model: 'opencode/deepseek-v4.1-flash-free' },
    modelFallbacks: ['opencode-go/deepseek-v4.1-flash', 'opencode-go/claude-haiku-5-5'],
  };
  assert.deepEqual(modelChain(entry), [
    'opencode/deepseek-v4.1-flash-free',
    'opencode-go/deepseek-v4.1-flash',
    'opencode-go/claude-haiku-5-5',
  ]);
  // An explicit model is a decision, not a hint: no substitution, ever.
  assert.deepEqual(modelChain(entry, { requested: 'opencode-go/gpt-6-luna' }), [
    'opencode-go/gpt-6-luna',
  ]);
  // An agent with no registry entry still yields one (empty) attempt.
  assert.deepEqual(modelChain(null), []);
  // Duplicates are dropped, and empty strings never become a model name.
  assert.deepEqual(modelChain({ defaultConfig: { model: 'a' }, modelFallbacks: ['a', ' ', 'b'] }), [
    'a',
    'b',
  ]);
});

test('only a quota failure moves to the next model', () => {
  assert.equal(shouldTryNextModel({ ok: false, error: 'Free usage limit reached' }), true);
  assert.equal(shouldTryNextModel({ ok: false, error: 'session/prompt timed out after 600000ms' }), false);
  assert.equal(shouldTryNextModel({ ok: false, error: 'SyntaxError: unexpected token' }), false);
  assert.equal(shouldTryNextModel({ ok: true, status: 'ok' }), false);
  assert.equal(shouldTryNextModel(null), false);
});

test('describeAttempts says which model answered and what it replaced', () => {
  assert.equal(
    describeAttempts([
      { model: 'free', status: 'failed' },
      { model: 'paid', status: 'ok' },
    ]),
    'free: failed → paid: ok',
  );
  assert.equal(describeAttempts([]), '');
});

test('readAgentEntry tolerates a missing or broken registry', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hub-registry-'));
  const path = join(dir, 'agents.json');
  writeFileSync(path, JSON.stringify({ agents: { opencode: { defaultConfig: { model: 'x' } } } }));
  assert.equal(readAgentEntry(path, 'opencode').defaultConfig.model, 'x');
  assert.equal(readAgentEntry(path, 'nope'), null);
  writeFileSync(path, '{ not json');
  assert.equal(readAgentEntry(path, 'opencode'), null);
  assert.equal(readAgentEntry(join(dir, 'missing.json'), 'opencode'), null);
  rmSync(dir, { recursive: true, force: true });
});

test('decideRoute recommends a review topology without launching it', () => {
  const route = decideRoute('revisa este diff de un módulo', { health: false, catalog: { models: [
    { id: 'opencode-go/deepseek-v4.1-flash', agent: 'opencode', tier: 'default', enabled: true },
  ] } });
  assert.equal(route.agent, 'opencode');
  assert.equal(route.model, 'opencode-go/deepseek-v4.1-flash');
  assert.equal(route.topology, 'review');
});

test('decideRoute stops escalation once the daily ceiling is spent', () => {
  const stats = statsWith({ claude: { cost: 3.5 }, opencode: { cost: 0 } });
  const route = decideRoute('this touches production permissions', {
    stats, dailyCeiling: 3, health: true,
  });
  assert.equal(route.agent, 'opencode');
  assert.match(route.reason, /ceiling/);
});

test('the shipped catalog matches the registered workers', async () => {
  const catalog = readCatalog();
  const enabled = catalog.models.filter((m) => m.enabled).map((m) => m.agent);
  assert.ok(enabled.includes('opencode'));
  assert.ok(enabled.includes('claude'));
  assert.ok(!enabled.includes('hermes'), 'Hermes is manual-only');
  assert.ok(enabled.includes('codex'), 'Codex runs through codex-acp 2.6.0 since 2026-11-08');
  assert.ok(catalog.models.some((m) => m.provider === 'openrouter' && m.enabled === false));
  // Astra and Opus are explicit-only: never enabled for routing.
  for (const m of catalog.models.filter((m) => m.tier === 'frontier')) {
    assert.equal(m.enabled, false, `${m.id} is frontier and must stay disabled for routing`);
  }
});

test('frontier models are never an automatic pick, even when enabled', () => {
  const catalog = {
    providers: {},
    models: [
      { id: 'astra', agent: 'codex', tier: 'frontier', enabled: true },
      { id: 'sol', agent: 'codex', tier: 'strong', enabled: true },
      { id: 'terra', agent: 'codex', tier: 'default', enabled: true },
    ],
  };
  const route = decideRoute('hola', { force: 'codex', catalog });
  assert.equal(route.model, 'terra', 'default beats strong; frontier is skipped');
  const onlyFrontier = decideRoute('hola', {
    force: 'codex',
    catalog: { providers: {}, models: [{ id: 'astra', agent: 'codex', tier: 'frontier', enabled: true }] },
  });
  assert.equal(onlyFrontier.model, null);
});

test('the shipped registry puts the paid DeepSeek before the free one', async () => {
  // The 2026-11-04 instruction: always prefer the paid Go DeepSeek. This guards
  // the actual file, not a copy of it.
  const { readFileSync, existsSync } = await import('node:fs');
  const { dirname, join } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const base = dirname(fileURLToPath(import.meta.url));
  const local = join(base, '..', 'agents.json');
  const registry = existsSync(local) ? local : join(base, '..', 'agents.example.json');
  const agents = JSON.parse(readFileSync(registry, 'utf8')).agents;

  assert.equal(agents.opencode.defaultConfig.model, 'opencode-go/deepseek-v4.1-flash');
  const chain = modelChain(agents.opencode);
  assert.equal(chain[0], 'opencode-go/deepseek-v4.1-flash', 'paid first');
  assert.equal(chain[1], 'opencode/deepseek-v4.1-flash-free', 'free is the fallback');
  assert.ok(chain.length >= 3);
  // Hermes may be registered (2026-11-11, so ACP clients can reach it) but is never
  // a routing target and its example grant must ship disabled. Codex uses the
  // maintained adapter, pinned, never the frozen @zed-industries one.
  assert.equal(agents.hermes.command, 'hermes');
  const exampleConsent = JSON.parse(readFileSync(join(base, '..', '..', 'consent.example.json'), 'utf8'));
  assert.equal(exampleConsent.hermes.enabled, false);
  assert.ok(agents.codex.args.includes('@agentclientprotocol/codex-acp@2.6.0'));
  const launched = JSON.stringify([agents.codex.command, agents.codex.args, agents.codex.platforms]);
  assert.ok(!launched.includes('@zed-industries/codex-acp'));
});
