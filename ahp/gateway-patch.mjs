// gateway-patch.mjs -- two local changes to the third-party AHP-ACP gateway, applied by
// gateway-run.mjs to its GatewayServer class (no file of the package is edited).
//
// 1. createSession becomes idempotent. VS Code's Agents window asked the gateway to create
//    a session it had already created (seen 2026-11-11: the session existed, ready, with no
//    turn, and the first message failed with "Session already exists"). The gateway answers
//    that with an error, because creating one waits for the agent to start (3-4 s). A repeat
//    of the same request is answered as the first one would be: success once the session is
//    ready. A repeat that names a different provider still gets the gateway's own error.
// 2. subscribe declines windowed delivery instead of failing. The spec (Windowed Delivery,
//    Negotiation) lets a client offer `flowControl` and says the subscription uses it only if the
//    server accepts; otherwise it uses ordinary delivery. The gateway answers the offer with an
//    error ("Windowed subscriptions are not implemented"), and VS Code then retried without end:
//    41,000 failed subscribes in 2.5 minutes (2026-11-11), the window listing nothing. Declining is
//    dropping the offer and subscribing as usual; the result carries no `flowControl`.
// 3. A session config change that carries a field the agent does not declare is applied for the
//    fields it does declare. VS Code's Agents window sends `sensitiveEditLocations` together with
//    the mode, and the gateway rejects the whole update ("Unknown or immutable session config
//    sensitiveEditLocations"), so a session asked for build stays in plan (measured 2026-11-12,
//    OpenCode over AHP). An unknown field is dropped and `session/configChanged` keeps the rest;
//    a known but immutable field still rejects, because that is what immutable means.
// 4. Every request is logged (method, id, session suffix, parameter names, duration, error):
//    never message text or parameter values, so the log says who asks for what and when
//    without keeping conversations. The action type of dispatchAction (a protocol name such as
//    chat/turnStarted) is kept. Identical requests within one second collapse into one line
//    with a count, because a client in a retry loop sends well over a hundred a second.

import { appendFileSync, renameSync, statSync } from 'node:fs';

/** Appends a line to a log, first moving a log that reached `maxBytes` to `<path>.prev` (one generation kept). */
export function appendRotating(path, text, { maxBytes = 2 * 1024 * 1024 } = {}) {
  try {
    if (statSync(path).size >= maxBytes) renameSync(path, `${path}.prev`);
  } catch { /* no log yet */ }
  appendFileSync(path, text);
}

const sleepMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const suffix = (uri) => (typeof uri === 'string' ? uri.slice(-8) : undefined);

