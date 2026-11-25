// render.mjs — turn hub results into the text the chat shows.

function seconds(ms) {
  return typeof ms === 'number' ? `${(ms / 1000).toFixed(1)}s` : '—';
}

function money(cost) {
  const amount = cost?.amount;
  return typeof amount === 'number' ? `$${amount.toFixed(4)}` : '—';
}

const count = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n ?? 0));

/** The turn's tokens, or `—` when the agent's store could not be read. */
export function usageLine(usage) {
  if (!usage || usage.confidence === 'unavailable') return 'tokens: —';
  return `tokens: ${count(usage.input_tokens)} in · ${count(usage.cache_read_tokens)} cached · ${count(usage.output_tokens)} out`;
}

function cancellationNotice(result) {
  if (result.cancelAck === true) {
    return '\ncancellation: agent acknowledged the turn ended (not proof that all processes stopped)';
  }
  if (result.cancelAck === false || ['cancelled', 'timeout'].includes(result.status ?? result.state)) {
    return '\ncancellation: not confirmed or unknown — the agent may still be working; check before re-dispatching';
  }
  return '';
}

export function renderAsk(result) {
  const head =
    `agent: ${result.agent} · status: ${result.status} · ${seconds(result.durationMs)} · ` +
    `cost: ${money(result.cost)} · ${usageLine(result.tokens)}` +
    (result.model ? ` · model: ${result.model}` : '') +
    (result.stopReason ? ` · stop: ${result.stopReason}` : '') +
    (result.sessionId ? ` · session: ${result.sessionId}` : '');

  // A model move is worth stating: the answer came from a paid pool because
  // the free one was empty, and the caller may want to know that.
  const trail =
    result.modelAttempts?.length > 1 ? `\nmodels tried: ${result.modelTrail}` : '';
  const concurrent = result.concurrentWrite
    ? `\nanother write run held this tree: ${result.concurrentWrite}`
    : '';
  const salvage = result.salvage
    ? `\nwhat it left behind: ${result.salvage} (git status, HEAD, diffstat)`
    : '';
  const saved = result.savedTo ? `\nsaved: ${result.savedTo}` : '';
  const mode = result.ok || result.requestedMode || result.reportedMode
    ? `\nmode requested: ${result.requestedMode ?? 'none'} · agent reported: ${result.reportedMode ?? 'unknown'}` +
      (result.modeSource ? ` · source: ${result.modeSource}` : '') + ' (not a sandbox)'
    : '';

  if (!result.ok) {
    const where = result.cwd ? ` in ${result.cwd}` : '';
    // A timeout is the one failure that leaves work behind. Say so, with the
    // path, instead of letting the caller assume the tree is untouched.
    const leftover =
      result.status === 'timeout'
        ? `\nthe callee may still be working${where} — check \`git status\` there before ` +
          're-dispatching, and release any write lane it claimed.'
        : '';
    return `${head}${mode}${trail}${concurrent}${salvage}${saved}${cancellationNotice(result)}\n\nerror: ${result.error ?? result.status}${leftover}`;
  }
  const tools = Array.isArray(result.tools) && result.tools.length
    ? `\n\ntool calls (${result.tools.length}): ` +
      result.tools.slice(0, 12).map((t) => t.title ?? 'tool').join(', ') +
      (result.tools.length > 12 ? ', …' : '')
    : '';
  return `${head}${mode}${trail}${concurrent}${saved}${tools}\n\n${(result.text ?? '').trimEnd() || '(empty answer)'}`;
}

export function renderJobStatus(job) {
  if (!job) return 'unknown job';
  const head =
    `${job.id} · ${job.state} · ${seconds(job.elapsedMs)} · ${job.agent}` +
    (job.model ? ` · model: ${job.model}` : '') +
    (job.cwd ? ` · ${job.cwd}` : '');
  const tail = job.lastTool ? `\nlast tool: ${job.lastTool}` : '';
  const mode = `\nmode requested: ${job.requestedMode ?? (job.running ? 'none or pending' : 'none')} · ` +
    `agent reported: ${job.reportedMode ?? 'unknown'}` +
    (job.modeSource ? ` · source: ${job.modeSource}` : '') + ' (not a sandbox)';
  const label = job.sessionLabel ? `\nsession: ${job.sessionLabel}` : '';
  const note = job.note ? `\n${job.note}` : '';
  const pending = job.pendingPermission
    ? `\nWAITING FOR PERMISSION: ${job.pendingPermission.title ?? '?'} (${job.pendingPermission.toolKind ?? '?'})` +
      (job.pendingPermissionCount > 1 ? ` +${job.pendingPermissionCount - 1} more held` : '') +
      ` · held ${seconds(job.pendingPermission.heldMs)} · request ${job.pendingPermission.requestId}` +
      `\nanswer with permission_answer {"jobId": "${job.id}", "requestId": "${job.pendingPermission.requestId}", "decision": "allow_once"|"reject"}`
    : '';
  const recent = job.recentText ? `\nrecent text: ${String(job.recentText).replace(/\s+/g, ' ').trim()}` : '';
  const error = job.error ? `\nerror: ${job.error}` : '';
  const hint = job.pendingPermission
    ? '\nthe turn is paused until you answer (it is not counted against the turn timeout)'
    : job.running
      ? '\nstill running — poll job_status, or collect with job_result when it ends'
      : '\nfinished — job_result has the answer';
  return `${head}${label}${note}${mode}${tail}${recent}${pending}${error}${cancellationNotice(job)}${hint}`;
}

