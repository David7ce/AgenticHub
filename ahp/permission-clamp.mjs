// permission-clamp.mjs -- keeps an agent inside what its consent grant allows when a
// third-party host (the AHP gateway) starts its sessions.
//
// Measured 2026-11-11: through the gateway OpenCode, Claude and Codex all wrote a file
// without asking (OpenCode "build", Claude "auto", Codex "agent" modes). AHP relays the
// permission requests an agent chooses to make; it adds no gate of its own, and the hub's
// own gate (`maxPermission`, `writeTrees`) only worked by answering such requests. So the
// proxy applies the grant itself, the way the hub does for its own runs: a session whose
// working directory is not under `limits.writeTrees` (or the scratch folder) is *restricted*.
//
// A restricted session is
//   - forced into the agent's restricted mode right after session/new|load|resume
//     (`session/set_config_option` sent by the proxy, its reply swallowed),
//   - shown to the client with the permissive modes removed (the response is rewritten),
//   - protected against a later switch to a mode outside the allowed list.
// An agent with no registered restricted mode cannot be restricted, so a restricted session
// is refused outright (fail closed) instead of being left unguarded.
//
// Registry entry:  "permissionModes": { "restricted": { "force": "plan", "allow": ["plan"] } }

import { checkLimits } from '../acp/consent.mjs';

const OPEN_METHODS = new Set(['session/new', 'session/load', 'session/resume']);
const MODE_OPTION = 'mode';
// Permission requests that would change something (or leave the restricted mode) are answered
// no in a restricted session instead of being put to the person: ACP tool kinds.
const DENIED_KINDS = new Set(['edit', 'delete', 'move', 'execute', 'switch_mode']);

export function createClamp({ agent, limits, modes, check = checkLimits }) {
  const restrictedRule = modes?.restricted ?? null;
  const pending = new Map(); // JSON-RPC id of an open request -> { restricted, sessionId }
  const sessions = new Map(); // sessionId -> { force, allow:Set }
  const injected = new Map(); // id of a request the proxy itself sent -> its sessionId
  const broken = new Set(); // sessions where setting the restricted mode failed: they must not run
  let counter = 0;

  const error = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

  // Same rule as the hub: allow-all needs the cwd under writeTrees (or the scratch folder).
  const isRestricted = (cwd) => !check(limits, { permission: 'allow-all', cwd }).ok;

  function rewriteModeOption(options, rule) {
    const allow = new Set(rule.allow);
    return options.map((option) => {
      if (option?.id !== MODE_OPTION) return option;
      const keep = (list) => list.filter((entry) => allow.has(entry.value ?? entry.id));
      const filtered = (option.options ?? []).map((group) =>
        group?.options ? { ...group, options: keep(group.options) } : group);
      const flat = filtered.some((entry) => entry?.options) ? filtered : keep(filtered);
      return { ...option, currentValue: rule.force, options: flat };
    });
  }

  return {
    // client -> agent. Returns { forward, reply? }: `reply` goes back to the client.
    fromClient(msg) {
      if (msg.method && OPEN_METHODS.has(msg.method) && msg.id != null) {
        const cwd = msg.params?.cwd;
        if (!isRestricted(cwd)) {
          pending.set(msg.id, { restricted: false });
          return { forward: true };
        }
        if (!restrictedRule) {
          return {
            forward: false,
            reply: error(msg.id, -32000,
              `consent: ${agent} may not write in ${cwd} (not under writeTrees) and has no restricted mode registered`),
          };
        }
        pending.set(msg.id, { restricted: true, sessionId: msg.params?.sessionId ?? null });
        return { forward: true };
      }
      if (msg.method === 'session/prompt' && broken.has(msg.params?.sessionId) && msg.id != null) {
        return {
          forward: false,
          reply: error(msg.id, -32000, `consent: could not put ${agent} in its restricted mode for this session, so it will not run`),
        };
      }
      const wanted = msg.method === 'session/set_config_option' && msg.params?.configId === MODE_OPTION
        ? msg.params.value
        : msg.method === 'session/set_mode' ? msg.params?.modeId : undefined;
      if (wanted !== undefined) {
        const session = sessions.get(msg.params?.sessionId);
        if (session && !session.allow.has(wanted)) {
          return {
            forward: false,
            reply: error(msg.id, -32602, `consent: mode "${wanted}" is not allowed for ${agent} here (allowed: ${[...session.allow].join(', ')})`),
          };
        }
      }
      return { forward: true };
    },

    // agent -> client. Returns { forward, msg?, inject?, answer? }: `msg` replaces the line,
    // `inject` lists requests the proxy sends to the agent, `answer` replies to an agent
    // request on the client's behalf.
    fromAgent(msg) {
      if (msg.id != null && injected.has(msg.id) && msg.method === undefined) {
        const sessionId = injected.get(msg.id);
        injected.delete(msg.id);
        const failed = 'error' in msg ? msg.error?.message ?? 'error' : null;
        if (failed) broken.add(sessionId); // fail closed: the UI shows the restricted mode, the agent is not in it
        return { forward: false, failed, sessionId };
      }
      // A restricted agent asking to change something, or to leave its mode (Claude's
      // "Approve Plan" is a `switch_mode` request, Codex asks before an edit): answer no here
      // instead of asking the person, so the session cannot widen its own grant.
      if (msg.method === 'session/request_permission' && msg.id != null
        && sessions.has(msg.params?.sessionId) && DENIED_KINDS.has(msg.params?.toolCall?.kind)) {
        const options = msg.params.options ?? [];
        const reject = options.find((o) => o.kind === 'reject_once') ?? options.find((o) => o.kind === 'reject_always');
        return {
          forward: false,
          answer: {
            jsonrpc: '2.0',
            id: msg.id,
            result: { outcome: reject ? { outcome: 'selected', optionId: reject.optionId } : { outcome: 'cancelled' } },
          },
        };
      }
      if (msg.id == null || msg.method !== undefined || !pending.has(msg.id)) return { forward: true };
      const open = pending.get(msg.id);
      pending.delete(msg.id);
      if (!open.restricted || !('result' in msg)) return { forward: true };

      const sessionId = msg.result?.sessionId ?? open.sessionId;
      if (!sessionId) return { forward: true };
      sessions.set(sessionId, { force: restrictedRule.force, allow: new Set(restrictedRule.allow) });

      const result = { ...msg.result };
      if (Array.isArray(result.configOptions)) result.configOptions = rewriteModeOption(result.configOptions, restrictedRule);
      const id = `hubproxy-${++counter}`;
      injected.set(id, sessionId);
      return {
        forward: true,
        msg: { ...msg, result },
        inject: [{
          jsonrpc: '2.0',
          id,
          method: 'session/set_config_option',
          params: { sessionId, configId: MODE_OPTION, value: restrictedRule.force },
        }],
      };
    },

    restrictedSessions: () => sessions.size,
  };
}
