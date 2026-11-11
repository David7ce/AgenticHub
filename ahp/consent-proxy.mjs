#!/usr/bin/env node
// consent-proxy.mjs -- an ACP stdio proxy that keeps the hub's gate in front of
// an agent that a third-party host (the AHP gateway) starts on its own.
//
//   node consent-proxy.mjs --agent claude [--registry FILE] [--consent FILE]
//
// A host that launches ACP agents by itself would skip consent.json, the audit
// log and the spend caps. The gateway is configured to launch this proxy
// instead of the agent; the proxy
//   1. checks the grant (enabled, overseerAck, expiry, daily caps) and refuses
//      to start the agent when it does not pass,
//   2. starts the real command from the registry (same pinned version the hub
//      uses) and pipes stdin/stdout/stderr through untouched,
//   3. watches the JSON lines without changing them and writes one line to
//      logs/runs.jsonl (transport "ahp") for every turn that ends, with the stop
//      reason and the cost that turn added. Per turn, not at exit: the host
//      stops providers abruptly, and an exit hook would never run.
// Permission requests are not auto-answered here: the AHP client (VS Code)
// shows them to the person, which is what the grant's maxPermission would
// otherwise stand in for, so the check uses the lowest non-deny level.

import { pathToFileURL } from 'node:url';
import { CONSENT_PATH, testConsent } from '../acp/consent.mjs';
import { DEFAULT_REGISTRY, LOG_PATH } from '../acp/hub-env.mjs';
import { killTree, spawnAgentProcess } from '../acp/process-utils.mjs';
import { loadRegistry, resolveAgent } from '../acp/registry.mjs';
import { nowIso, writeLog } from '../acp/run-record.mjs';
import { spentTodayAll, spentTokensToday } from '../acp/spend-estimate.mjs';

export const EXIT_REFUSED = 3;

export function parseArgs(argv) {
  const out = { agent: null, registry: DEFAULT_REGISTRY, consent: CONSENT_PATH };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--agent') out.agent = argv[++i];
    else if (flag === '--registry') out.registry = argv[++i];
    else if (flag === '--consent') out.consent = argv[++i];
    else throw new Error(`unknown argument: ${flag}`);
  }
  if (!out.agent) throw new Error('--agent NAME is required');
  return out;
}

// The grant check. `permission: 'allow-reads'` is the lowest non-deny level: the
// person answers each permission request in the client, so maxPermission and
// writeTrees (which bound unattended runs) are not what limits this path, but
// enabled, overseerAck, expiry and the daily caps still are.
export function checkGate({ agent, consent = CONSENT_PATH, logPath = LOG_PATH, spent = {} }) {
  return testConsent(agent, consent, {
    permission: 'allow-reads',
    spentToday: spent.usd ?? spentTodayAll(agent, logPath),
    spentTokensToday: spent.tokens ?? spentTokensToday(agent),
  });
}

// Splits a byte stream into JSON lines for observation only; never alters it.
export function lineTap(onMessage) {
  let buffer = '';
  return (chunk) => {
    buffer += chunk.toString('utf8');
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      try {
        onMessage(JSON.parse(line));
      } catch {
        // Not JSON (an agent banner, say): nothing to learn from it.
      }
    }
  };
}

