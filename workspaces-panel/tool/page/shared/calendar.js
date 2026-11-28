// Year heatmap shared by Projects and AI Usage. Data and selection bounds are
// ISO dates in UTC; the chosen calendar controls year and month boundaries.
const CAL_COPY = {
  es: {
    locale: 'es-ES', groupBy: 'Agrupar por', day: 'Día', week: 'Semana', month: 'Mes', year: 'Año',
    prevYear: 'Año anterior', nextYear: 'Año siguiente', less: 'Menos', more: 'Más', clear: 'Quitar',
    tipDay: '{value} el {label}', tipWeek: '{value} en la semana del {label}', tipMonth: '{value} en {label}',
    weekOf: 'Semana del {label}', calendar: 'Calendario', mondayFirst: 'Lunes primero',
    weekStartHelp: 'Desactivado: la semana empieza en domingo.',
    gregory: 'Gregoriano', 'islamic-civil': 'Islámico (civil)',
    hebrew: 'Hebreo', persian: 'Persa', buddhist: 'Budista', chinese: 'Chino',
  },
  en: {
    locale: 'en-US', groupBy: 'Group by', day: 'Day', week: 'Week', month: 'Month', year: 'Year',
    prevYear: 'Previous year', nextYear: 'Next year', less: 'Less', more: 'More', clear: 'Clear',
    tipDay: '{value} on {label}', tipWeek: '{value} in the week of {label}', tipMonth: '{value} in {label}',
    weekOf: 'Week of {label}', calendar: 'Calendar', mondayFirst: 'Monday first',
    weekStartHelp: 'Off: the week starts on Sunday.',
    gregory: 'Gregorian', 'islamic-civil': 'Islamic (civil)',
    hebrew: 'Hebrew', persian: 'Persian', buddhist: 'Buddhist', chinese: 'Chinese',
  },
};

const CAL_SYSTEMS = ['gregory', 'islamic-civil', 'hebrew', 'persian', 'buddhist', 'chinese'];
const calDate = (iso) => new Date(iso + 'T00:00:00Z');
const calIso = (date) => date.toISOString().slice(0, 10);

/** 4 GitHub-style levels against the view's own maximum. */
function bucketLevels(counts) {
  const max = Math.max(0, ...counts.values());
  return new Map([...counts].map(([key, count]) => [key, {
    count, level: count > 0 && max > 0 ? Math.min(4, Math.ceil((count / max) * 4)) : 0,
  }]));
}

function addDays(iso, n) {
  const d = calDate(iso);
  d.setUTCDate(d.getUTCDate() + n);
  return calIso(d);
}

function weekOffset(iso, firstDay = 0) {
  return (calDate(iso).getUTCDay() - firstDay + 7) % 7;
}

function weekStart(iso, firstDay = 0) {
  return addDays(iso, -weekOffset(iso, firstDay));
}

function mondayFirst(query, stored) {
  if (query === 'monday' || query === 'sunday') return query === 'monday';
  return stored !== '0';
}

const calFormatters = new Map();
function calendarParts(iso, system) {
  if (system === 'gregory') return { year: iso.slice(0, 4), day: Number(iso.slice(-2)) };
  if (!calFormatters.has(system)) calFormatters.set(system, new Intl.DateTimeFormat('en', {
    calendar: system, numberingSystem: 'latn', year: 'numeric', day: 'numeric', month: 'numeric', timeZone: 'UTC',
  }));
  const p = Object.fromEntries(calFormatters.get(system).formatToParts(calDate(iso)).map(({ type, value }) => [type, value]));
  return { year: p.relatedYear ?? p.year, day: Number(p.day) };
}

function calendarMonthKey(iso, system) {
  // The ISO first day is unique even for calendars that repeat a month name in a leap year.
  return system === 'gregory' ? iso.slice(0, 7) : addDays(iso, 1 - calendarParts(iso, system).day);
}

function aggregateActivity(days, firstDay = 0, system = 'gregory') {
  const sums = { day: new Map(), week: new Map(), month: new Map() };
  for (const [date, count] of days) {
    for (const [granularity, key] of [['day', date], ['week', weekStart(date, firstDay)], ['month', calendarMonthKey(date, system)]]) {
      sums[granularity].set(key, (sums[granularity].get(key) || 0) + count);
    }
  }
  return { day: bucketLevels(sums.day), week: bucketLevels(sums.week), month: bucketLevels(sums.month) };
}

/** Inclusive ISO dates of one heatmap block. */
function periodRange(granularity, key, system = 'gregory') {
  if (granularity === 'day') return [key, key];
  if (granularity === 'week') return [key, addDays(key, 6)];
  if (system === 'gregory') {
    const start = `${key}-01`;
    const d = calDate(start);
    d.setUTCMonth(d.getUTCMonth() + 1, 0);
    return [start, calIso(d)];
  }
  let next = addDays(key, 28);
  while (calendarMonthKey(next, system) === key) next = addDays(next, 1);
  return [key, addDays(next, -1)];
}

