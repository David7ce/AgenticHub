import test from 'node:test';
import assert from 'node:assert/strict';

import {
  checkCodexAdapter,
  checkCodexModels,
  checkFrontier,
  checkGrants,
  checkHandoffFresh,
  checkLeftovers,
  checkOpencodeMcp,
  checkRegistryConsent,
  findBrokenLinks,
  latestCodexModels,
  renderDoctor,
} from '../doctor.mjs';

const NOW = Date.parse('2026-11-08T00:00:00Z');
const grant = (extra = {}) => ({ enabled: true, overseerAck: true, expires: '2027-01-08T00:00:00Z', ...extra });

test('registry and consent must name the same agents', () => {
  const rows = checkRegistryConsent(
    { agents: { a: {}, b: {} } },
    { _note: 'x', a: grant(), ghost: grant() },
  );
  assert.ok(rows.some((r) => r.level === 'fail' && /b is in acp\/agents.json/.test(r.detail)));
  assert.ok(rows.some((r) => r.level === 'fail' && /ghost is enabled/.test(r.detail)));
  assert.equal(checkRegistryConsent({ agents: { a: {} } }, { a: grant() })[0].level, 'ok');
});

test('a disabled entry for a registered agent is enough', () => {
  const rows = checkRegistryConsent({ agents: { s: {} } }, { s: { enabled: false } });
  assert.equal(rows[0].level, 'ok');
});

test('expiry is ok, warn within 14 days, fail once past', () => {
  const level = (expires) => checkGrants({ a: grant({ expires, limits: {} }) }, { now: NOW })
    .find((r) => r.check === 'consent').level;
  assert.equal(level('2027-01-08T00:00:00Z'), 'ok');
  assert.equal(level('2026-11-15T00:00:00Z'), 'warn');
  assert.equal(level('2026-11-01T00:00:00Z'), 'fail');
});

test('limits: missing is a warn, a missing write tree or bad permission is a fail', () => {
  assert.ok(checkGrants({ a: grant() }, { now: NOW }).some((r) => r.check === 'limits' && r.level === 'warn'));
  const rows = checkGrants(
    { a: grant({ limits: { maxPermission: 'root', writeTrees: ['D:/nope'] } }) },
    { now: NOW, exists: () => false },
  );
  assert.ok(rows.some((r) => r.level === 'fail' && /maxPermission is invalid/.test(r.detail)));
  assert.ok(rows.some((r) => r.level === 'fail' && /does not exist: D:\/nope/.test(r.detail)));
});

test('a budget promised in the scope text must match the enforced cap', () => {
  const mismatch = checkGrants({ a: grant({ scope: 'Budget 0.50 USD per call.', limits: {} }) }, { now: NOW });
  assert.ok(mismatch.some((r) => r.check === 'budget' && r.level === 'warn'));
  const match = checkGrants({ a: grant({ scope: 'Budget 0,50 USD per call.', limits: { maxBudgetUsd: 0.5 } }) }, { now: NOW });
  assert.equal(match.some((r) => r.check === 'budget'), false);
});

test('findBrokenLinks ignores external links, anchors and code, and resolves relative to the file', () => {
  const files = { '/r/a.md': '[ok](b.md) [bad](missing.md) [web](https://x.y) [anchor](#top) `[code](nope.md)`\n```\n[fenced](gone.md)\n```' };
  const broken = findBrokenLinks(Object.keys(files), {
    read: (p) => files[p],
    exists: (p) => p.replace(/\\/g, '/').endsWith('/r/b.md'),
  });
  assert.deepEqual(broken.map((b) => b.target), ['missing.md']);
});

test('stale inflight files and locks are flagged; live or unknown ones are not', () => {
  const rows = checkLeftovers(
    [{ pid: 1, agent: 'a', alive: false }, { pid: 2, agent: 'b', alive: null }],
    [{ cwd: 'D:/t', pid: 3, alive: false }],
  );
  assert.equal(rows.length, 2);
  assert.equal(checkLeftovers([], [])[0].level, 'ok');
});

test('opencode mcp list output is parsed per server, and skipping is a warn', () => {
  const rows = checkOpencodeMcp('\x1b[32m✓\x1b[0m agent-hub   connected\n✗ playwright  failed');
  assert.equal(rows.find((r) => /agent-hub/.test(r.detail)).level, 'ok');
  assert.equal(rows.find((r) => /playwright/.test(r.detail)).level, 'fail');
  assert.equal(checkOpencodeMcp(null)[0].level, 'warn');
});