export function patchGateway(Server, { log = () => {}, waitMs = 30_000, pollMs = 100, retryMs = 500, sleep = sleepMs } = {}) {
  // Fail loudly instead of starting a half-patched host: if a rename upstream takes one of these away,
  // the window would otherwise get a gateway with no gate on the mode, or with an endless retry storm.
  for (const method of ['createSession', 'handle']) {
    if (typeof Server.prototype[method] !== 'function') {
      throw new Error(`gateway-patch: ${method} is gone from this gateway version; re-check the patches in ahp/gateway-patch.mjs`);
    }
  }
  const createSession = Server.prototype.createSession;
  Server.prototype.createSession = async function patchedCreateSession(connection, params) {
    const channel = params?.channel;
    // A provider that fails to start is retried once: seen 2026-11-12, two createSession calls
    // 0.7 s apart both failed ("ACP provider OpenCode (opencode) failed (reference …)") and the next
    // one worked, leaving the window with an empty draft. One retry covers that race; a real
    // failure (refused grant, missing binary) fails again and is reported as before.
    const attempt = async () => {
      try {
        return await createSession.call(this, connection, params);
      } catch (error) {
        if (!/failed \(reference /.test(String(error?.message ?? ''))) throw error;
        log({ event: 'createSession-retry', session: suffix(channel), provider: params?.provider, reason: String(error.message).slice(0, 120) });
        await sleep(retryMs);
        return createSession.call(this, connection, params);
      }
    };

    const existing = typeof channel === 'string' ? this.store.getSession(channel) : null;
    if (!existing) return attempt();
    if (params?.provider && params.provider !== existing.provider) return attempt();

    log({ event: 'createSession-repeat', session: suffix(channel), lifecycle: existing.state?.lifecycle, provider: existing.provider });
    const deadline = Date.now() + waitMs;
    while (this.store.getSession(channel)?.state?.lifecycle === 'creating' && Date.now() < deadline) {
      await sleep(pollMs);
    }
    const now = this.store.getSession(channel);
    if (now?.state?.lifecycle === 'ready') return null;
    return attempt(); // gone or failed: the gateway's own answer
  };

  const subscribe = Server.prototype.subscribe;
  if (typeof subscribe === 'function') {
    Server.prototype.subscribe = async function patchedSubscribe(connection, params) {
      if (params && params.flowControl !== undefined) {
        const { flowControl: _declined, ...rest } = params;
        return subscribe.call(this, connection, rest);
      }
      return subscribe.call(this, connection, params);
    };
  }

  const dispatchSessionConfig = Server.prototype.dispatchSessionConfig;
  if (typeof dispatchSessionConfig === 'function') {
    Server.prototype.dispatchSessionConfig = async function patchedDispatchSessionConfig(sessionResource, action, origin) {
      const config = action?.config;
      const schema = this.store?.getSession?.(sessionResource)?.state?.config?.schema?.properties;
      if (schema && config && typeof config === 'object') {
        const kept = {};
        const dropped = [];
        for (const [configId, value] of Object.entries(config)) {
          if (schema[configId]) kept[configId] = value; else dropped.push(configId);
        }
        if (dropped.length) {
          log({ event: 'config-drop', session: suffix(sessionResource), dropped });
          action = { ...action, config: kept };
        }
      }
      return dispatchSessionConfig.call(this, sessionResource, action, origin);
    };
  }

  const handle = Server.prototype.handle;
  const recent = new Map(); // key -> { second, suppressed }
  Server.prototype.handle = async function patchedHandle(connection, request) {
    const startedAt = Date.now();
    const entry = {
      event: 'rpc',
      method: request?.method,
      id: request?.id,
      channel: suffix(request?.params?.channel),
      keys: request?.params && typeof request.params === 'object' ? Object.keys(request.params).slice(0, 12) : undefined,
    };
    if (request?.method === 'dispatchAction' && typeof request.params?.action?.type === 'string') {
      entry.action = request.params.action.type;
    }
    // Collapse a burst of identical requests: one line per second per (method, channel, action).
    const key = `${entry.method}|${entry.channel}|${entry.action}`;
    const second = Math.floor(startedAt / 1000);
    const seen = recent.get(key);
    const quiet = seen?.second === second;
    if (quiet) seen.suppressed++;
    else {
      entry.repeated = seen?.suppressed || undefined;
      recent.set(key, { second, suppressed: 0 });
      // One key per (method, session, action): without this the map grows with every session the gateway ever served.
      if (recent.size > 256) for (const [k, v] of recent) if (v.second < second - 60) recent.delete(k);
    }
    // A session config change (mode, effort...) is a setting, not conversation: keep what was asked,
    // what the session holds afterwards, and the reason when the gateway rejected it (a rejection is
    // only broadcast, never thrown, so without this it would leave no trace).
    const isConfig = entry.action === 'session/configChanged';
    let rejection = null;
    const store = this.store;
    const reject = isConfig && typeof store?.reject === 'function' ? store.reject : null;
    if (reject) {
      entry.asked = JSON.stringify(request.params.action.config ?? null).slice(0, 160);
      store.reject = function patchedReject(...args) { rejection = args[3] ?? 'rejected'; return reject.apply(this, args); };
    }
    const settle = () => {
      if (!reject) return;
      store.reject = reject;
      entry.after = JSON.stringify(store.getSession?.(request.params.channel)?.state?.config?.values ?? null).slice(0, 160);
      if (rejection) entry.rejected = String(rejection).slice(0, 160);
    };
    // A successful ping says nothing (VS Code sends one every five seconds); a failed one still logs below.
    const write = (extra) => { if (!quiet && entry.method !== 'ping') log({ ...entry, ...extra, ms: Date.now() - startedAt }); };
    try {
      const result = await handle.call(this, connection, request);
      settle();
      write({});
      return result;
    } catch (error) {
      settle();
      log({ ...entry, ms: Date.now() - startedAt, error: String(error?.message ?? error).slice(0, 160) }); // errors always
      throw error;
    }
  };
  Server.prototype.handle.recentSize = () => recent.size; // for the test that the map stays bounded
}