export function renderJobResult(job) {
  if (!job) return 'unknown job';
  if (job.running) return `${renderJobStatus(job)}\n\nthe answer is not ready yet`;
  if (!job.answer) {
    return `${renderJobStatus(job)}\n\nfinished as ${job.state} with no answer object`;
  }
  const answer = renderAsk({ ...job.answer, modelAttempts: job.answer.modelAttempts });
  return job.note ? `${answer}\n\n${job.note}` : answer;
}

export function renderFanout(result) {
  const lines = [
    `fan-out · ${result.okCount}/${result.agents.length} answered · ${seconds(result.durationMs)}`,
  ];
  if (result.synthesis?.ok) {
    lines.push('', `## synthesis (${result.synthesis.agent})`, '', (result.synthesis.text ?? '').trimEnd());
  }
  if (result.synthesis?.scratch) {
    lines.push('', `synthesis working directory retained: ${result.synthesis.scratch} (not a sandbox)`);
  }
  for (const agent of result.agents) {
    lines.push(
      '',
      `## ${agent.agent} — ${agent.status} — ${seconds(agent.durationMs)} — ${money(agent.cost)}`,
      '',
      agent.ok ? (agent.text ?? '').trimEnd() || '(empty answer)' : `error: ${agent.error ?? agent.status}`,
    );
  }
  if (result.worktrees?.length) {
    lines.push('', 'worktrees kept: ' + result.worktrees.map((w) => w.path).join(', '));
  }
  return lines.join('\n');
}

export function renderRoute(decision, result, failedOver = null) {
  const model = decision.model ? ` (${decision.model})` : '';
  const topology = decision.topology ? ` · topology: ${decision.topology}` : '';
  const head =
    `routed to: ${decision.agent}${model}${topology} — ${decision.reason}` +
    (failedOver ? ` (out of quota; retried on ${failedOver})` : '');
  return result ? `${head}\n\n${renderAsk(result)}` : head;
}

function ago(ms, now) {
  if (typeof ms !== 'number') return '—';
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

export function renderSessions(rows, now = Date.now()) {
  if (!rows.length) return 'no sessions';
  // A session in a worktree still belongs to its original tree; show both, so
  // the path in `sessions` is the one later turns actually run in.
  const tree = (s) => {
    const worktree = s.worktree && typeof s.worktree === 'object' ? s.worktree.path : null;
    if (!s.cwd) return worktree ?? '—';
    return worktree ? `${s.cwd} → ${worktree}` : s.cwd;
  };
  const cells = rows.map((s) => [
    s.label, s.agent, s.state, tree(s), s.model ?? '—', ago(s.lastActivity, now),
    `$${(s.spendUsd ?? 0).toFixed(2)}`,
  ]);
  const table = [['label', 'agent', 'state', 'tree', 'model', 'last activity', 'spend'], ...cells];
  const widths = table[0].map((_, i) => Math.max(...table.map((row) => String(row[i]).length)));
  return table.map((row) => row.map((c, i) => String(c).padEnd(widths[i])).join('  ').trimEnd()).join('\n');
}

function oneLine(value, max) {
  const s = String(value ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

export function renderSessionLog({ label, records, total, before }) {
  if (!records.length) return `${label}: no records${before !== undefined ? ` before ${before}` : ''} (${total} total)`;
  const lines = [`${label} · ${records.length} of ${total} records, newest first`];
  for (const r of records) {
    let body;
    switch (r.kind) {
      case 'prompt': body = `prompt: ${oneLine(r.text, 400)}`; break;
      case 'text': body = `agent: ${oneLine(r.text, 400)}`; break;
      case 'tool': body = `tool: ${oneLine(r.title, 120)} (${r.toolKind || '?'}, ${r.status || '?'})`; break;
      case 'usage': body = `usage: ${typeof r.cost === 'number' ? `$${r.cost.toFixed(4)}` : '—'}`; break;
      case 'permission': body = `permission: ${oneLine(r.title, 120)} (${r.toolKind || '?'}) -> ${r.decision ?? '?'}`; break;
      case 'stop': body = `stop: ${r.reason ?? '?'}${r.status ? ` (${r.status})` : ''}`; break;
      default: body = String(r.kind);
    }
    lines.push(`#${r.index} ${r.t ?? ''}  ${body}`);
  }
  const oldest = records[records.length - 1].index;
  if (oldest > 0) lines.push(`older: before=${oldest}`);
  return lines.join('\n');
}

export function renderAgents(rows) {
  if (!rows.length) return 'no agents registered';
  const lines = ['agent       available  consent   default model'];
  for (const row of rows) {
    lines.push(
      `${String(row.name).padEnd(11)} ${(row.available ? 'yes' : 'no').padEnd(10)} ` +
        `${(row.consent.ok ? 'granted' : `denied (${row.consent.reason})`).padEnd(9)} ` +
        `${row.defaultModel ?? '—'}`,
    );
  }
  return lines.join('\n');
}
