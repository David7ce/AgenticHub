// home.js — the Inicio page: copy in both languages, the numbers from HOME, the
// refresh command. `HOME` is the inline data block; `initShell` and `formatNumber`
// come from the shared scripts.

const HOME_COPY = {
  es: {
    repos: 'Proyectos', dirty: 'con cambios sin commit', ahead: 'con commits por subir', noRemote: 'sin remoto',
    ia: 'Uso de IA', roadmap: 'Roadmap', roadmapOpen: 'proyectos abiertos',
    roadmapOwner: 'pasos que esperan al dueño',
    refresh: 'Actualizar el panel', copy: 'Copiar', copied: 'Copiado', copyFailed: 'No se pudo copiar',
    refreshNote: 'Desde D:\\Workspaces. Gasto, páginas y notas; la tarea Workspaces-Refresh lo hace cada hora.',
    noData: 'sin datos', codexWeek: 'Codex, semana', claudeWeek: 'Claude, 7 días', tokens: 'tokens de trabajo',
    stale: 'más de 6 h de antigüedad — ejecuta el comando de abajo', built: 'Generado',
    agents: { claude: 'Claude', opencode: 'OpenCode', codex: 'Codex' },
  },
  en: {
    repos: 'Projects', dirty: 'with uncommitted changes', ahead: 'with commits to push', noRemote: 'without a remote',
    ia: 'AI Usage', roadmap: 'Roadmap', roadmapOpen: 'open projects',
    roadmapOwner: 'steps waiting on the owner',
    refresh: 'Update the panel', copy: 'Copy', copied: 'Copied', copyFailed: 'Could not copy',
    refreshNote: 'From D:\\Workspaces. Spend, pages and notes; the Workspaces-Refresh task does it every hour.',
    noData: 'no data', codexWeek: 'Codex, week', claudeWeek: 'Claude, 7 days', tokens: 'work tokens',
    stale: 'over 6 h old — run the command below', built: 'Built',
    agents: { claude: 'Claude', opencode: 'OpenCode', codex: 'Codex' },
  },
};

(() => {
  const $ = (id) => document.getElementById(id);
  const isStale = () => {
    const built = Date.parse(HOME.generatedAtIso || '');
    return Number.isFinite(built) && Date.now() - built > 6 * 3600 * 1000;
  };

  function paint(lang) {
    const t = HOME_COPY[lang] || HOME_COPY.es;
    const num = (n) => (typeof formatNumber === 'function' ? formatNumber(n, lang) : String(n));
    document.querySelectorAll('[data-k]').forEach((el) => { if (t[el.dataset.k] !== undefined) el.textContent = t[el.dataset.k]; });
    const values = {
      reposTotal: num(HOME.repos.total), reposDirty: num(HOME.repos.dirty), reposAhead: num(HOME.repos.ahead),
      reposNoRemote: num(HOME.repos.noRemote), roadmapOpen: num(HOME.roadmap.open), roadmapOwner: num(HOME.roadmap.owner),
    };
    document.querySelectorAll('[data-v]').forEach((el) => { el.textContent = values[el.dataset.v] ?? ''; });

    // IA: one line per agent with its work tokens, plus the plan windows when known.
    const list = $('iaFacts');
    list.textContent = '';
    const add = (html) => { const li = document.createElement('li'); li.innerHTML = html; list.append(li); };
    const short = (n) => (typeof shortTokens === 'function' ? shortTokens(n) : String(n));
    const active = HOME.ia.agents.filter((a) => a.workTokens > 0);
    for (const a of active) add(`${t.agents[a.agent] || a.agent}: <b>${short(a.workTokens)}</b> ${t.tokens}`);
    if (HOME.ia.codexWeeklyPct !== null) {
      const pct = Math.max(0, Math.min(100, HOME.ia.codexWeeklyPct));
      add(`${t.codexWeek}: <b>${Math.round(pct)}%</b><span class="bar" aria-hidden="true"><span style="width:${pct}%"></span></span>`);
    }
    if (HOME.ia.claudeWeek !== null) add(`${t.claudeWeek}: <b>${short(HOME.ia.claudeWeek)}</b>`);
    if (!list.children.length) add(t.noData);

    $('copyBtn').textContent = t.copy;
    return t;
  }

  let lang = 'es';
  const stamp = () => {
    const t = HOME_COPY[lang] || HOME_COPY.es;
    return `${t.built}: ${HOME.generatedAt || '—'}${isStale() ? ` · ${t.stale}` : ''}`;
  };
  initShell({
    tab: 'home',
    stamp,
    onLang: (next) => { lang = next; paint(next); },
  });
  lang = typeof shellLang === 'function' ? shellLang() : 'es';
  paint(lang);
  $('shellStamp').classList.toggle('stale', isStale());

  // navigator.clipboard does not exist on file://; the textarea is the fallback.
  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); return true; } catch { /* fall through */ }
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
    document.body.append(area);
    area.select();
    try { return document.execCommand('copy'); } catch { return false; } finally { area.remove(); }
  }
  $('copyBtn').addEventListener('click', async () => {
    const t = HOME_COPY[lang] || HOME_COPY.es;
    const ok = await copyText($('cmd').textContent.trim());
    $('copyStatus').textContent = ok ? t.copied : t.copyFailed;
    setTimeout(() => { $('copyStatus').textContent = ''; }, 1600);
  });
})();