function calendarYearRange(iso, system) {
  if (system === 'gregory') return [iso.slice(0, 4) + '-01-01', iso.slice(0, 4) + '-12-31'];
  const year = calendarParts(iso, system).year;
  if (year == null) throw new Error(`No year from calendar ${system}`);
  const boundary = (sign) => {
    let edge = iso;
    while (calendarParts(addDays(edge, sign * 28), system).year === year) edge = addDays(edge, sign * 28);
    while (calendarParts(addDays(edge, sign), system).year === year) edge = addDays(edge, sign);
    return edge;
  };
  return [boundary(-1), boundary(1)];
}

function createCalendar({ root, days, countText, titleText, yearText, hintText, onSelect, storageKey }) {
  const part = (name) => root.querySelector('[data-cal="' + name + '"]');
  const yearEl = part('year');
  const granularityEl = part('granularity');
  const systemEl = part('calendar');
  const weekStartEl = part('weekStart');
  const weeksEl = part('weeks');
  const monthsEl = part('months');
  const params = new URLSearchParams(location.search);
  const preferred = params.get('calendar') || readStored('calendar.system');
  const supported = CAL_SYSTEMS.filter((id) => new Intl.DateTimeFormat('en', { calendar: id }).resolvedOptions().calendar === id);
  for (const id of supported) {
    const option = document.createElement('option');
    option.value = id;
    systemEl.append(option);
  }
  systemEl.value = supported.includes(preferred) ? preferred : 'gregory';
  weekStartEl.checked = mondayFirst(params.get('weekStart'), readStored('calendar.firstDay'));
  const today = () => calIso(new Date());
  const system = () => systemEl.value;
  const firstDay = () => Number(weekStartEl.checked);
  const copy = () => CAL_COPY[shellLang()];
  const localized = new Map();
  const fmt = (options) => {
    const key = JSON.stringify([copy().locale, system(), options]);
    if (!localized.has(key)) localized.set(key, new Intl.DateTimeFormat(copy().locale, { calendar: system(), timeZone: 'UTC', ...options }));
    return localized.get(key);
  };
  const say = (key, vars = {}) => copy()[key].replace(/\{(\w+)\}/g, (_, name) => vars[name] ?? '');
  let sourceDays = days;
  let levels;
  let years;
  let selection = null;
  let tabStop = null;

  let tooltip = document.getElementById('tooltip');
  if (!tooltip) {
    tooltip = document.createElement('div');
    tooltip.id = 'tooltip';
    tooltip.setAttribute('role', 'tooltip');
    document.body.appendChild(tooltip);
  }
  if (storageKey) {
    if (readStored(storageKey) === 'closed') root.open = false;
    root.addEventListener('toggle', () => writeStored(storageKey, root.open ? 'open' : 'closed'));
  }
  if (['day', 'week', 'month'].includes(params.get('granularity'))) granularityEl.value = params.get('granularity');

  const yearLabel = (iso) => fmt({ year: 'numeric' }).format(calDate(iso));
  function replaceDays(nextDays, anchor) {
    sourceDays = nextDays;
    levels = aggregateActivity(sourceDays, firstDay(), system());
    const dates = [today(), ...sourceDays.keys()].sort();
    years = [];
    for (let iso = dates[0]; iso <= dates.at(-1); ) {
      const [start, end] = calendarYearRange(iso, system());
      years.unshift({ start, end });
      iso = addDays(end, 1);
    }
    yearEl.replaceChildren(...years.map(({ start }) => {
      const option = document.createElement('option');
      option.value = start;
      option.textContent = yearLabel(start);
      return option;
    }));
    const numericYear = params.get('year');
    const requested = !anchor && /^\d+$/.test(numericYear ?? '')
      ? years.find((item) => calendarParts(item.start, system()).year === numericYear) : null;
    const containing = years.find(({ start, end }) => start <= (anchor || today()) && (anchor || today()) <= end);
    yearEl.value = (requested || containing || years[0]).start;
  }
  replaceDays(days);

  function weekLabel(key) {
    const date = fmt({ month: 'short', day: 'numeric' });
    return date.format(calDate(key)) + ' – ' + fmt({ month: 'short', day: 'numeric', year: 'numeric' }).format(calDate(addDays(key, 6)));
  }

  function period(iso, granularity) {
    const key = granularity === 'week' ? weekStart(iso, firstDay())
      : granularity === 'month' ? calendarMonthKey(iso, system()) : iso;
    const entry = levels[granularity].get(key);
    const count = entry?.count ?? 0;
    const label = granularity === 'week' ? weekLabel(key) : fmt(granularity === 'month'
      ? { month: 'long', year: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' }).format(calDate(iso));
    const tip = say({ day: 'tipDay', week: 'tipWeek', month: 'tipMonth' }[granularity], { label, value: countText(count) });
    return { iso, key, count, level: entry?.level ?? 0, label: granularity === 'week' ? say('weekOf', { label }) : label, tip, granularity };
  }

  function range() {
    return selection ? periodRange(selection.granularity, selection.key, system()) : null;
  }

  function select(next) {
    selection = next;
    for (const el of weeksEl.querySelectorAll('button.day')) {
      const on = Boolean(selection && selection.key === el.dataset.key);
      el.classList.toggle('is-selected', on);
      el.setAttribute('aria-pressed', String(on));
    }
    weeksEl.classList.toggle('has-selection', Boolean(selection));
    part('selection').hidden = !selection;
    if (selection) {
      const label = document.createElement('b');
      label.textContent = selection.label;
      part('selectionText').replaceChildren(label, ` · ${countText(selection.count)}`);
    }
    onSelect(range());
  }

  function showTip(x, y, text) {
    if (tooltip.textContent !== text) tooltip.textContent = text;
    const edge = tooltip.offsetWidth / 2 + 8;
    const below = y < tooltip.offsetHeight + 8;
    tooltip.style.left = Math.max(edge, Math.min(window.innerWidth - edge, x)) + 'px';
    tooltip.style.top = (below ? y + 16 : y - 8) + 'px';
    tooltip.classList.toggle('below', below);
    tooltip.classList.add('visible');
  }
  const hideTip = () => tooltip.classList.remove('visible');

  function setTabStop(cell) {
    if (!cell) return;
    if (tabStop && tabStop !== cell) tabStop.tabIndex = -1;
    tabStop = cell;
    tabStop.tabIndex = 0;
  }
  weeksEl.addEventListener('focusin', (event) => {
    if (event.target.matches('button.day')) setTabStop(event.target);
  });
  weeksEl.addEventListener('keydown', (event) => {
    if (!event.target.matches('button.day')) return;
    if (event.key === 'Escape' && selection) {
      select(null);
      event.preventDefault();
      return;
    }
    const offset = { ArrowUp: -1, ArrowDown: 1, ArrowLeft: -7, ArrowRight: 7 }[event.key];
    if (!offset && !['Home', 'End'].includes(event.key)) return;
    const cells = [...weeksEl.querySelectorAll('button.day')];
    const target = event.key === 'Home' ? cells[0] : event.key === 'End' ? cells.at(-1)
      : cells[cells.indexOf(event.target) + offset];
    event.preventDefault();
    target?.focus();
  });

  function render() {
    hideTip();
    const focusedDate = weeksEl.contains(document.activeElement) ? document.activeElement.dataset.date : null;
    const c = copy();
    part('title').textContent = titleText();
    part('hint').textContent = hintText ? hintText() : '';
    for (const key of ['clear', 'less', 'more']) part(key).textContent = c[key];
    part('calendarLabel').textContent = c.calendar;
    part('weekStartLabel').textContent = c.mondayFirst;
    part('weekStartLabel').parentElement.title = c.weekStartHelp;
    for (const el of [granularityEl, systemEl]) for (const option of el.options) option.textContent = c[option.value];
    for (const option of yearEl.options) option.textContent = yearLabel(option.value);
    granularityEl.setAttribute('aria-label', c.groupBy);
    yearEl.setAttribute('aria-label', c.year);
    part('yearPrev').title = c.prevYear;
    part('yearNext').title = c.nextYear;

    const index = years.findIndex((y) => y.start === yearEl.value);
    const { start, end } = years[index];
    const granularity = granularityEl.value;
    const offset = weekOffset(start, firstDay());
    const cells = Array(offset).fill(null);
    for (let iso = start; iso <= end; iso = addDays(iso, 1)) cells.push(iso);
    while (cells.length % 7) cells.push(null);
    const weekCount = cells.length / 7;
    weeksEl.replaceChildren();
    monthsEl.replaceChildren();
    weeksEl.setAttribute('aria-label', `${titleText()} ${yearLabel(start)}`);
    weeksEl.style.gridTemplateColumns = monthsEl.style.gridTemplateColumns = `repeat(${weekCount}, 12px)`;
    weeksEl.style.gridTemplateRows = 'repeat(7, 12px)';
    weeksEl.classList.toggle('mode-week', granularity === 'week');
    weeksEl.classList.toggle('mode-month', granularity === 'month');
    monthsEl.style.columnGap = granularity === 'month' ? '2px' : '3px';
    const labels = part('weekdayLabels');
    labels.classList.toggle('compact', granularity === 'week');
    labels.classList.toggle('compact-month', granularity === 'month');
    const weekday = fmt({ weekday: 'short' });
    labels.replaceChildren(document.createElement('span'), ...Array.from({ length: 7 }, (_, i) => {
      const label = document.createElement('span');
      // Keep the original three labeled rows, including Monday as a reference.
      const dow = (firstDay() + i) % 7;
      if ([1, 3, 5].includes(dow)) label.textContent = weekday.format(calDate(addDays('2026-11-01', dow)));
      return label;
    }));

    const dayOffset = (iso) => offset + Math.round((calDate(iso) - calDate(start)) / 86400000);
    const monthKeys = cells.map((iso) => iso && calendarMonthKey(iso, system()));
    cells.forEach((iso, i) => {
      if (!iso) {
        const blank = document.createElement('span');
        blank.className = 'day is-empty-cell';
        weeksEl.append(blank);
        return;
      }
      const p = period(iso, granularity);
      const el = document.createElement('button');
      el.type = 'button';
      el.tabIndex = -1;
      el.className = 'day';
      el.dataset.level = String(p.level);
      el.dataset.key = p.key;
      el.dataset.date = iso;
      el.setAttribute('aria-label', p.tip);
      el.addEventListener('click', () => select(selection?.key === p.key ? null : p));
      el.addEventListener('mouseenter', (e) => showTip(e.clientX, e.clientY, p.tip));
      el.addEventListener('mousemove', (e) => showTip(e.clientX, e.clientY, p.tip));
      el.addEventListener('mouseleave', hideTip);
      el.addEventListener('focus', () => {
        const r = el.getBoundingClientRect();
        showTip(r.left + r.width / 2, r.top, p.tip);
      });
      el.addEventListener('blur', hideTip);
      if (granularity === 'month') {
        const right = monthKeys[i + 7] === monthKeys[i];
        const below = i % 7 < 6 && monthKeys[i + 1] === monthKeys[i];
        const color = `var(--heat-${p.level})`;
        const shadows = [right && `2px 0 0 0 ${color}`, below && `0 2px 0 0 ${color}`,
          right && below && `2px 2px 0 0 ${color}`].filter(Boolean);
        if (shadows.length) el.style.boxShadow = shadows.join(', ');
      }
      weeksEl.append(el);
    });
    const monthFmt = fmt({ month: 'short' });
    for (let iso = start; iso <= end; ) {
      const [, last] = periodRange('month', calendarMonthKey(iso, system()), system());
      const label = document.createElement('span');
      label.style.gridColumn = `${Math.floor(dayOffset(iso) / 7) + 1} / ${Math.floor(dayOffset(last < end ? last : end) / 7) + 2}`;
      label.textContent = monthFmt.format(calDate(iso));
      monthsEl.append(label);
      iso = addDays(last, 1);
    }
    let total = 0;
    for (const [date, entry] of levels.day) if (date >= start && date <= end) total += entry.count;
    const year = system() === 'gregory' ? Number(start.slice(0, 4)) : yearLabel(start);
    part('yearStat').innerHTML = yearText(total, year, { system: system(), start, end });
    part('yearPrev').disabled = index >= years.length - 1;
    part('yearNext').disabled = index <= 0;
    const keep = selection && selection.iso >= start && selection.iso <= end ? selection.iso : null;
    const buttons = [...weeksEl.querySelectorAll('button.day')];
    const oldFocus = buttons.find((button) => button.dataset.date === focusedDate);
    setTabStop(oldFocus || buttons.find((button) => button.dataset.date === (keep || today())) || buttons[0]);
    select(keep ? period(keep, granularity) : null);
    oldFocus?.focus({ preventScroll: true });
  }

  const step = (direction) => {
    const next = years[years.findIndex((y) => y.start === yearEl.value) + direction];
    if (next) { yearEl.value = next.start; render(); }
  };
  part('yearPrev').addEventListener('click', () => step(1));
  part('yearNext').addEventListener('click', () => step(-1));
  yearEl.addEventListener('change', render);
  granularityEl.addEventListener('change', render);
  weekStartEl.addEventListener('change', () => {
    writeStored('calendar.firstDay', weekStartEl.checked ? '1' : '0');
    levels = aggregateActivity(sourceDays, firstDay(), system());
    render();
  });
  systemEl.addEventListener('change', () => {
    const shown = years.find((y) => y.start === yearEl.value);
    const anchor = selection?.iso ?? (shown.start <= today() && today() <= shown.end ? today() : addDays(shown.start, 180));
    writeStored('calendar.system', system());
    replaceDays(sourceDays, anchor);
    render();
  });
  part('clear').addEventListener('click', () => {
    select(null);
    tabStop?.focus();
  });

  return { render, range, setDays(nextDays) { replaceDays(nextDays, yearEl.value); render(); } };
}