// What the proxy learns while the two sides talk. `onTurn` fires when the agent
// answers a session/prompt request, with what that turn added.
export function createStats({ onTurn = () => {} } = {}) {
  const pending = new Map(); // JSON-RPC id of a session/prompt -> sessionId
  const costBySession = new Map();
  let logged = 0;
  const total = () => [...costBySession.values()].reduce((sum, c) => sum + c.amount, 0);
  const stats = {
    cwd: null,
    sessions: 0,
    turns: 0,
    fromClient(msg) {
      if (msg.method === 'session/new') {
        stats.sessions++;
        stats.cwd ??= msg.params?.cwd ?? null;
      } else if (msg.method === 'session/prompt' && msg.id != null) {
        pending.set(msg.id, msg.params?.sessionId ?? null);
      }
    },
    fromAgent(msg) {
      const update = msg.method === 'session/update' ? msg.params?.update : null;
      const amount = update?.sessionUpdate === 'usage_update' ? update.cost?.amount : undefined;
      if (Number.isFinite(amount)) {
        costBySession.set(msg.params?.sessionId ?? '', { amount, currency: update.cost.currency ?? 'USD' });
      }
      if (msg.method === undefined && msg.id != null && pending.has(msg.id) && ('result' in msg || 'error' in msg)) {
        const sessionId = pending.get(msg.id);
        pending.delete(msg.id);
        stats.turns++;
        // usage_update costs are cumulative per session: a turn adds the difference.
        const now = total();
        const turnCost = Math.max(0, now - logged);
        logged = now;
        const currency = [...costBySession.values()][0]?.currency ?? 'USD';
        onTurn({
          sessionId,
          stopReason: msg.result?.stopReason ?? null,
          error: msg.error?.message ?? null,
          cost: turnCost > 0 ? { amount: Number(turnCost.toFixed(6)), currency } : null,
        });
      }
    },
  };
  return stats;
}

export function turnRecord({ agent, turn, stats, startedAt }) {
  const record = {
    time: nowIso(),
    agent,
    transport: 'ahp',
    status: turn.error ? 'error' : 'ok',
    cwd: stats.cwd,
    stopReason: turn.stopReason,
    sessionId: turn.sessionId,
    turn: stats.turns,
    uptimeMs: Date.now() - startedAt,
  };
  if (turn.error) record.reason = turn.error;
  if (turn.cost) record.cost = turn.cost;
  return record;
}

export function main(argv = process.argv.slice(2)) {
  const startedAt = Date.now();
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`consent-proxy: ${error.message}\n`);
    return process.exit(2);
  }

  let resolved;
  try {
    resolved = resolveAgent(loadRegistry(opts.registry), opts.agent);
  } catch (error) {
    process.stderr.write(`consent-proxy: ${error.message}\n`);
    return process.exit(2);
  }

  const gate = checkGate({ agent: opts.agent, consent: opts.consent });
  if (!gate.ok) {
    process.stderr.write(`consent-proxy: ${opts.agent} refused by the hub gate: ${gate.reason}\n`);
    writeLog({ time: nowIso(), agent: opts.agent, transport: 'ahp', status: 'refused', reason: gate.reason });
    return process.exit(EXIT_REFUSED);
  }

  const stats = createStats({
    onTurn: (turn) => writeLog(turnRecord({ agent: opts.agent, turn, stats, startedAt })),
  });
  const child = spawnAgentProcess({
    command: resolved.command,
    args: resolved.args,
    cwd: process.cwd(),
    env: { ...process.env, ...resolved.env },
  });

  let finished = false;
  const finish = (status, code, reason) => {
    if (finished) return;
    finished = true;
    // Turns are logged as they end; at exit only a failure that never got that far.
    if (status === 'error' && stats.turns === 0) {
      writeLog({ time: nowIso(), agent: opts.agent, transport: 'ahp', status, reason, exitCode: code, uptimeMs: Date.now() - startedAt });
    }
    process.exit(code ?? 1);
  };

  const watchClient = lineTap((msg) => stats.fromClient(msg));
  const watchAgent = lineTap((msg) => stats.fromAgent(msg));
  process.stdin.on('data', watchClient);
  child.stdout.on('data', watchAgent);
  process.stdin.pipe(child.stdin);
  child.stdout.pipe(process.stdout);
  child.stderr.pipe(process.stderr);

  child.stdin.on('error', () => {}); // the agent may exit before we stop writing
  child.on('error', (error) => finish('error', 1, error.message));
  child.on('exit', (code, signal) => finish(code === 0 ? 'ok' : 'error', code ?? 1, signal ? `signal ${signal}` : null));

  // The host closing our stdin or signalling us must not leave the agent behind.
  const stop = () => {
    killTree(child);
    finish('stopped', 0, null);
  };
  process.stdin.on('end', stop);
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
