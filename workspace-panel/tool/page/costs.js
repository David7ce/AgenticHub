// costs.js — offline daily and hourly usage charts for the local token ledger.

(() => {
  const COPY = {
    en: {
      latest: 'Snapshot',
      agents: { claude: 'Claude', opencode: 'OpenCode', codex: 'ChatGPT / Codex', zen: 'OpenCode · Zen', other: 'Other / unassigned' },
      cache_read_tokens: 'Cache read',
      cache_write_tokens: 'Cache write',
      input_tokens: 'Input',
      output_tokens: 'Output',
      reasoning_tokens: 'Reasoning',
      unknown_tokens: 'Undisclosed total',
      daily_title: 'Daily usage',
      daily_hint: 'Grouped by subscription, not client. Hover over a bar to see its models.',
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
      stale: 'over 6 h old — run: node workspace-panel/tool/cli.mjs refresh',
      room_title: 'Account limits',
      room_hint: 'Provider figures, separate from local usage.',
      scope: 'Subscriptions', plan_off: 'Not subscribed', no_subscriptions: 'No subscriptions selected.',
      model_filters: 'Filter by model',
      billing_hint: 'OpenCode’s current ChatGPT OAuth connection is used to infer attribution for OpenAI history when billing metadata is missing.',
      model_recommendation: 'Quality for cost: start with DeepSeek V4.1 Flash on Go for routine coding (15/15 in the local benchmark). Try Sonnet on Claude or a Codex model you already pay for if the first pass fails. Pick by results per task, not token volume.',
      benchmark: 'Local benchmark',
      go_usd: '≈ {amount} at base rates',
      inferred_use: '{amount} tentatively attributed from session metadata',
      quota_missing: 'No reading', quota_old: 'Old reading', quota_not_reported: 'Not reported',
      no_limits: 'No limits reading yet. Run: node workspace-panel/tool/cli.mjs costs --write',
      limits_error: 'Codex/Go reading failed: {error}',
      src_measured: 'measured', src_estimated: 'estimated', src_record: 'own record', src_free: 'free',
      resets: 'resets {date}', reset_done: 'already reset',
      of_record: '{pct} of your heaviest {window} ({record})',
      no_reference: 'No {plan} reference yet: it is filled in when a limit is first hit, or set it in workspace-panel/local/limits.json.',
      ref_from: 'Plan reference: {source}',
      win_5h: 'last 5 h', win_7d: 'last 7 days',
      week: 'Weekly', month: 'Monthly', '5h': '5 h', src_unavailable: 'no reading',
      settings: 'Settings · subscription plans', automatic: 'Auto', unknown_plan: 'Not detected',
      configured: 'Local setting',
      settings_hint: 'Select your plan if it is not detected. This does not change the account being measured.',
      src_manual: 'copied from console',
      go_manual: 'OpenCode Go: copy the current percentages and resets from your Console to workspace-panel/local/go-usage.json. No credentials needed.',
      month_unavailable: 'No monthly subscription meter reported.',
      claude_setup: 'For measured Claude limits, connect the Claude Code status line and use your subscription in the client.',
      reading: 'Reading: {date}',
      go_model: 'OpenCode · allowance by model',
      go_week_capacity: 'Weekly reference', go_month_capacity: 'Monthly reference',
      go_week_local: 'This week · local', go_recent_local: 'Last 30 days · local',
      go_equivalent: '{input} in or {output} out',
      go_summary: 'Shared allowance estimate from known local usage: {week} this week (UTC); {recent} of a monthly allowance over the last 30 days, not a billing cycle.',
      go_explainer: 'The models share one allowance. Equivalents assume one model, base rates and no cache. Local estimates use session start and base rates; they miss usage from other clients and can differ from the account.',
      codex_stats: 'Codex · account statistics and local history',
      codex_snapshot: 'Copied from the account dashboard on {date}. These numbers are not usage limits.',
      codex_local: 'Codex client only: {total} locally recorded tokens, {first} → {last}. Other clients are counted in the charts when attributable.',
      codex_sessions: 'Local scan: {sessions} threads.',
      codex_tokens: 'Local tokens',
      lifetimeTokens: 'Lifetime tokens', peakTokens: 'Peak tokens', longestChatMinutes: 'Longest chat',
      currentStreakDays: 'Current streak', longestStreakDays: 'Longest streak',
      spend_title: 'Who spends most',
      spend_hint: 'Local work tokens for the selected period and filters, not billed dollars. Cache reads are shown separately.',
      cal_title: 'Local usage history', cal_year: '{total} recorded work tokens in {year}', cal_hint: '— charts use only the local records for this period.',
      agent: 'Subscription', cache_read: 'Cache read',
      projects: 'Projects', models: 'Models',
      hourly_claude_note: 'Claude messages, Codex calls and OpenCode replies at their own hour; OpenCode session totals only have a start time and are left out.',
    },
    es: {
      latest: 'Snapshot',
      agents: { claude: 'Claude', opencode: 'OpenCode', codex: 'ChatGPT / Codex', zen: 'OpenCode · Zen', other: 'Otros / sin atribuir' },
      cache_read_tokens: 'Lectura de caché',
      cache_write_tokens: 'Escritura de caché',
      input_tokens: 'Entrada',
      output_tokens: 'Salida',
      reasoning_tokens: 'Razonamiento',
      unknown_tokens: 'Total sin desglose',
      daily_title: 'Uso diario',
      daily_hint: 'Agrupado por suscripción, no por cliente. Pasa el cursor por una barra para ver sus modelos.',
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
      stale: 'más de 6 h de antigüedad — ejecuta: node workspace-panel/tool/cli.mjs refresh',
      room_title: 'Cuota de la cuenta',
      room_hint: 'Datos del proveedor, separados del uso local.',
      scope: 'Suscripciones', plan_off: 'No tengo suscripción', no_subscriptions: 'No hay suscripciones seleccionadas.',
      model_filters: 'Filtrar por modelo',
      billing_hint: 'La conexión actual de OpenCode por OAuth de ChatGPT se usa para inferir a qué plan pertenece el historial OpenAI cuando el registro no indica quién lo cubrió.',
      model_recommendation: 'Calidad-precio: empieza con DeepSeek V4.1 Flash en Go para código habitual (15/15 en el benchmark local). Si no resuelve la tarea, prueba Sonnet en Claude o un modelo de Codex que ya pagues. Compara resultados por tarea, no volumen de tokens.',
      benchmark: 'Benchmark local',
      go_usd: '≈ {amount} a tarifa base',
      inferred_use: '{amount} atribuidos provisionalmente según la sesión',
      quota_missing: 'Sin lectura', quota_old: 'Lectura antigua', quota_not_reported: 'No informado',
      no_limits: 'Aún no hay lectura de límites. Ejecuta: node workspace-panel/tool/cli.mjs costs --write',
      limits_error: 'Falló la lectura de Codex/Go: {error}',
      src_measured: 'medido', src_estimated: 'estimado', src_record: 'tu récord', src_free: 'gratis',
      resets: 'se reinicia {date}', reset_done: 'ya se reinició',
      of_record: '{pct} de tu {window} más intensa ({record})',
      no_reference: 'Aún no hay referencia de {plan}: se rellena la primera vez que llegues al límite, o ponla en workspace-panel/local/limits.json.',
      ref_from: 'Referencia del plan: {source}',
      win_5h: 'últimas 5 h', win_7d: 'últimos 7 días',
      week: 'Semanal', month: 'Mensual', '5h': '5 h', src_unavailable: 'sin lectura',
      settings: 'Ajustes · planes de suscripción', automatic: 'Automático', unknown_plan: 'No detectado',
      configured: 'Configuración local',
      settings_hint: 'Elige tu plan si no se detecta. Esto no cambia la cuenta cuya cuota se mide.',
      src_manual: 'copiado de consola',
      go_manual: 'OpenCode Go: copia los porcentajes y reinicios vigentes de tu consola a workspace-panel/local/go-usage.json. No hacen falta credenciales.',
      month_unavailable: 'La lectura de la suscripción no incluye un límite mensual.',
      claude_setup: 'Para ver los límites medidos de Claude, conecta la barra de estado de Claude Code y usa tu suscripción en el cliente.',
      reading: 'Lectura: {date}',
      go_model: 'OpenCode · cuota por modelo',
      go_week_capacity: 'Referencia semanal', go_month_capacity: 'Referencia mensual',
      go_week_local: 'Esta semana · local', go_recent_local: 'Últimos 30 días · local',
      go_equivalent: '{input} de entrada o {output} de salida',
      go_summary: 'Cuota compartida estimada a partir del uso local conocido: {week} esta semana (UTC); {recent} de una cuota mensual en los últimos 30 días, no en el ciclo de facturación.',
      go_explainer: 'Los modelos comparten la cuota. Las equivalencias suponen un solo modelo, tarifa base y sin caché. La estimación local usa el inicio de sesión y tarifas base, no ve otros clientes y puede diferir de lo que marca la cuenta.',
      codex_stats: 'Codex · estadísticas de cuenta e historial local',
      codex_snapshot: 'Datos copiados de la cuenta el {date}. No son límites de uso.',
      codex_local: 'Solo cliente Codex: {total} tokens locales, del {first} al {last}. En las gráficas se suman otros clientes cuando se puede atribuir su uso.',
      codex_sessions: 'Lectura local: {sessions} hilos.',
      codex_tokens: 'Tokens locales',
      lifetimeTokens: 'Tokens acumulados', peakTokens: 'Pico de tokens', longestChatMinutes: 'Chat más largo',
      currentStreakDays: 'Racha actual', longestStreakDays: 'Racha más larga',
      spend_title: 'Quién gasta más',
      spend_hint: 'Tokens de trabajo locales del periodo y filtros elegidos, no dinero facturado. Las lecturas de caché van aparte.',
      cal_title: 'Historial local de uso', cal_year: '{total} tokens de trabajo registrados en {year}', cal_hint: '— las gráficas solo usan los registros locales de este periodo.',
      agent: 'Suscripción', cache_read: 'Lectura de caché',
      projects: 'Proyectos', models: 'Modelos',
      hourly_claude_note: 'Mensajes de Claude, llamadas de Codex y respuestas de OpenCode a su hora; los totales de sesión de OpenCode solo tienen el inicio y quedan fuera.',
    },
  };

  const COLORS = { claude: 'var(--claude)', opencode: 'var(--opencode)', codex: 'var(--codex)', zen: 'var(--zen)', other: 'var(--muted)' };
  const SUBSCRIPTIONS = ['claude', 'opencode', 'codex'];
  // Groups with no plan or allowance: shown only when they have rows.
  const UNPLANNED = ['zen', 'other'];
  const AGENTS = [...SUBSCRIPTIONS, ...UNPLANNED];
  const PLANS = {
    opencode: { go: 'Go', 'go-plus': 'Go Plus', 'go-teams': 'Go Teams' },
    codex: { free: 'Free', go: 'Go', plus: 'Plus', pro: 'Pro', business: 'Business', enterprise: 'Enterprise', edu: 'Edu' },
    claude: { pro: 'Pro', max: 'Max', ultra: 'Ultra', team: 'Team', enterprise: 'Enterprise' },
  };
  const planChoice = Object.fromEntries(SUBSCRIPTIONS.map((agent) => [agent, readStored(`usage.plan.${agent}`)]));
  const detectedPlan = (agent) => VIEW.detectedPlans?.[agent];
  const configuredPlan = (agent) => VIEW.configuredPlans?.[agent];
  const selectedPlan = (agent) => PLANS[agent]?.[planChoice[agent]] ? planChoice[agent] : null;
  const planName = (agent, plan) => PLANS[agent]?.[plan] ?? plan;
  const enabledAgents = () => AGENTS.filter((agent) => UNPLANNED.includes(agent) ? rows.some((r) => r.agent === agent) : planChoice[agent] !== 'off');
  const visibleAgents = () => enabledAgents().filter((agent) => !hiddenSubscriptions.has(agent));
  const visibleRows = () => {
    const active = new Set(visibleAgents());
    return rows.filter((row) => active.has(row.agent) && !hiddenModels.has(modelScopeKey(row)));
  };
  const METRICS = ['work_tokens', 'cache_read_tokens', 'cache_write_tokens', 'input_tokens', 'output_tokens', 'reasoning_tokens', 'unknown_tokens'];
  const state = { lang: shellLang(), metric: 'work_tokens', range: null };
  const rows = billedRows(LEDGER.rows ?? [], VIEW.openAiViaChatGpt);
  const goPrices = new Map((VIEW.goModels ?? []).map((m) => [m.id, m]));
  const storedSet = (key) => {
    try { const items = JSON.parse(readStored(key)); return new Set(Array.isArray(items) ? items : []); }
    catch { return new Set(); }
  };
  const hiddenSubscriptions = storedSet('usage.hiddenSubscriptions');
  const hiddenModels = storedSet('usage.hiddenModels');
  const $ = (id) => document.getElementById(id);
  const t = (key) => COPY[state.lang][key];
  const fill = (text, values) => text.replace(/\{(\w+)\}/g, (_, key) => values[key] ?? '');
  const format = (n) => formatNumber(n, state.lang);
  const usd = (n) => new Intl.NumberFormat(state.lang, { style: 'currency', currency: 'USD', maximumFractionDigits: 4 }).format(n);
  const goCost = (row) => {
    const rate = row.agent === 'opencode' && goPrices.get(row.model);
    return rate ? ((row.input_tokens ?? 0) * rate.input + (row.output_tokens ?? 0) * rate.output
      + (row.cache_read_tokens ?? 0) * (rate.cacheRead ?? 0) + (row.cache_write_tokens ?? 0) * (rate.cacheWrite ?? 0)) / 1e6 : 0;
  };
  const work = (row) => (Number(row.input_tokens) || 0) + (Number(row.output_tokens) || 0)
    + (Number(row.cache_write_tokens) || 0) + (Number(row.unknown_tokens) || 0);
  const valueOf = (row, metric) => (metric === 'work_tokens' ? work(row) : Number(row[metric]) || 0);
  const short = (n) => shortTokens(n);
  const pctText = (p) => !Number.isFinite(p) ? '—' : new Intl.NumberFormat(state.lang, {
    style: 'percent', maximumFractionDigits: 1,
  }).format(p < 1 ? Math.min(.999, p) : p);
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
      if (!out.has(key)) out.set(key, { models: new Map(), goCosts: new Map(), inferred: new Map() });
      const entry = out.get(key);
      const value = valueOf(row, state.metric);
      entry[row.agent] = (entry[row.agent] ?? 0) + value;
      const cost = goCost(row);
      if (cost > 0) entry.goCosts.set(row.model, (entry.goCosts.get(row.model) ?? 0) + cost);
      if (!value) continue;
      if (!entry.models.has(row.agent)) entry.models.set(row.agent, new Map());
      const models = entry.models.get(row.agent);
      models.set(row.model, (models.get(row.model) ?? 0) + value);
      if (row.inferred) {
        const id = modelScopeKey(row);
        entry.inferred.set(id, (entry.inferred.get(id) ?? 0) + value);
      }
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
    const bars = visibleAgents();
    const labelFor = (entry, key, agent, value) => {
      const when = daily ? dateLabel(key) : `${String(key).padStart(2, '0')}:00 UTC`;
      const models = [...(entry.models?.get(agent) ?? [])].sort((a, b) => b[1] - a[1]);
      const head = `${when} · ${scopeName(agent)} · ${t(state.metric)}: ${format(value)}`;
      return [head, ...models.map(([name, n]) => {
        const cost = agent === 'opencode' && entry.goCosts?.get(name);
        const inferred = entry.inferred?.get(modelScopeKey({ agent, model: name }));
        return [`${name}: ${format(n)}`, cost && fill(t('go_usd'), { amount: usd(cost) }),
          inferred && fill(t('inferred_use'), { amount: format(inferred) })].filter(Boolean).join(' · ');
      })].join('\n');
    };
    keys.forEach((key, index) => {
      const entry = values[index];
      const center = left + slot * index + slot / 2;
      if (daily) {
        const barWidth = Math.min(42, slot * .58);
        let stacked = 0;
        for (const agent of bars) {
          const value = entry[agent] || 0;
          if (!value) continue;
          const y1 = axis(stacked + value);
          const y2 = axis(stacked);
          const tip = labelFor(entry, key, agent, value);
          const rect = svgNode('rect', {
            x: center - barWidth / 2, y: y1, width: barWidth, height: Math.max(1, y2 - y1),
            fill: COLORS[agent], class: 'bar', tabindex: '0', 'aria-label': tip,
          });
          rect.append(svgNode('title', {}, tip));
          svg.append(rect);
          stacked += value;
        }
      } else {
        const barWidth = Math.min(10, slot * .17);
        bars.forEach((agent, agentIndex) => {
          const value = entry[agent] || 0;
          if (!value) return;
          const x = center + (agentIndex - (bars.length - 1) / 2) * (barWidth + 2) - barWidth / 2;
          const y = axis(value);
          const tip = labelFor(entry, key, agent, value);
          const rect = svgNode('rect', { x, y, width: barWidth, height: Math.max(1, top + plotHeight - y), fill: COLORS[agent], class: 'bar', tabindex: '0', 'aria-label': tip });
          rect.append(svgNode('title', {}, tip));
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
      item.append(document.createTextNode(scopeName(agent)));
      return item;
    }));
  }

  function paintCards(selected) {
    const totals = totalsByAgent(selected);
    $('agents').replaceChildren(...visibleAgents().map((agent) => {
      const card = make('article', { class: 'agent-card', style: `--agent-color:${COLORS[agent]}` });
      card.append(make('div', { class: 'agent-name' }, scopeName(agent)));
      const value = make('div', { class: 'agent-value' });
      value.append(num(work(totals[agent])));
      card.append(value);
      card.append(make('div', { class: 'agent-metric', title: t('work_hint') }, t('work_tokens')));
      const inferred = selected.filter((r) => r.agent === agent && r.inferred).reduce((sum, r) => sum + work(r), 0);
      if (inferred) card.append(make('p', { class: 'note' }, fill(t('inferred_use'), { amount: short(inferred) })));
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

  function scopeName(agent) {
    const plan = selectedPlan(agent) || detectedPlan(agent) || configuredPlan(agent);
    return [agentName(agent), planName(agent, plan)].filter(Boolean).join(' · ');
  }

  function paintScope() {
    $('scopeLabel').textContent = t('scope');
    $('scope').replaceChildren(...enabledAgents().map((agent) => toggle(scopeName(agent), agent, hiddenSubscriptions, 'usage.hiddenSubscriptions', () => {
      paintModelScope();
      applyScope();
    })));
    paintModelScope();
  }

  function toggle(text, id, hidden, storage, change) {
    const label = make('label');
    const input = make('input', { type: 'checkbox', value: id });
    input.checked = !hidden.has(id);
    input.onchange = () => {
      if (input.checked) hidden.delete(id);
      else hidden.add(id);
      writeStored(storage, JSON.stringify([...hidden]));
      change();
    };
    label.append(input, document.createTextNode(text));
    return label;
  }

  function paintModelScope() {
    $('modelScopeTitle').textContent = t('model_filters');
    const lists = [];
    for (const agent of visibleAgents()) {
      const models = new Map(rows.filter((r) => r.agent === agent).map((r) => [modelScopeKey(r), r.model]));
      if (!models.size) continue;
      const field = make('fieldset', { class: 'scope-field' });
      const group = make('div', { class: 'scope-toggles' });
      group.append(...[...models.entries()].sort((a, b) => a[1].localeCompare(b[1], state.lang))
        .map(([id, name]) => {
          const chip = toggle(name, id, hiddenModels, 'usage.hiddenModels', applyScope);
          const plan = selectedPlan('opencode') || configuredPlan('opencode') || 'go';
          const rate = agent === 'opencode' && goPrices.get(name);
          const month = rate && rate.monthly[plan];
          if (month) chip.title = [[t('week'), month / 2], [t('month'), month]].map(([period, limit]) =>
            `${period}: ${usd(limit)} · ${fill(t('go_equivalent'), {
              input: short(limit * 1e6 / rate.input), output: short(limit * 1e6 / rate.output),
            })}`).join('\n');
          return chip;
        }));
      field.append(make('legend', {}, scopeName(agent)), group);
      lists.push(field);
    }
    $('modelScope').hidden = !lists.length;
    $('modelToggles').replaceChildren(...lists);
  }

  function applyScope() {
    paintRoom();
    paintCodexStats();
    paintLegend($('dailyLegend'), visibleAgents());
    calendar.setDays(dailyWork(visibleRows()));
  }

  function paintSettings() {
    $('usageSettingsTitle').textContent = t('settings');
    $('usageSettingsHint').textContent = t('settings_hint');
    $('planOptions').replaceChildren(...SUBSCRIPTIONS.map((agent) => {
      const label = make('label', { class: 'filter' }, `${agentName(agent)} `);
      const select = make('select');
      const config = configuredPlan(agent);
      select.append(make('option', { value: '' }, config
        ? `${t('configured')} · ${planName(agent, config)}`
        : `${t('automatic')} · ${planName(agent, detectedPlan(agent)) || t('unknown_plan')}`));
      for (const [id, name] of Object.entries(PLANS[agent])) select.append(make('option', { value: id }, name));
      select.append(make('option', { value: 'off' }, t('plan_off')));
      select.value = planChoice[agent] === 'off' ? 'off' : selectedPlan(agent) || '';
      select.onchange = () => {
        planChoice[agent] = select.value;
        writeStored(`usage.plan.${agent}`, select.value);
        paintScope();
        applyScope();
      };
      label.append(select);
      return label;
    }));
  }

  function paintCodexStats() {
    const active = visibleAgents().includes('codex');
    const account = active ? VIEW.codexAccount : null;
    const local = active ? VIEW.codexLocal : null;
    $('codexStatsCard').hidden = !account && !local;
    $('codexStatsTitle').textContent = t('codex_stats');
    const target = $('codexStats');
    target.replaceChildren();
    const millions = (value) => `${new Intl.NumberFormat(state.lang, { maximumFractionDigits: 1 }).format(value / 1e6)} M`;
    const unit = (value, unit) => new Intl.NumberFormat(state.lang, { style: 'unit', unit }).format(value);
    const formats = {
      lifetimeTokens: millions, peakTokens: millions,
      longestChatMinutes: (n) => n >= 60 && n % 60 === 0 ? unit(n / 60, 'hour') : unit(n, 'minute'),
      currentStreakDays: (n) => unit(n, 'day'), longestStreakDays: (n) => unit(n, 'day'),
    };
    if (account) {
      target.append(make('p', { class: 'note' }, fill(t('codex_snapshot'), { date: dateLabel(account.measuredOn) })));
      const stats = make('div', { class: 'usage-options' });
      for (const field of Object.keys(formats)) {
        if (!Number.isFinite(account[field])) continue;
        const item = make('div', { class: 'room-row', style: `--agent-color:${COLORS.codex}` });
        item.append(make('strong', {}, formats[field](account[field])), make('div', { class: 'room-detail' }, t(field)));
        stats.append(item);
      }
      target.append(stats);
    }
    if (local) {
      const coverage = fill(t('codex_local'), { total: format(local.tokens), first: dateLabel(local.first), last: dateLabel(local.last) });
      const sessions = Number.isFinite(local.sessions) ? ` ${fill(t('codex_sessions'), { sessions: format(local.sessions) })}` : '';
      target.append(make('p', { class: 'note' }, coverage + sessions));
    }
  }

  function paintRoom() {
    const list = $('roomList');
    const note = $('roomNote');
    const notes = [];
    const agents = visibleAgents().filter((agent) => !UNPLANNED.includes(agent));
    const now = Date.now();
    if (VIEW.noLimits) notes.push(t('no_limits'));
    if (VIEW.limitsError && agents.includes('codex')) notes.push(fill(t('limits_error'), { error: VIEW.limitsError }));
    const embedded = (VIEW.room || []).filter((r) => ['measured', 'manual'].includes(r.source));
    const account = publishedAccount
      ? [...embedded.filter((r) => r.agent === 'claude'), ...publishedAccount.rows]
      : embedded;
    const windowOf = (agent, period) => {
      const saved = account.find((r) => r.agent === agent && (r.label === period
        || (agent === 'claude' && r.label === '7d' && period === 'week')));
      const live = agent === 'claude' ? claudeLive.get(period) : null;
      return live && (!saved?.measuredAt || Date.parse(live.measuredAt) >= Date.parse(saved.measuredAt)) ? live : saved;
    };
    const hasCurrent = (agent) => ['week', 'month'].some((period) => Date.parse(windowOf(agent, period)?.resetsAt) > now);
    if (agents.includes('opencode') && !hasCurrent('opencode')) notes.push(t('go_manual'));
    if (agents.includes('claude') && !hasCurrent('claude')) notes.push(t('claude_setup'));
    if (VIEW.openAiViaChatGpt && agents.includes('codex')) notes.push(t('billing_hint'));
    note.textContent = notes.join(' ');
    note.hidden = !notes.length;
    if (!agents.length) {
      list.replaceChildren(make('p', { class: 'note' }, t('no_subscriptions')));
      return;
    }
    const table = make('table', { class: 'quota-table' });
    const thead = make('thead');
    const head = make('tr'); head.append(...['scope', 'week', 'month'].map((k) => make('th', { scope: 'col' }, t(k))));
    thead.append(head);
    const body = make('tbody');
    for (const agent of agents) {
      const row = make('tr', { 'data-agent': agent });
      row.append(make('th', { scope: 'row', class: 'quota-name', style: `--agent-color:${COLORS[agent]}` }, scopeName(agent)));
      for (const period of ['week', 'month']) {
        const r = windowOf(agent, period);
        const expired = Date.parse(r?.resetsAt) <= now;
        const old = now - Date.parse(r?.measuredAt) > 6 * 3600_000;
        const shown = expired ? null : r?.pct;
        const valueClass = old ? ' quota-old' : shown >= .8 ? ' quota-high' : '';
        const reset = r?.resetsAt && fill(t('resets'), { date: stamp(r.resetsAt) });
        const date = r?.measuredAt && fill(t('reading'), { date: stamp(r.measuredAt) });
        const note = expired ? t('reset_done') : old ? t('quota_old') : shown != null ? reset
          : period === 'month' && agent !== 'opencode' ? t('quota_not_reported') : t('quota_missing');
        const cell = make('td', { title: [r && t(`src_${r.source}`), date, reset].filter(Boolean).join(' · ') });
        cell.append(make('strong', { class: `quota-value${valueClass}` }, pctText(shown)));
        if (note) cell.append(make('span', { class: 'quota-note' }, note));
        row.append(cell);
      }
      body.append(row);
    }
    table.append(thead, body);
    list.replaceChildren(table);
  }

  const claudeLive = new Map();
  let publishedAccount = null;
  window.acceptAccountUsage = (snapshot) => {
    const at = Date.parse(snapshot?.generatedAt);
    if (!Number.isFinite(at) || at < (Date.parse(publishedAccount?.generatedAt ?? VIEW.limitsAt) || 0)
        || !Array.isArray(snapshot.rows)) return;
    publishedAccount = snapshot;
  };
  window.acceptClaudeUsage = (snapshot) => {
    const stampMs = Date.parse(snapshot?.measuredAt ?? '');
    if (!Number.isFinite(stampMs) || !Array.isArray(snapshot?.windows)) return;
    for (const w of snapshot.windows) {
      if (!['week', '5h'].includes(w?.label) || !Number.isFinite(w.usedPercent)
          || w.usedPercent < 0 || w.usedPercent > 100 || !(Date.parse(w.resetsAt) > stampMs)) continue;
      if (stampMs < Date.parse(claudeLive.get(w.label)?.measuredAt)) continue;
      const pct = w.usedPercent / 100;
      claudeLive.set(w.label, {
        id: w.label === 'week' ? 'claude-7d' : 'claude-5h', agent: 'claude', label: w.label, pct,
        resetsAt: w.resetsAt, measuredAt: snapshot.measuredAt, source: 'measured', state: pct >= .8 ? 'high' : 'ok',
      });
    }
  };

  let pendingRead = false;
  function refreshVisibleLimits() {
    if (document.hidden || pendingRead) return;
    paintRoom(); // also expires account readings even when the local file hasn't changed
    const files = ['account-usage-live.js', 'claude-usage-live.js'];
    let remaining = files.length;
    pendingRead = true;
    for (const file of files) {
      const script = make('script', { src: `shared/${file}?t=${Date.now()}` });
      script.onload = script.onerror = () => {
        script.remove();
        if (--remaining === 0) {
          pendingRead = false;
          if (!document.hidden) paintRoom();
        }
      };
      document.head.append(script);
    }
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
      const w = make('td'); w.append(num(e.work));
      if (e.inferredWork) w.append(make('span', { title: fill(t('inferred_use'), { amount: format(e.inferredWork) }) }, ' ≈'));
      tr.append(w);
      const c = make('td'); c.append(num(e.cacheRead)); tr.append(c);
      tbody.append(tr);
    }
    table.append(thead, tbody);
    target.replaceChildren(table);
  }

  function paintSpenders() {
    const visible = visibleRows();
    const period = breakdown(visible, state.range);
    rankTable($('spendAgents'), t('agent'), period.agents, { nameOf: (e) => scopeName(e.key), colorOf: (e) => COLORS[e.key] || 'var(--muted)' });
    rankTable($('spendProjects'), t('projects'), period.projects);
    rankTable($('spendModels'), t('models'), period.models, { nameOf: (e) => {
      const [agent, ...model] = e.key.split(' · ');
      return `${scopeName(agent)} · ${model.join(' · ')}`;
    } });
    paintCards(inRange(visible, state.range));
  }

  /** Every date of a week/month selection (zeros included), or the dates with data. */
  function rangeDays(byDay) {
    if (!state.range) return [...byDay.keys()].sort();
    const days = [];
    for (let d = state.range[0]; d <= state.range[1]; d = new Date(Date.parse(d + 'T00:00:00Z') + 86400000).toISOString().slice(0, 10)) days.push(d);
    return days;
  }

  function paintDaily() {
    const byDay = group(inRange(visibleRows(), state.range), (row) => row.date);
    const days = rangeDays(byDay);
    const values = days.map((day) => byDay.get(day) || {});
    drawChart($('dailyChart'), days, values, { daily: true });
  }

  function paintHourly() {
    const day = state.range ? state.range[0] : '';
    // Only rows timed per step; session totals at their start would pile a day into one hour.
    const dayRows = visibleRows().filter((row) => row.date === day);
    const selected = dayRows.filter(hasStepHour);
    const byHour = group(selected, (row) => row.hour);
    const hours = Array.from({ length: 24 }, (_, hour) => hour);
    const values = hours.map((hour) => byHour.get(hour) || {});
    drawChart($('hourlyChart'), hours, values, { daily: false });

    const unknown = group(dayRows.filter((row) => row.source === 'claude-code' && !Number.isInteger(row.hour)), (row) => row.date);
    const unknownValues = unknown.get(day) || {};
    const unknownTotal = Object.values(unknownValues).reduce((sum, value) => sum + (Number(value) || 0), 0);
    const hasUnknown = unknownTotal > 0;
    const unknownLine = $('unknownHour');
    unknownLine.hidden = !hasUnknown;
    unknownLine.textContent = hasUnknown
      ? `${t('unknown_hour')}: ${format(unknownTotal)}. ${t('unknown_note')}`
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
    $('modelRecommendation').replaceChildren(document.createTextNode(`${copy.model_recommendation} `),
      make('a', { href: '../../agent-hub/docs/benchmarks/README.md#results-so-far-2026-10-30' }, copy.benchmark));
    paintStamp();
    paintSettings();
    paintScope();
    $('dailyChart').setAttribute('aria-label', copy.daily_title);
    $('hourlyChart').setAttribute('aria-label', copy.hourly_title);
    const metricSelect = $('metric');
    const currentMetric = state.metric;
    metricSelect.replaceChildren(...METRICS.map((metric) => make('option', { value: metric }, copy[metric])));
    metricSelect.value = currentMetric;
    paintLegend($('hourlyLegend'), ['claude']);
    applyScope();
    $('footer').textContent = `${copy.generated.replace('{date}', LEDGER.generatedAt || '—')} ${copy.source}`;
  }

  /** Cards, chart and tables follow the calendar: a day shows hours, a week or month its days. */
  function paintRange() {
    const agents = visibleAgents();
    const empty = !agents.length;
    // A single day reads better by hour; every source with per-step times is drawn.
    const hourly = !empty && Boolean(state.range) && state.range[0] === state.range[1];
    $('usageCalendar').hidden = empty;
    $('dailyCard').hidden = empty || hourly;
    $('hourlyCard').hidden = !hourly;
    $('spenders').hidden = empty;
    if (hourly) {
      $('hourlyTitle').textContent = `${t('hourly_title')} · ${dateLabel(state.range[0])}`;
      paintHourly();
    } else if (!empty) paintDaily();
    paintSpenders();
  }

  const calendar = createCalendar({
    root: $('usageCalendar'),
    days: dailyWork(visibleRows()),
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
  document.addEventListener('visibilitychange', refreshVisibleLimits);
  window.setInterval(refreshVisibleLimits, 60_000);
  refreshVisibleLimits();
})();
