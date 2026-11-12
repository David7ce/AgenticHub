// model-filter.mjs -- narrows the model list a third-party host (the AHP gateway) shows for an
// agent to the models the person wants to use there.
//
// Why: OpenCode exposes two catalogues side by side. `opencode/*` is Zen, billed per token, and
// carries claude-*, gpt-* and gemini-* models that duplicate the Claude and Codex agents and the
// flat plan does not cover. `opencode-go/*` is the flat Go plan. Offering both in one picker made
// the list 76 entries long and let a session spend per-token money by accident.
//
// Registry entry (acp/agents.json):
//   "modelPolicy": { "allow": ["opencode-go/"], "default": "opencode-go/deepseek-v4.1-flash" }
//
// - allow: model ids must start with one of these prefixes to be offered or selected.
// - default: where a session whose current model is not allowed is moved (else the first allowed).
// Only the picker changes: the hub's own runs keep their consent rules. Like the permission clamp,
// the proxy also refuses a later switch to a model outside the list, since a client can send one
// without going through the picker.

const OPEN_METHODS = new Set(['session/new', 'session/load', 'session/resume']);
const MODEL_OPTION = 'model';

export function createModelFilter({ agent, policy }) {
  const prefixes = Array.isArray(policy?.allow) ? policy.allow.filter((p) => typeof p === 'string' && p) : [];
  const active = prefixes.length > 0;
  const allowed = (id) => typeof id === 'string' && prefixes.some((p) => id.startsWith(p));
  const pending = new Map(); // JSON-RPC id of an open request -> sessionId (may be null)
  const injected = new Set(); // ids of requests the proxy sent itself
  let counter = 0;

  const error = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

  const keep = (list) => list.filter((entry) => allowed(entry?.value ?? entry?.id));

  function rewrite(options, sessionId) {
    let wrong = null; // the model the session must be moved to, if its current one is not allowed
    const out = options.map((option) => {
      if (option?.id !== MODEL_OPTION) return option;
      const filtered = (option.options ?? []).map((group) => (group?.options ? { ...group, options: keep(group.options) } : group));
      const grouped = filtered.some((entry) => entry?.options);
      const flat = grouped ? filtered.filter((g) => !g?.options || g.options.length) : keep(filtered);
      const values = (grouped ? flat.flatMap((g) => g.options ?? []) : flat).map((e) => e.value ?? e.id);
      let current = option.currentValue;
      if (!allowed(current)) {
        const target = allowed(policy.default) && values.includes(policy.default) ? policy.default : values[0];
        if (target !== undefined) {
          wrong = target;
          current = target;
        }
      }
      return { ...option, currentValue: current, options: flat };
    });
    return { options: out, move: wrong, sessionId };
  }

  return {
    active,
    // client -> agent: { forward, reply? }
    fromClient(msg) {
      if (!active) return { forward: true };
      if (msg.method && OPEN_METHODS.has(msg.method) && msg.id != null) {
        pending.set(msg.id, msg.params?.sessionId ?? null);
        return { forward: true };
      }
      const wanted = msg.method === 'session/set_config_option' && msg.params?.configId === MODEL_OPTION
        ? msg.params.value
        : msg.method === 'session/set_model' ? msg.params?.modelId : undefined;
      if (wanted !== undefined && !allowed(wanted)) {
        return {
          forward: false,
          reply: error(msg.id, -32602, `consent: model "${wanted}" is not offered for ${agent} here (allowed prefixes: ${prefixes.join(', ')})`),
        };
      }
      return { forward: true };
    },
    // agent -> client: { swallow } for the proxy's own request answers, else { msg?, inject? }
    // where `msg` replaces the line (already parsed) and `inject` lists requests for the agent.
    fromAgent(msg) {
      if (!active) return {};
      if (msg.id != null && msg.method === undefined && injected.has(msg.id)) {
        injected.delete(msg.id);
        return { swallow: true };
      }
      if (msg.id == null || msg.method !== undefined || !pending.has(msg.id) || !('result' in msg)) return {};
      const open = pending.get(msg.id);
      pending.delete(msg.id);
      if (!Array.isArray(msg.result?.configOptions)) return {};
      const sessionId = msg.result.sessionId ?? open;
      const { options, move } = rewrite(msg.result.configOptions, sessionId);
      const out = { msg: { ...msg, result: { ...msg.result, configOptions: options } } };
      if (move !== null && sessionId) {
        const id = `hubproxy-model-${++counter}`;
        injected.add(id);
        out.inject = [{ jsonrpc: '2.0', id, method: 'session/set_config_option', params: { sessionId, configId: MODEL_OPTION, value: move } }];
      }
      return out;
    },
  };
}
