// render.mjs — turn hub results into the text the chat shows.

function seconds(ms) {
  return typeof ms === 'number' ? `${(ms / 1000).toFixed(1)}s` : '—';
}

function money(cost) {
  const amount = cost?.amount;
  return typeof amount === 'number' ? `$${amount.toFixed(4)}` : '—';
}

export function renderAsk(result) {
  const head =
    `agent: ${result.agent} · status: ${result.status} · ${seconds(result.durationMs)} · ` +
    `cost: ${money(result.cost)}` +
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

  if (!result.ok) {
    const where = result.cwd ? ` in ${result.cwd}` : '';
    // A timeout is the one failure that leaves work behind. Say so, with the
    // path, instead of letting the caller assume the tree is untouched.
    const leftover =
      result.status === 'timeout'
        ? `\nthe callee may still be working${where} — check \`git status\` there before ` +
          're-dispatching, and release any write lane it claimed.'
        : '';
    return `${head}${trail}${concurrent}${salvage}${saved}\n\nerror: ${result.error ?? result.status}${leftover}`;
  }
  const tools = Array.isArray(result.tools) && result.tools.length
    ? `\n\ntool calls (${result.tools.length}): ` +
      result.tools.slice(0, 12).map((t) => t.title ?? 'tool').join(', ') +
      (result.tools.length > 12 ? ', …' : '')
    : '';
  return `${head}${trail}${concurrent}${saved}${tools}\n\n${(result.text ?? '').trimEnd() || '(empty answer)'}`;
}

export function renderJobStatus(job) {
  if (!job) return 'unknown job';
  const head =
    `${job.id} · ${job.state} · ${seconds(job.elapsedMs)} · ${job.agent}` +
    (job.model ? ` · model: ${job.model}` : '') +
    (job.cwd ? ` · ${job.cwd}` : '');
  const tail = job.lastTool ? `\nlast tool: ${job.lastTool}` : '';
  const error = job.error ? `\nerror: ${job.error}` : '';
  const hint = job.running
    ? '\nstill running — poll job_status, or collect with job_result when it ends'
    : '\nfinished — job_result has the answer';
  return `${head}${tail}${error}${hint}`;
}

export function renderJobResult(job) {
  if (!job) return 'unknown job';
  if (job.running) return `${renderJobStatus(job)}\n\nthe answer is not ready yet`;
  if (!job.answer) {
    return `${renderJobStatus(job)}\n\nfinished as ${job.state} with no answer object`;
  }
  return renderAsk({ ...job.answer, modelAttempts: job.answer.modelAttempts });
}

export function renderFanout(result) {
  const lines = [
    `fan-out · ${result.okCount}/${result.agents.length} answered · ${seconds(result.durationMs)}`,
  ];
  if (result.synthesis?.ok) {
    lines.push('', `## synthesis (${result.synthesis.agent})`, '', (result.synthesis.text ?? '').trimEnd());
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
