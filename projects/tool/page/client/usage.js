// usage.js — small AI-usage snapshot on the Repos page, in the same work tokens
// the IA page shows (cache reads barely count, so they are small print).
// The numbers are formatted by shared/format.js, which the IA page uses too.

function initUsage(summary) {
  const root = document.getElementById('usagePreview');
  const agentNames = { claude: 'agentClaude', opencode: 'agentOpenCode', codex: 'agentCodex' };
  const format = (value) => formatNumber(value, lang);

  const render = () => {
    if (!summary?.agents?.length || !summary.agents.some((row) => (
      row.work_tokens || row.tokens.cache_read_tokens || row.tokens.output_tokens || row.tokens.input_tokens
    ))) {
      root.hidden = true;
      return;
    }
    root.hidden = false;
    document.getElementById('usageDate').textContent = summary.latestDate || '—';
    document.getElementById('usageCommits').textContent = format(summary.commits);
    document.getElementById('usageAgents').innerHTML = summary.agents.map((row) => (
      '<article class="usage-agent" data-agent="' + esc(row.agent) + '">'
      + '<b>' + esc(t(agentNames[row.agent] || row.agent)) + '</b>'
      + '<strong title="' + esc(format(row.work_tokens)) + '">' + esc(shortTokens(row.work_tokens)) + '</strong>'
      + '<span>' + esc(t('workTokens')) + '</span>'
      + '<small>' + esc(t('cacheReadTokens')) + ': ' + esc(shortTokens(row.tokens.cache_read_tokens))
      + ' · ' + esc(t('outputTokens')) + ': ' + esc(shortTokens(row.tokens.output_tokens)) + '</small>'
      + '</article>'
    )).join('');
  };
  return { render };
}
