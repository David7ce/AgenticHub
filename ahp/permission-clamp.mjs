// permission-clamp.mjs -- keeps an agent inside what its consent grant allows when a
// third-party host (the AHP gateway) starts its sessions.
//
// Measured 2026-11-11: through the gateway OpenCode, Claude and Codex all wrote a file
// without asking (OpenCode "build", Claude "auto", Codex "agent" modes). AHP relays the
// permission requests an agent chooses to make; it adds no gate of its own, and the hub's
// own gate (`maxPermission`, `writeTrees`) only worked by answering such requests. So the
// proxy applies the grant itself, the way the hub does for its own runs.
//
// A session is attended (a person is in VS Code) and falls in one of two classes:
//
// - open: its working directory is under the writable trees (`limits.attendedWriteTrees`
//   when the grant has it, else `limits.writeTrees`, plus the scratch folder). If the agent has
//   a registered `attended` mode the proxy puts the session in it ("edit freely, ask before
//   commands" where the agent can do that) and hides the modes outside its allow-list.
// - restricted: anywhere else. The agent is forced into its `restricted` mode, the client only
//   sees the allowed modes, a later switch is refused, and permission requests that would edit,
//   delete, move, execute or leave the mode are answered no instead of being put to the person.
//   An agent with no registered restricted mode cannot be restricted, so such a session is
//   refused outright (fail closed). If the mode cannot be set, every prompt is refused.
//
// Registry entry:
//   "permissionModes": {
//     "restricted": { "force": "plan", "allow": ["plan"] },
//     "attended":   { "force": "acceptEdits", "allow": ["default", "acceptEdits", "plan"] }
//   }

import { checkLimits } from '../acp/consent.mjs';

const OPEN_METHODS = new Set(['session/new', 'session/load', 'session/resume']);
const MODE_OPTION = 'mode';
// Permission requests that would change something (or leave the restricted mode) are answered
// no in a restricted session instead of being put to the person: ACP tool kinds.
const DENIED_KINDS = new Set(['edit', 'delete', 'move', 'execute', 'switch_mode']);

export function createClamp({ agent, limits, modes, check = checkLimits }) {
  const restrictedRule = modes?.restricted ?? null;
  const attendedRule = modes?.attended ?? null;
  const pending = new Map(); // JSON-RPC id of an open request -> { restricted, sessionId }
  const sessions = new Map(); // sessionId -> { restricted, allow:Set }
  const injected = new Map(); // id of a request the proxy itself sent -> its sessionId
  const broken = new Set(); // sessions where setting the mode failed: they must not run
  let counter = 0;

  const error = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

  // Same rule as the hub (allow-all needs the cwd under the writable trees or the scratch
  // folder), with the attended trees taking the place of writeTrees when the grant has them.
  const writable = limits?.attendedWriteTrees ?? limits?.writeTrees;
  const isRestricted = (cwd) => !check(limits ? { ...limits, writeTrees: writable } : limits, { permission: 'allow-all', cwd }).ok;

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
        const sessionId = msg.params?.sessionId ?? null;
        if (!isRestricted(cwd)) {
          pending.set(msg.id, { restricted: false, sessionId });
          return { forward: true };
        }
        if (!restrictedRule) {
          return {
            forward: false,
            reply: error(msg.id, -32000,
              `consent: ${agent} may not write in ${cwd} (not under its writable trees) and has no restricted mode registered`),
          };
        }
        pending.set(msg.id, { restricted: true, sessionId });
        return { forward: true };
      }
      if (msg.method === 'session/prompt' && broken.has(msg.params?.sessionId) && msg.id != null) {
        return {
          forward: false,
          reply: error(msg.id, -32000, `consent: could not put ${agent} in its required mode for this session, so it will not run`),
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
        if (failed) broken.add(sessionId); // fail closed: the UI shows the mode, the agent is not in it
        return { forward: false, failed, sessionId };
      }
      // A restricted agent asking to change something, or to leave its mode (Claude's
      // "Approve Plan" is a `switch_mode` request, Codex asks before an edit): answer no here
      // instead of asking the person, so the session cannot widen its own grant.
      if (msg.method === 'session/request_permission' && msg.id != null
        && sessions.get(msg.params?.sessionId)?.restricted && DENIED_KINDS.has(msg.params?.toolCall?.kind)) {
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
      const rule = open.restricted ? restrictedRule : attendedRule;
      if (!rule || !('result' in msg)) return { forward: true };

      const sessionId = msg.result?.sessionId ?? open.sessionId;
      if (!sessionId) return { forward: true };
      sessions.set(sessionId, { restricted: open.restricted, allow: new Set(rule.allow) });

      const result = { ...msg.result };
      if (Array.isArray(result.configOptions)) result.configOptions = rewriteModeOption(result.configOptions, rule);
      const id = `hubproxy-${++counter}`;
      injected.set(id, sessionId);
      return {
        forward: true,
        msg: { ...msg, result },
        inject: [{
          jsonrpc: '2.0',
          id,
          method: 'session/set_config_option',
          params: { sessionId, configId: MODE_OPTION, value: rule.force },
        }],
      };
    },

    restrictedSessions: () => [...sessions.values()].filter((s) => s.restricted).length,
  };
}
