// run-record.mjs — what a run leaves behind: the audit line, the in-flight
// file while it runs, the salvage record when it fails, and the live
// summary of the agent's updates.

import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { INFLIGHT_DIR, LOG_PATH, RESULTS_DIR } from './hub-env.mjs';
import { rotateIfNeeded } from './log-rotation.mjs';
import { redact } from './redact.mjs';

export function nowIso() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function stamp(date = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return (
    `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-` +
    `${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`
  );
}

export function truncate(text, max) {
  if (!text) return '';
  return text.length > max ? text.slice(0, max) + '...[truncated]' : text;
}

export function writeLog(record) {
  mkdirSync(dirname(LOG_PATH), { recursive: true });
  rotateIfNeeded(LOG_PATH);
  appendFileSync(LOG_PATH, JSON.stringify(record) + '\n', 'utf8');
}

// ── in-flight record ────────────────────────────────────────────────────────
//
// One tiny file per running hub-acp, deleted on exit. It is the only place
// that says "this agent is working in this tree right now" while the turn is
// still going; see INFLIGHT_DIR above.

export function inflightPath() {
  return join(INFLIGHT_DIR, `${process.pid}.json`);
}

export function writeInflight({ agent, cwd, started, sessionId, state, prompt, model }) {
  try {
    mkdirSync(INFLIGHT_DIR, { recursive: true });
    const tools = [...state.tools.values()];
    const last = tools.length ? tools[tools.length - 1] : null;
    const body = {
      pid: process.pid,
      platform: process.platform,
      agent: agent.name,
      cwd,
      started,
      updated: new Date().toISOString(),
      sessionId: sessionId ?? null,
      model: model ?? null,
      requestedMode: state.requestedMode ?? null,
      reportedMode: state.reportedMode ?? null,
      modeSource: state.modeSource ?? null,
      // Set by the MCP server when this run is a background job: the terminal
      // view can then name the same job the chat collects.
      jobId: process.env.AGENT_HUB_JOB_ID ?? null,
      toolCount: tools.length,
      // Titles come from the agent and can be multi-line shell snippets; keep
      // the status line one line. Redact before slicing, so a key cut at the
      // 80-char boundary cannot survive as a fragment.
      lastTool: last
        ? `${redact(String(last.title).replace(/\s+/g, ' ').trim()).slice(0, 80)} (${last.status})`
        : null,
      // Truncate before redact (it is slow on long input), but slice wider than the
      // 600 kept so a secret cut at the boundary is whole when redacted.
      recentText: redact(String(state.text ?? '').slice(-1200)).slice(-600),
      // A held `ask` request, so a terminal view can show what is waiting and
      // for how long. The MCP server computes the same shape for job_status.
      pendingPermission: state.pendingPermission
        ? {
            requestId: state.pendingPermission.requestId,
            title: state.pendingPermission.title,
            toolKind: state.pendingPermission.toolKind,
            locations: state.pendingPermission.locations ?? [],
            heldMs: Math.max(0, Date.now() - (state.pendingPermission.heldSince ?? Date.now())),
          }
        : null,
      pendingPermissionCount: state.pendingCount ?? 0,
      // How full the context window is right now: the live view of the number
      // that dominates a turn's cost. Null when the adapter reports no window.
      context: state.contextPeak
        ? { used: state.contextPeak, size: state.contextSize || null, limit: state.contextLimit || null }
        : null,
      // Redact before truncating, or a key cut at the 200-char boundary would
      // survive as a fragment. The slice is wider than the 200 kept for the
      // same reason recentText's is (see above), and it bounds the redact.
      prompt: prompt
        ? truncate(redact(prompt.replace(/\s+/g, ' ').slice(0, 400)), 200)
        : null,
    };
    writeFileSync(inflightPath(), JSON.stringify(body) + '\n', 'utf8');
  } catch {
    // Visibility is a convenience: never let it fail a run.
  }
}

export function clearInflight() {
  try {
    unlinkSync(inflightPath());
  } catch {}
}

// ── salvage record ──────────────────────────────────────────────────────────
//
// A failed or timed-out run that had write access leaves work behind. The
// caller's next question is always "what did it touch?" — answer it here
// instead of making a human reconstruct it from the transcript.

export function runGit(cwd, args) {
  try {
    const result = spawnSync('git', ['-C', cwd, ...args], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 15_000,
    });
    return result.status === 0 ? result.stdout.trim() : null;
  } catch {
    return null;
  }
}

export function writeSalvage({ agent, status, nativeCwd, sessionId, failure }) {
  const head = runGit(nativeCwd, ['rev-parse', '--short', 'HEAD']);
  if (!head) return null; // not a git tree: nothing useful to record
  const porcelain = runGit(nativeCwd, ['status', '--porcelain']) ?? '';
  const dirty = porcelain
    ? porcelain.split('\n').filter(Boolean).slice(0, 100).map((line) => line.trim())
    : [];
  const body = {
    time: nowIso(),
    agent: agent.name,
    status,
    cwd: nativeCwd,
    sessionId: sessionId ?? null,
    error: failure?.message ? redact(String(failure.message)) : null,
    head,
    branch: runGit(nativeCwd, ['rev-parse', '--abbrev-ref', 'HEAD']),
    dirtyCount: dirty.length,
    dirty,
    diffstat: runGit(nativeCwd, ['diff', '--stat']) ?? '',
  };
  try {
    mkdirSync(RESULTS_DIR, { recursive: true });
    const file = join(RESULTS_DIR, `${stamp()}-${process.pid}-${agent.name}-salvage.json`);
    writeFileSync(file, JSON.stringify(body, null, 2) + '\n', 'utf8');
    return file;
  } catch {
    return null;
  }
}

export function summarizeUpdate(update, state, opts) {
  const kind = update?.sessionUpdate;
  if (kind === 'agent_message_chunk' && update.content?.type === 'text') {
    const text = update.content.text ?? '';
    state.text += text;
    if (opts.probe) process.stderr.write(text);
    else if (!opts.json && opts.stream) process.stdout.write(text);
    return;
  }
  if (kind === 'agent_thought_chunk' && opts.verbose) {
    const text = update.content?.text ?? '';
    if (text) process.stderr.write(`[thought] ${text.trimEnd()}\n`);
    return;
  }
  if (kind === 'tool_call' || kind === 'tool_call_update') {
    const previous = state.tools.get(update.toolCallId);
    const tool = {
      title: update.title ?? previous?.title ?? 'tool',
      kind: update.kind ?? previous?.kind,
      status: update.status ?? previous?.status ?? 'pending',
    };
    state.tools.set(update.toolCallId, tool);
    if (opts.verbose) {
      process.stderr.write(`[tool] ${update.toolCallId}: ${tool.title} (${tool.status})\n`);
    }
    return;
  }
  if (kind === 'usage_update') {
    state.usage = update;
    // The context window crosses turns: keep the high-water mark, because a
    // compaction mid-turn can bring `used` back down before the turn ends.
    const used = Number(update.used);
    if (Number.isFinite(used) && used > 0) {
      state.contextPeak = Math.max(state.contextPeak ?? 0, Math.floor(used));
    }
    const size = Number(update.size);
    if (Number.isFinite(size) && size > 0) state.contextSize = Math.floor(size);
    return;
  }
  if (opts.verbose && kind) {
    process.stderr.write(`[update] ${kind}\n`);
  }
}