test('renderDoctor prints one line per check and a tally', () => {
  const text = renderDoctor({ counts: { ok: 1, warn: 0, fail: 1 }, checks: [
    { check: 'x', level: 'ok', detail: 'fine' },
    { check: 'y', level: 'fail', detail: 'broken' },
  ] });
  assert.match(text, /ok {4}x/);
  assert.match(text, /FAIL {2}y/);
  assert.match(text, /1 ok · 0 warn · 1 fail/);
});

test('the frozen zed codex adapter is a fail; notes do not count', () => {
  const zed = { agents: { codex: { command: 'npx', args: ['-y', '@zed-industries/codex-acp@0.16.0'] } } };
  assert.equal(checkCodexAdapter(zed)[0].level, 'fail');
  const good = { agents: { codex: {
    command: 'npx', args: ['-y', '@agentclientprotocol/codex-acp@2.6.0'],
    notes: 'replaces @zed-industries/codex-acp@0.16.0',
  } } };
  assert.equal(checkCodexAdapter(good)[0].level, 'ok');
  const unpinned = { agents: { codex: { command: 'npx', args: ['-y', '@agentclientprotocol/codex-acp'] } } };
  assert.equal(checkCodexAdapter(unpinned)[0].level, 'warn');
  assert.deepEqual(checkCodexAdapter({ agents: {} }), []);
});

test('latestCodexModels picks the highest version per family', () => {
  const cache = { models: [
    { slug: 'gpt-6.1-sol' }, { slug: 'gpt-6-sol' }, { slug: 'gpt-5.6-sol' },
    { slug: 'gpt-6-luna' }, { slug: 'gpt-5.6-luna' }, { slug: 'gpt-reserve' }, { slug: 'codex-auto-review' },
  ] };
  const latest = latestCodexModels(cache);
  assert.equal(latest.sol.slug, 'gpt-6.1-sol');
  assert.equal(latest.luna.slug, 'gpt-6-luna');
  assert.equal(latest.terra, undefined);
});

test('models.json behind the Codex cache is a warn; a missing cache is a warn, not a fail', () => {
  const catalog = { models: [{ id: 'gpt-6-sol', agent: 'codex' }] };
  const rows = checkCodexModels(catalog, { models: [{ slug: 'gpt-6.1-sol' }] });
  assert.equal(rows[0].level, 'warn');
  assert.match(rows[0].detail, /newest sol is gpt-6.1-sol/);
  assert.equal(checkCodexModels(catalog, { models: [{ slug: 'gpt-6-sol' }] })[0].level, 'ok');
  assert.equal(checkCodexModels(catalog, null)[0].level, 'warn');
});

test('a frontier model enabled for routing is a warn', () => {
  assert.equal(checkFrontier({ models: [{ id: 'opus', tier: 'frontier', enabled: true }] })[0].level, 'warn');
  assert.equal(checkFrontier({ models: [{ id: 'opus', tier: 'frontier', enabled: false }] })[0].level, 'ok');
});

test('an MCP server that is still starting is a warning, a failed one is a failure', () => {
  const rows = checkOpencodeMcp('✓ agent-hub   connected\n○ playwright  pending');
  assert.equal(rows.find((r) => /playwright/.test(r.detail)).level, 'warn');
  const failed = checkOpencodeMcp('✗ agent-hub   failed\n✓ playwright  connected');
  assert.equal(failed.find((r) => /agent-hub/.test(r.detail)).level, 'fail');
});

test('handoff freshness warns on a stale file or a vanished commit hash', () => {
  const H = 3_600_000;
  const fresh = checkHandoffFresh({ handoffMtimeMs: 100 * H, lastCommitMs: 110 * H, text: 'ultimo: `c0b1260`' });
  assert.deepEqual(fresh.map((r) => r.level), ['ok']);
  const stale = checkHandoffFresh({ handoffMtimeMs: 0, lastCommitMs: 30 * H });
  assert.match(stale[0].detail, /30h older/);
  const gone = checkHandoffFresh({ handoffMtimeMs: 0, lastCommitMs: 0, text: '`abc1234` y `bee1234f` y `plainword`', commitExists: (h) => h === 'abc1234' });
  assert.equal(gone.length, 1);
  assert.match(gone[0].detail, /bee1234f/);
  assert.deepEqual(checkHandoffFresh({ handoffMtimeMs: null }), []);
});
