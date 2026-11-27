// home.js — the Inicio page: copy in both languages, the numbers from HOME, the
// refresh command. `HOME` is the inline data block; `initShell` and `formatNumber`
// come from the shared scripts.

// Product names, not translated.
const PLAN_NAMES = {
  go: 'Go', 'go-plus': 'Go Plus', 'go-teams': 'Go Teams', plus: 'Plus', pro: 'Pro', max: 'Max',
  ultra: 'Ultra', team: 'Team', enterprise: 'Enterprise', edu: 'Edu', zen: 'Zen',
};

const HOME_COPY = {
  es: {
    repos: 'Repositorios', dirty: 'con cambios sin commit', ahead: 'con commits por subir', noRemote: 'sin remoto',
    ia: 'Uso de IA', roadmap: 'Roadmap', roadmapOpen: 'proyectos abiertos',
    roadmapOwner: 'pasos que esperan al dueño',
    refresh: 'Actualizar el panel', copy: 'Copiar', copied: 'Copiado', copyFailed: 'No se pudo copiar',
    refreshNote: 'Desde D:\\Workspaces. Gasto, páginas y notas; la tarea Workspaces-Refresh lo hace cada hora.',
    noData: 'sin datos', codexWeek: 'Codex, semana', claudeWeek: 'Claude, 7 días', tokens: 'tokens de trabajo',
    weekly: 'Uso semanal por suscripción',
    weeklyNote: 'Tokens locales de los últimos 7 días y el porcentaje que cada plan reporta de su ventana semanal.',
    weeklyDetails: 'Ver en Uso de IA',
    measured: 'medido', estimated: 'estimado', record: 'tu récord', manual: 'copiado de la consola',
    free: 'gratis', noReading: 'sin lectura',
    stale: 'más de 6 h de antigüedad — ejecuta el comando de abajo', built: 'Generado',
    agents: { claude: 'Claude', opencode: 'OpenCode', codex: 'ChatGPT / Codex', zen: 'OpenCode Zen' },
  },
  en: {
    repos: 'Repositories', dirty: 'with uncommitted changes', ahead: 'with commits to push', noRemote: 'without a remote',
    ia: 'AI Usage', roadmap: 'Roadmap', roadmapOpen: 'open projects',
    roadmapOwner: 'steps waiting on the owner',
    refresh: 'Update the panel', copy: 'Copy', copied: 'Copied', copyFailed: 'Could not copy',
    refreshNote: 'From D:\\Workspaces. Spend, pages and notes; the Workspaces-Refresh task does it every hour.',
    noData: 'no data', codexWeek: 'Codex, week', claudeWeek: 'Claude, 7 days', tokens: 'work tokens',
    weekly: 'Weekly use per subscription',
    weeklyNote: 'Local work tokens for the last 7 days and the percentage each plan reports for its weekly window.',
    weeklyDetails: 'Open AI Usage',
    measured: 'measured', estimated: 'estimated', record: 'your record', manual: 'copied from the console',
    free: 'free', noReading: 'no reading',
    stale: 'over 6 h old — run the command below', built: 'Built',
    agents: { claude: 'Claude', opencode: 'OpenCode', codex: 'ChatGPT / Codex', zen: 'OpenCode Zen' },
  },
};

(() => {
  const $ = (id) => document.getElementById(id);
  const isStale = () => {
    const built = Date.parse(HOME.generatedAtIso || '');
    return Number.isFinite(built) && Date.now() - built > 6 * 3600 * 1000;
  };

  /** Seven daily points, drawn inline: no canvas and no extra request on file://. */
  function sparkline(item, label) {
    const ns = 'http://www.w3.org/2000/svg';
    const short = (n) => (typeof shortTokens === 'function' ? shortTokens(n) : String(n));
    const width = 132;
    const height = 34;
    const pad = 3;
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    svg.setAttribute('class', 'spark');
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', label);
    const max = Math.max(1, ...item.days);
    const step = item.days.length > 1 ? (width - pad * 2) / (item.days.length - 1) : 0;
    const points = item.days.map((value, i) => [pad + i * step, height - pad - (value / max) * (height - pad * 2)]);
    const line = points.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
    const area = document.createElementNS(ns, 'polygon');
    area.setAttribute('class', 'spark-area');
    area.setAttribute('points', `${pad},${height - pad} ${line} ${width - pad},${height - pad}`);
    const poly = document.createElementNS(ns, 'polyline');
    poly.setAttribute('class', 'spark-line');
    poly.setAttribute('points', line);
    svg.append(area, poly);
    const dates = HOME.weekly?.dates ?? [];
    points.forEach(([x, y], i) => {
      const dot = document.createElementNS(ns, 'circle');
      dot.setAttribute('cx', x.toFixed(1));
      dot.setAttribute('cy', y.toFixed(1));
      dot.setAttribute('r', '1.8');
      const tip = document.createElementNS(ns, 'title');
      const day = dates[i] ? new Intl.DateTimeFormat(lang, { day: '2-digit', month: 'short', timeZone: 'UTC' })
        .format(new Date(`${dates[i]}T12:00:00Z`)) : '';
      tip.textContent = `${day}: ${short(item.days[i])}`;
      dot.append(tip);
      svg.append(dot);
    });
    return svg;
  }

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

    // One line per subscription: weekly work tokens, its plan reading and seven days.
    const weeklyItems = HOME.weekly?.items ?? [];
    $('weekly').hidden = !weeklyItems.length;
    const pctLabel = (item) => {
      if (item.pct == null) return '—';
      const value = new Intl.NumberFormat(lang, { style: 'percent', maximumFractionDigits: 1 }).format(item.pct);
      return `${item.pctKind === 'measured' ? '' : '≈ '}${value}`;
    };
    $('weeklyList').replaceChildren(...weeklyItems.map((item) => {
      const name = t.agents[item.agent] || item.agent;
      const plan = item.agent === 'zen' ? '' : (PLAN_NAMES[item.plan] || item.plan || '');
      const row = document.createElement('li');
      row.className = 'weekly-row';
      row.style.setProperty('--agent-color', `var(--${item.agent})`);

      const head = document.createElement('div');
      head.className = 'weekly-name';
      const title = document.createElement('b');
      title.textContent = plan ? `${name} · ${plan}` : name;
      const source = document.createElement('span');
      source.className = 'weekly-src';
      source.textContent = item.pctKind === 'free' ? t.free : (t[item.pctKind] || t.noReading);
      head.append(title, source);

      const tokens = document.createElement('div');
      tokens.className = 'weekly-tokens';
      const amount = document.createElement('b');
      amount.textContent = short(item.tokens);
      amount.title = num(item.tokens);
      const unit = document.createElement('small');
      unit.textContent = t.tokens;
      tokens.append(amount, unit);

      const pct = document.createElement('div');
      pct.className = 'weekly-pct';
      const value = document.createElement('b');
      value.textContent = pctLabel(item);
      pct.append(value);
      if (item.pct != null) {
        const meter = document.createElement('span');
        meter.className = 'meter';
        meter.setAttribute('aria-hidden', 'true');
        const filled = document.createElement('span');
        filled.style.width = `${Math.max(0, Math.min(100, item.pct * 100)).toFixed(1)}%`;
        meter.append(filled);
        pct.append(meter);
      }

      row.append(head, tokens, pct, sparkline(item, `${title.textContent}: ${t.tokens} ${short(item.tokens)} · ${pctLabel(item)}`));
      return row;
    }));

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
