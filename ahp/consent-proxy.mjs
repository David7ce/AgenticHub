#!/usr/bin/env node
// consent-proxy.mjs -- an ACP stdio proxy that keeps the hub's gate in front of an agent
// that a third-party host (the AHP gateway) starts on its own.
//
//   node consent-proxy.mjs --agent claude [--registry FILE] [--consent FILE]
//
// A host that launches ACP agents by itself would skip consent.json, the audit log and the
// spend caps. The gateway is configured to launch this proxy instead of the agent; the proxy
//   1. checks the grant (enabled, overseerAck, expiry, daily caps) and refuses to start the
//      agent when it does not pass,
//   2. starts the real command from the registry (same pinned version the hub uses) and
//      relays stdin/stdout/stderr, forwarding every line untouched unless a rule below applies,
//   3. writes one line to logs/runs.jsonl (transport "ahp") for every turn that ends, with the
//      stop reason and the cost that turn added. Per turn, not at exit: the host stops
//      providers abruptly, and an exit hook would never run,
//   4. applies the grant's limits to every session (permission-clamp.mjs): outside
//      `limits.writeTrees` the agent is forced into its restricted mode, because the gateway
//      relays permission requests but adds no gate, and agents in their default modes write
//      without asking (measured 2026-11-11).
// The start-up check uses the lowest non-deny level; the per-session check in the clamp
// decides whether a session may write.

import { pathToFileURL } from 'node:url';
import { CONSENT_PATH, readConsent, testConsent } from '../acp/consent.mjs';
import { DEFAULT_REGISTRY, LOG_PATH } from '../acp/hub-env.mjs';
import { killTree, spawnAgentProcess } from '../acp/process-utils.mjs';
import { loadRegistry, resolveAgent } from '../acp/registry.mjs';
import { nowIso, writeLog } from '../acp/run-record.mjs';
import { spentTodayAll, spentTokensToday } from '../acp/spend-estimate.mjs';
import { createClamp } from './permission-clamp.mjs';

export const EXIT_REFUSED = 3;
const NL = String.fromCharCode(10);

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

// The grant check. `permission: 'allow-reads'` is the lowest non-deny level; whether a
// session may write is decided per session by the clamp, but enabled, overseerAck, expiry
// and the daily caps apply to the agent as a whole.
export function checkGate({ agent, consent = CONSENT_PATH, logPath = LOG_PATH, spent = {} }) {
  return testConsent(agent, consent, {
    permission: 'allow-reads',
    spentToday: spent.usd ?? spentTodayAll(agent, logPath),
    spentTokensToday: spent.tokens ?? spentTokensToday(agent),
  });
}

// Cuts a byte stream into complete lines (ACP is one JSON object per line).
export function lineSplitter(onLine) {
  let buffer = '';
  return (chunk) => {
    buffer += chunk.toString('utf8');
    let nl;
    while ((nl = buffer.indexOf(NL)) >= 0) {
      const line = buffer.slice(0, nl).replace(/\r$/, '');
      buffer = buffer.slice(nl + 1);
      if (line.trim()) onLine(line);
    }
  };
}

const parse = (line) => {
  try {
    return JSON.parse(line);
  } catch {
    return null; // not JSON (an agent banner, say): forwarded as it is
  }
};

const send = (stream, value) => stream.write(`${typeof value === 'string' ? value : JSON.stringify(value)}${NL}`);

// What the proxy learns while the two sides talk. `onTurn` fires when the agent answers a
// session/prompt request, with what that turn added.
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
    process.stderr.write(`consent-proxy: ${error.message}${NL}`);
    return process.exit(2);
  }

  let resolved;
  try {
    resolved = resolveAgent(loadRegistry(opts.registry), opts.agent);
  } catch (error) {
    process.stderr.write(`consent-proxy: ${error.message}${NL}`);
    return process.exit(2);
  }

  const gate = checkGate({ agent: opts.agent, consent: opts.consent });
  if (!gate.ok) {
    process.stderr.write(`consent-proxy: ${opts.agent} refused by the hub gate: ${gate.reason}${NL}`);
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

  const grant = readConsent(opts.consent).grants?.[opts.agent];
  const clamp = createClamp({ agent: opts.agent, limits: grant?.limits, modes: resolved.permissionModes });

  // Client -> agent: observe, apply the clamp, forward the original line untouched.
  process.stdin.on('data', lineSplitter((line) => {
    const msg = parse(line);
    if (msg) stats.fromClient(msg);
    const verdict = msg ? clamp.fromClient(msg) : { forward: true };
    if (verdict.reply) send(process.stdout, verdict.reply);
    if (verdict.forward) send(child.stdin, line);
  }));
  // Agent -> client: observe, maybe rewrite, and send the clamp's own requests to the agent.
  child.stdout.on('data', lineSplitter((line) => {
    const msg = parse(line);
    if (msg) stats.fromAgent(msg);
    const verdict = msg ? clamp.fromAgent(msg) : { forward: true };
    if (verdict.forward) send(process.stdout, verdict.msg ?? line);
    for (const request of verdict.inject ?? []) send(child.stdin, request);
    if (verdict.answer) send(child.stdin, verdict.answer);
    if (verdict.failed) {
      process.stderr.write(`consent-proxy: could not restrict ${opts.agent}: ${verdict.failed}${NL}`);
      writeLog({ time: nowIso(), agent: opts.agent, transport: 'ahp', status: 'error', sessionId: verdict.sessionId, reason: `could not restrict: ${verdict.failed}` });
    }
  }));
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
