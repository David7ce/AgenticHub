// fanout-render.mjs — turn fan-out results into the merge prompt and the
// markdown report.

// The synthesis call carries several answers, so it needs a larger ceiling
// than a user prompt. hub-acp.mjs accepts --max-prompt-chars for this.
export const SYNTH_MAX_PROMPT_CHARS = 24_000;

function clip(text, max) {
  return text.length > max ? text.slice(0, max) + '...[truncated]' : text;
}

/**
 * Build the merge prompt for `--synthesize`. Returns null when there is
 * nothing to merge (< 2 non-empty answers). Exported for tests.
 */
export function buildSynthesisPrompt({ prompt, results, maxChars = SYNTH_MAX_PROMPT_CHARS }) {
  const usable = results.filter((r) => r.text?.trim());
  if (usable.length < 2) return null;

  const header =
    `You are merging ${usable.length} independent answers to the same task. ` +
    `Produce one coherent answer for the user.\n\n` +
    `TASK:\n${prompt.trim()}\n\n` +
    `RULES:\n` +
    `- Keep concrete facts, code, commands and file paths.\n` +
    `- Surface material disagreements between the answers instead of silently choosing one.\n` +
    `- Do not invent details that are not in the task or the answers.\n` +
    `- Do not describe the merge process itself unless it matters.\n\n`;

  // Leave room for the per-answer labels and truncation markers.
  const perAnswer = Math.max(400, Math.floor((maxChars - header.length - 200) / usable.length));
  const blocks = usable
    .map((r) => `--- ANSWER FROM ${r.agent} ---\n${clip(r.text.trim(), perAnswer)}`)
    .join('\n\n');

  return (header + blocks).slice(0, maxChars);
}

export function baseResult(fields) {
  return {
    agent: fields.agent,
    ok: fields.status === 'ok',
    status: fields.status,
    sessionId: fields.sessionId ?? null,
    stopReason: fields.stopReason ?? null,
    durationMs: fields.durationMs,
    startedAt: fields.startedAt,
    cost: fields.cost ?? null,
    text: fields.text ?? '',
    error: fields.error ?? null,
    exitCode: fields.exitCode ?? 1,
    stderr: fields.stderr ?? '',
  };
}

function formatCost(cost) {
  return cost?.amount != null ? `$${Number(cost.amount).toFixed(4)}` : '—';
}

export function renderMarkdown({ prompt, results, synthesis = null, stamp: runStamp }) {
  const rows = results.map(
    (r) =>
      `| ${r.agent} | ${r.status} | ${r.stopReason ?? '—'} | ` +
      `${(r.durationMs / 1000).toFixed(1)}s | ${formatCost(r.cost)} |`,
  );
  const sections = results.map((r) => {
    const body = r.text.trim()
      ? r.text.trim()
      : r.error
        ? `_No answer._\n\n\`${r.error.replace(/`/g, "'")}\``
        : '_No answer._';
    return `## ${r.agent} — ${r.status} — ${(r.durationMs / 1000).toFixed(1)}s\n\n${body}\n`;
  });

  const synthesisSection = synthesis
    ? `## Synthesis — ${synthesis.agent} — ${synthesis.status} — ${(synthesis.durationMs / 1000).toFixed(1)}s\n\n${
        synthesis.text.trim()
          ? synthesis.text.trim()
          : `_No synthesis._${synthesis.error ? `\n\n\`${synthesis.error.replace(/`/g, "'")}\`` : ''}`
      }\n`
    : null;

  // A prompt may itself contain backticks or tildes; size the fence so it
  // cannot be closed early.
  const fenceLen = Math.max(3, ...(prompt.match(/~+/g) ?? []).map((run) => run.length + 1));
  const fence = '~'.repeat(fenceLen);

  const parts = [
    `# ACP fan-out ${runStamp}`,
    '',
    `${fence}text`,
    prompt.trim(),
    fence,
    '',
    '| Agent | Status | Stop | Time | Cost |',
    '|-------|--------|------|------|------|',
    ...rows,
    '',
  ];
  if (synthesisSection) parts.push(synthesisSection, '');
  parts.push(...sections);

  const kept = results.filter((r) => r.worktreeKept && r.worktree);
  if (kept.length) {
    parts.push(
      '## Kept worktrees',
      '',
      'These agents changed files, so their checkouts were left in place:',
      '',
      ...kept.map((r) => `- **${r.agent}**: \`${r.worktree}\``),
      '',
    );
  }
  return parts.join('\n');
}
