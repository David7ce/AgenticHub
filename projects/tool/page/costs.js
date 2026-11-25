// costs.js — offline daily and hourly usage charts for the local token ledger.
const LEDGER = /*COSTS_DATA*/;
const VIEW = /*COSTS_VIEW*/;

(() => {
  const COPY = {
    en: {
      latest: 'Snapshot',
      agents: { claude: 'Claude Code', opencode: 'OpenCode', codex: 'Codex' },
      cache_read_tokens: 'Cache read',
      cache_write_tokens: 'Cache write',
      input_tokens: 'Input',
      output_tokens: 'Output',
      reasoning_tokens: 'Reasoning',
      unknown_tokens: 'Undisclosed total',
      daily_title: 'Daily usage',
      daily_hint: 'Stacked by agent. Select a token category to compare days.',
      metric: 'Token category',
      hourly_title: 'Hourly breakdown',
      hourly_hint: 'UTC. Claude is grouped by message time; OpenCode and Codex by session/thread start.',
      hour: 'Hour (UTC)',
      no_data: 'No token records for this range.',
      unknown_hour: 'Records without a recoverable hour',
      unknown_note: 'These tokens are preserved in the daily ledger but are not assigned to an hour.',
      generated: 'Snapshot generated {date}.',
      source: 'Source coverage is shown in COSTS.md. Categories are kept separate because provider counters can overlap.',
      daily_table: 'Day',
      work_tokens: 'Work tokens',
      work_hint: 'input + output + cache writes',
      data_at: 'Data at {date}',
      stale: 'over 6 h old — run: node projects/tool/cli.mjs refresh',
      room_title: 'Room left',
      room_hint: 'How much of each plan window is used. Each bar says where its number comes from.',
      no_limits: 'No limits reading yet. Run: node projects/tool/cli.mjs costs --write',
      limits_error: 'Codex/Go reading failed: {error}',
      src_measured: 'measured', src_estimated: 'estimated', src_record: 'own record', src_free: 'free',
      resets: 'resets {date}', reset_done: 'already reset',
      of_record: '{pct} of your heaviest {window} ({record})',
      no_reference: 'No {plan} reference yet: it is filled in when a limit is first hit, or set it in projects/local/limits.json.',
      ref_from: 'Plan reference: {source}',
      win_5h: 'last 5 h', win_7d: 'last 7 days',
      spend_title: 'Who spends most',
      spend_hint: 'For the period chosen on the calendar (all history if none). Work tokens, with cache reads apart (they barely count).',
      cal_title: 'AI usage', cal_year: '{total} work tokens in {year}', cal_hint: '— charts and tables show only this period.',
      agent: 'Agent', cache_read: 'Cache read',
      projects: 'Projects', models: 'Models',
      hourly_claude_note: 'Only Claude is shown: OpenCode and Codex record a session/thread start, not the hour of each step.',
    },
    es: {
      latest: 'Snapshot',
      agents: { claude: 'Claude Code', opencode: 'OpenCode', codex: 'Codex' },
      cache_read_tokens: 'Lectura de caché',
      cache_write_tokens: 'Escritura de caché',
      input_tokens: 'Entrada',
      output_tokens: 'Salida',
      reasoning_tokens: 'Razonamiento',
      unknown_tokens: 'Total sin desglose',
      daily_title: 'Uso diario',
      daily_hint: 'Barras apiladas por agente. Elige una categoría para comparar días.',
      metric: 'Categoría de token',
      hourly_title: 'Desglose por hora',
      hourly_hint: 'UTC. Claude se agrupa por hora de mensaje; OpenCode y Codex por inicio de sesión/hilo.',
      hour: 'Hora (UTC)',
      no_data: 'No hay tokens registrados en este periodo.',
      unknown_hour: 'Registros sin hora recuperable',
      unknown_note: 'Se conservan en el ledger diario, pero no se asignan a una hora.',
      generated: 'Snapshot generado {date}.',
      source: 'La cobertura de fuentes está en COSTS.md. Las categorías se separan porque los contadores pueden solaparse.',
      daily_table: 'Día',
      work_tokens: 'Tokens de trabajo',
      work_hint: 'entrada + salida + escritura de caché',
      data_at: 'Datos de {date}',
      stale: 'más de 6 h de antigüedad — ejecuta: node projects/tool/cli.mjs refresh',
      room_title: 'Margen disponible',
      room_hint: 'Cuánto llevas gastado de cada ventana del plan. Cada barra dice de dónde sale su número.',
      no_limits: 'Aún no hay lectura de límites. Ejecuta: node projects/tool/cli.mjs costs --write',
      limits_error: 'Falló la lectura de Codex/Go: {error}',
      src_measured: 'medido', src_estimated: 'estimado', src_record: 'tu récord', src_free: 'gratis',
      resets: 'se reinicia {date}', reset_done: 'ya se reinició',
      of_record: '{pct} de tu {window} más intensa ({record})',
      no_reference: 'Aún no hay referencia de {plan}: se rellena la primera vez que llegues al límite, o ponla en projects/local/limits.json.',
      ref_from: 'Referencia del plan: {source}',
      win_5h: 'últimas 5 h', win_7d: 'últimos 7 días',
      spend_title: 'Quién gasta más',
      spend_hint: 'Del periodo elegido en el calendario (todo el historial si no hay). Tokens de trabajo, con la lectura de caché aparte (apenas cuenta).',
      cal_title: 'Uso de IA', cal_year: '{total} tokens de trabajo en {year}', cal_hint: '— las gráficas y tablas muestran solo este periodo.',
      agent: 'Agente', cache_read: 'Lectura de caché',
      projects: 'Proyectos', models: 'Modelos',
      hourly_claude_note: 'Solo se muestra Claude: OpenCode y Codex registran el inicio de sesión/hilo, no la hora de cada paso.',
    },
  };

  const COLORS = { claude: 'var(--claude)', opencode: 'var(--opencode)', codex: 'var(--codex)' };
  const AGENTS = ['claude', 'opencode', 'codex'];
  const METRICS = ['work_tokens', 'cache_read_tokens', 'cache_write_tokens', 'input_tokens', 'output_tokens', 'reasoning_tokens', 'unknown_tokens'];
  const state = { lang: shellLang(), metric: 'work_tokens', range: null };
  const rows = Array.isArray(LEDGER.rows) ? LEDGER.rows : [];
  const $ = (id) => document.getElementById(id);
  const t = (key) => COPY[state.lang][key];
  const fill = (text, values) => text.replace(/\{(\w+)\}/g, (_, key) => values[key] ?? '');
  const format = (n) => formatNumber(n, state.lang);
  const work = (row) => (Number(row.input_tokens) || 0) + (Number(row.output_tokens) || 0)
    + (Number(row.cache_write_tokens) || 0) + (Number(row.unknown_tokens) || 0);
  const valueOf = (row, metric) => (metric === 'work_tokens' ? work(row) : Number(row[metric]) || 0);
  const short = (n) => shortTokens(n);
  const pctText = (p) => (p === null || p === undefined ? '—' : `${(p * 100).toFixed(p < 0.1 ? 1 : 0)}%`);
  const stamp = (iso) => (iso ? new Intl.DateTimeFormat(state.lang === 'es' ? 'es-ES' : 'en-US', {
    weekday: 'short', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
  }).format(new Date(iso)) : '—');
  const num = (n) => make('span', { title: format(n) }, short(n));
  const dateLabel = (value) => {
    if (!value) return '—';
    const [year, month, day] = value.split('-').map(Number);
    return new Intl.DateTimeFormat(state.lang === 'es' ? 'es-ES' : 'en-US', {
      day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC',
    }).format(new Date(Date.UTC(year, month - 1, day, 12)));
  };
  const make = (tag, attrs = {}, text = null) => {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
    if (text !== null) node.textContent = text;
    return node;
  };

  function group(items, keyOf) {
    const out = new Map();
    for (const row of items) {
      const key = keyOf(row);
      if (!out.has(key)) out.set(key, { claude: 0, opencode: 0, codex: 0 });
      if (Object.hasOwn(out.get(key), row.agent)) out.get(key)[row.agent] += valueOf(row, state.metric);
    }
    return out;
  }

  function totalsByAgent(items) {
    const out = Object.fromEntries(AGENTS.map((agent) => [agent, {
      input_tokens: 0, cache_write_tokens: 0, cache_read_tokens: 0, output_tokens: 0, reasoning_tokens: 0, unknown_tokens: 0,
    }]));
    for (const row of items) {
      if (!out[row.agent]) continue;
      for (const metric of METRICS) out[row.agent][metric] += Number(row[metric]) || 0;
    }
    return out;
  }

  function agentName(agent) { return COPY[state.lang].agents[agent] || agent; }
  function svgNode(tag, attrs, text) {
    const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function drawChart(svg, keys, values, { daily }) {
    const width = 960;
    const height = 286;
    const left = 66;
    const right = 18;
    const top = 18;
    const bottom = 42;
    const plotWidth = width - left - right;
    const plotHeight = height - top - bottom;
    svg.replaceChildren();
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    svg.setAttribute('class', 'chart');
    svg.setAttribute('aria-label', `${daily ? t('daily_title') : t('hourly_title')} · ${t(state.metric)}`);
    const maximum = Math.max(1, ...values.map((entry) => AGENTS.reduce((sum, agent) => sum + (entry[agent] || 0), 0)));
    const axis = (value) => top + plotHeight - (value / maximum) * plotHeight;
    for (let step = 0; step <= 4; step += 1) {
      const value = maximum * step / 4;
      const y = axis(value);
      svg.append(svgNode('line', { x1: left, x2: width - right, y1: y, y2: y, class: 'grid-line' }));
      svg.append(svgNode('text', { x: left - 9, y: y + 3, class: 'axis-label', 'text-anchor': 'end' }, short(value)));
    }
    if (!keys.length || !values.some((entry) => AGENTS.some((agent) => (entry[agent] || 0) > 0))) {
      svg.append(svgNode('text', { x: width / 2, y: height / 2, class: 'axis-label', 'text-anchor': 'middle' }, t('no_data')));
      return;
    }
    const slot = plotWidth / keys.length;
    keys.forEach((key, index) => {
      const entry = values[index];
      const center = left + slot * index + slot / 2;
      if (daily) {
        const barWidth = Math.min(42, slot * .58);
        let stacked = 0;
        for (const agent of AGENTS) {
          const value = entry[agent] || 0;
          if (!value) continue;
          const y1 = axis(stacked + value);
          const y2 = axis(stacked);
          const rect = svgNode('rect', {
            x: center - barWidth / 2, y: y1, width: barWidth, height: Math.max(1, y2 - y1),
            fill: COLORS[agent], class: 'bar',
          });
          rect.append(svgNode('title', {}, `${dateLabel(key)} · ${agentName(agent)} · ${t(state.metric)}: ${format(value)}`));
          svg.append(rect);
          stacked += value;
        }
      } else {
        const barWidth = Math.min(10, slot * .17);
        AGENTS.forEach((agent, agentIndex) => {
          const value = entry[agent] || 0;
          if (!value) return;
          const x = center + (agentIndex - 1) * (barWidth + 2) - barWidth / 2;
          const y = axis(value);
          const rect = svgNode('rect', { x, y, width: barWidth, height: Math.max(1, top + plotHeight - y), fill: COLORS[agent], class: 'bar' });
          rect.append(svgNode('title', {}, `${String(key).padStart(2, '0')}:00 UTC · ${agentName(agent)} · ${t(state.metric)}: ${format(value)}`));
          svg.append(rect);
        });
      }
      const label = daily ? key.slice(5) : String(key).padStart(2, '0');
      const show = daily ? (keys.length <= 10 || index % Math.ceil(keys.length / 10) === 0) : (index % 2 === 0);
      if (show) svg.append(svgNode('text', { x: center, y: height - 17, class: 'bar-label' }, label));
    });
  }

  function paintLegend(target, agents = AGENTS) {
    target.replaceChildren(...agents.map((agent) => {
      const item = make('span', { class: 'legend-item' });
      item.append(make('i', { class: 'swatch', style: `--swatch:${COLORS[agent]}` }));
      item.append(document.createTextNode(agentName(agent)));
      return item;
    }));
  }

  function paintCards(selected) {
    const totals = totalsByAgent(selected);
    $('agents').replaceChildren(...AGENTS.map((agent) => {
      const card = make('article', { class: 'agent-card', style: `--agent-color:${COLORS[agent]}` });
      card.append(make('div', { class: 'agent-name' }, agentName(agent)));
      const value = make('div', { class: 'agent-value' });
      value.append(num(work(totals[agent])));
      card.append(value);
      card.append(make('div', { class: 'agent-metric', title: t('work_hint') }, t('work_tokens')));
      const secondary = make('div', { class: 'agent-secondary' });
      for (const metric of ['cache_read_tokens', 'input_tokens', 'output_tokens', 'cache_write_tokens']) {
        const cell = make('span', { title: format(totals[agent][metric]) }, `${t(metric)} · ${short(totals[agent][metric])}`);
        secondary.append(cell);
      }
      card.append(secondary);
      return card;
    }));
  }

  // Judged when the page is opened, not when it was built: a day-old build must look stale.
  function isStale() {
    const age = Date.now() - Date.parse(VIEW.dataAt || '');
    return !Number.isFinite(age) || age > 6 * 3600 * 1000;
  }
  function stampText() {
    return fill(t('data_at'), { date: stamp(VIEW.dataAt) }) + (isStale() ? ` · ${t('stale')}` : '');
  }
  function paintStamp() { $('shellStamp').classList.toggle('stale', isStale()); }

  function paintRoom() {
    const list = $('roomList');
    const note = $('roomNote');
    const notes = [];
    if (VIEW.noLimits) notes.push(t('no_limits'));
    if (VIEW.limitsError) notes.push(fill(t('limits_error'), { error: VIEW.limitsError }));
    note.textContent = notes.join(' ');
    note.hidden = !notes.length;
    const room = VIEW.room || [];
    list.replaceChildren(...room.map((r) => {
      const shown = r.pct ?? r.recordPct;
      const item = make('div', { class: `room-row state-${r.state}`, style: `--agent-color:${COLORS[r.agent]}` });
      const head = make('div', { class: 'room-head' });
      const windowName = r.id === 'claude-5h' ? t('win_5h') : r.id === 'claude-week' ? t('win_7d') : r.label;
      head.append(make('span', { class: 'room-name' }, `${agentName(r.agent)} · ${windowName}`));
      head.append(make('span', { class: `chip src-${r.source}` }, t(`src_${r.source}`)));
      head.append(make('span', { class: 'room-pct' }, r.state === 'reset' ? '0%' : pctText(shown)));
      item.append(head);
      const bar = make('div', { class: 'meter', role: 'meter', 'aria-valuemin': '0', 'aria-valuemax': '100',
        'aria-valuenow': String(Math.round((shown ?? 0) * 100)), 'aria-label': `${agentName(r.agent)} ${windowName}` });
      bar.append(make('i', { style: `width:${Math.min(100, Math.max(0, (shown ?? 0) * 100))}%` }));
      item.append(bar);
      const details = [];
      if (r.resetsAt) details.push(r.state === 'reset' ? t('reset_done') : fill(t('resets'), { date: stamp(r.resetsAt) }));
      if (r.agent === 'opencode' && r.limit) details.push(`$${(r.used ?? 0).toFixed(2)} / $${r.limit}`);
      if (r.agent === 'claude') {
        details.push(`${short(r.used)} ${t('work_tokens').toLowerCase()}`);
        if (r.recordPct !== null && r.recordPct !== undefined) {
          details.push(fill(t('of_record'), { pct: pctText(r.recordPct), window: windowName, record: short(r.record) }));
        }
        details.push(r.refSource ? fill(t('ref_from'), { source: r.refSource })
          : fill(t('no_reference'), { plan: (r.plan || 'Pro').replace(/^./, (c) => c.toUpperCase()) }));
      }
      if (r.detail) details.push(r.detail);
      item.append(make('div', { class: 'room-detail' }, details.join(' · ')));
      return item;
    }));
  }

  function rankTable(target, label, entries, { nameOf = (e) => e.key, colorOf = () => 'var(--muted)' } = {}) {
    const table = make('table');
    const head = make('tr');
    head.append(make('th', {}, label));
    head.append(make('th', { title: t('work_hint') }, t('work_tokens')));
    head.append(make('th', {}, t('cache_read')));
    const thead = make('thead');
    thead.append(head);
    const tbody = make('tbody');
    const max = Math.max(1, ...entries.map((e) => e.work));
    for (const e of entries) {
      const tr = make('tr');
      const name = make('td', { class: 'rank-name' });
      name.append(make('span', { class: 'rank-bar', style: `width:${(e.work / max) * 100}%;--agent-color:${colorOf(e)}` }));
      name.append(make('span', {}, nameOf(e)));
      tr.append(name);
      const w = make('td'); w.append(num(e.work)); tr.append(w);
      const c = make('td'); c.append(num(e.cacheRead)); tr.append(c);
      tbody.append(tr);
    }
    table.append(thead, tbody);
    target.replaceChildren(table);
  }

  function paintSpenders() {
    const period = breakdown(rows, state.range);
    rankTable($('spendAgents'), t('agent'), period.agents, { nameOf: (e) => agentName(e.key), colorOf: (e) => COLORS[e.key] || 'var(--muted)' });
    rankTable($('spendProjects'), t('projects'), period.projects);
    rankTable($('spendModels'), t('models'), period.models);
    paintCards(inRange(rows, state.range));
  }

  /** Every date of a week/month selection (zeros included), or the dates with data. */
  function rangeDays(byDay) {
    if (!state.range) return [...byDay.keys()].sort();
    const days = [];
    for (let d = state.range[0]; d <= state.range[1]; d = new Date(Date.parse(d + 'T00:00:00Z') + 86400000).toISOString().slice(0, 10)) days.push(d);
    return days;
  }

  function paintDaily() {
    const byDay = group(inRange(rows, state.range), (row) => row.date);
    const days = rangeDays(byDay);
    const values = days.map((day) => byDay.get(day) || { claude: 0, opencode: 0, codex: 0 });
    drawChart($('dailyChart'), days, values, { daily: true });
    const head = make('tr');
    head.append(make('th', {}, t('daily_table')));
    for (const agent of AGENTS) head.append(make('th', {}, agentName(agent)));
    $('dailyHead').replaceChildren(head);
    $('dailyBody').replaceChildren(...days.map((day, i) => {
      const tr = make('tr');
      tr.append(make('td', {}, dateLabel(day)));
      for (const agent of AGENTS) { const td = make('td'); td.append(num(values[i][agent])); tr.append(td); }
      return tr;
    }));
  }

  function paintHourly() {
    const day = state.range ? state.range[0] : '';
    // Only Claude has a real hour per message; the others would pile a day into one hour.
    const selected = rows.filter((row) => row.date === day && row.agent === 'claude');
    const byHour = group(selected.filter((row) => Number.isInteger(row.hour)), (row) => row.hour);
    const hours = Array.from({ length: 24 }, (_, hour) => hour);
    const values = hours.map((hour) => byHour.get(hour) || { claude: 0, opencode: 0, codex: 0 });
    drawChart($('hourlyChart'), hours, values, { daily: false });

    const head = make('tr');
    head.append(make('th', {}, t('hour')));
    head.append(make('th', {}, agentName('claude')));
    $('hourlyHead').replaceChildren(head);
    $('hourlyBody').replaceChildren(...hours.filter((hour) => values[hour].claude > 0).map((hour) => {
      const tr = make('tr');
      tr.append(make('td', {}, `${String(hour).padStart(2, '0')}:00–${String((hour + 1) % 24).padStart(2, '0')}:00`));
      const td = make('td'); td.append(num(values[hour].claude)); tr.append(td);
      return tr;
    }));

    const unknown = group(selected.filter((row) => !Number.isInteger(row.hour)), (row) => row.date);
    const unknownValues = unknown.get(day) || { claude: 0, opencode: 0, codex: 0 };
    const hasUnknown = AGENTS.some((agent) => unknownValues[agent] > 0);
    const unknownLine = $('unknownHour');
    unknownLine.hidden = !hasUnknown;
    unknownLine.textContent = hasUnknown
      ? `${t('unknown_hour')}: ${AGENTS.map((agent) => `${agentName(agent)} ${format(unknownValues[agent])}`).join(' · ')}. ${t('unknown_note')}`
      : '';
  }

  function translate() {
    const copy = COPY[state.lang];
    $('dailyTitle').textContent = copy.daily_title;
    $('dailyHint').textContent = copy.daily_hint;
    $('metricLabel').textContent = copy.metric;
    $('hourlyTitle').textContent = copy.hourly_title;
    $('hourlyHint').textContent = copy.hourly_claude_note;
    $('roomTitle').textContent = copy.room_title;
    $('roomHint').textContent = copy.room_hint;
    $('spendTitle').textContent = copy.spend_title;
    $('spendHint').textContent = copy.spend_hint;
    paintStamp();
    paintRoom();
    $('dailyChart').setAttribute('aria-label', copy.daily_title);
    $('hourlyChart').setAttribute('aria-label', copy.hourly_title);
    const metricSelect = $('metric');
    const currentMetric = state.metric;
    metricSelect.replaceChildren(...METRICS.map((metric) => make('option', { value: metric }, copy[metric])));
    metricSelect.value = currentMetric;
    paintLegend($('dailyLegend'));
    paintLegend($('hourlyLegend'), ['claude']);
    calendar.render(); // clears the selection, then paints every range section
    $('footer').textContent = `${copy.generated.replace('{date}', LEDGER.generatedAt || '—')} ${copy.source}`;
  }

  /** Cards, chart and tables follow the calendar: a day shows hours, a week or month its days. */
  function paintRange() {
    const oneDay = Boolean(state.range && state.range[0] === state.range[1]);
    $('dailyCard').hidden = oneDay;
    $('hourlyCard').hidden = !oneDay;
    $('hourlyTitle').textContent = oneDay ? `${t('hourly_title')} · ${dateLabel(state.range[0])}` : t('hourly_title');
    if (oneDay) paintHourly(); else paintDaily();
    paintSpenders();
  }

  const calendar = createCalendar({
    root: $('usageCalendar'),
    days: dailyWork(rows),
    countText: (n) => `${short(n)} ${t('work_tokens').toLowerCase()}`,
    titleText: () => t('cal_title'),
    yearText: (total, year) => fill(t('cal_year'), { total: `<b>${short(total)}</b>`, year }),
    hintText: () => t('cal_hint'),
    onSelect: (range) => { state.range = range; paintRange(); },
    storageKey: 'usageCalendar',
  });
  $('metric').addEventListener('change', () => { state.metric = $('metric').value; paintRange(); });
  translate();
  initShell({ tab: 'ia', stamp: stampText, onLang: (next) => { state.lang = next; translate(); } });
})();
