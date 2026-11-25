// calendar.js — a year calendar (day / week / month) shared by Repos and IA.
// It is fed a Map<'YYYY-MM-DD', number>; the page says how a number reads
// (commits, tokens). Clicking a square selects that period and calls onSelect.

const CAL_COPY = {
  es: {
    locale: 'es-ES', groupBy: 'Agrupar por', day: 'Día', week: 'Semana', month: 'Mes', year: 'Año',
    prevYear: 'Año anterior', nextYear: 'Año siguiente', less: 'Menos', more: 'Más', clear: 'Quitar',
    tipDay: '{value} el {label}', tipWeek: '{value} en la semana del {label}', tipMonth: '{value} en {label}',
    weekOf: 'Semana del {label}',
  },
  en: {
    locale: 'en-US', groupBy: 'Group by', day: 'Day', week: 'Week', month: 'Month', year: 'Year',
    prevYear: 'Previous year', nextYear: 'Next year', less: 'Less', more: 'More', clear: 'Clear',
    tipDay: '{value} on {label}', tipWeek: '{value} in the week of {label}', tipMonth: '{value} in {label}',
    weekOf: 'Week of {label}',
  },
};

/** 4 GitHub-style levels against the view's own maximum: max -> 4, zero -> 0. */
function bucketLevels(counts) {
  const max = Math.max(0, ...counts.values());
  const levels = new Map();
  for (const [key, count] of counts) {
    levels.set(key, { count, level: count > 0 && max > 0 ? Math.max(1, Math.min(4, Math.ceil((count / max) * 4))) : 0 });
  }
  return levels;
}

function addDays(iso, n) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Weeks start on Sunday and are keyed by that date, so a week across Dec/Jan stays one bucket. */
function weekStart(iso) {
  return addDays(iso, -new Date(iso + 'T00:00:00Z').getUTCDay());
}

/** Per-granularity `{ key -> { count, level } }` from a days map. */
function aggregateActivity(days) {
  const sums = { day: new Map(), week: new Map(), month: new Map() };
  for (const [date, count] of days) {
    for (const [granularity, key] of [['day', date], ['week', weekStart(date)], ['month', date.slice(0, 7)]]) {
      sums[granularity].set(key, (sums[granularity].get(key) || 0) + count);
    }
  }
  return { day: bucketLevels(sums.day), week: bucketLevels(sums.week), month: bucketLevels(sums.month) };
}

/** Inclusive `[start, end]` dates of one calendar square. */
function periodRange(granularity, key) {
  if (granularity === 'day') return [key, key];
  if (granularity === 'week') return [key, addDays(key, 6)];
  const [y, m] = key.split('-').map(Number);
  return [key + '-01', new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10)];
}

/**
 * Mount the calendar in `root` (a <details class="card cal">) and return
 * `{ render, range }`. Text callbacks run on every render, so they follow the
 * page language. `yearText` returns HTML; everything else is plain text.
 */
function createCalendar({ root, days, countText, titleText, yearText, hintText, onSelect, storageKey }) {
  const levels = aggregateActivity(days);
  const years = [...new Set([...levels.day.keys()].map((d) => d.slice(0, 4)))].sort().reverse();
  if (!years.length) years.push(String(new Date().getFullYear()));

  const part = (name) => root.querySelector('[data-cal="' + name + '"]');
  const yearEl = part('year');
  const granularityEl = part('granularity');
  const weeksEl = part('weeks');
  const monthsEl = part('months');
  let tooltip = document.getElementById('tooltip');
  if (!tooltip) {
    tooltip = document.createElement('div');
    tooltip.id = 'tooltip';
    tooltip.setAttribute('role', 'tooltip');
    document.body.appendChild(tooltip);
  }
  let selection = null;

  const copy = () => CAL_COPY[shellLang()];
  const say = (key, vars = {}) => copy()[key].replace(/\{(\w+)\}/g, (_, name) => (name in vars ? vars[name] : '{' + name + '}'));
  const escape = (value) => String(value).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
  const fmt = (options) => new Intl.DateTimeFormat(copy().locale, { timeZone: 'UTC', ...options });

  if (storageKey) {
    if (readStored(storageKey) === 'closed') root.open = false;
    root.addEventListener('toggle', () => writeStored(storageKey, root.open ? 'open' : 'closed'));
  }

  yearEl.innerHTML = years.map((y) => '<option>' + y + '</option>').join('');
  const params = new URLSearchParams(location.search);
  if (['day', 'week', 'month'].includes(params.get('granularity'))) granularityEl.value = params.get('granularity');
  yearEl.value = years.includes(params.get('year')) ? params.get('year') : years[0];

  function weekLabel(startIso) {
    const start = new Date(startIso + 'T00:00:00Z');
    const end = new Date(addDays(startIso, 6) + 'T00:00:00Z');
    return fmt({ month: 'short', day: 'numeric' }).format(start) + ' – ' + fmt({ month: 'short', day: 'numeric', year: 'numeric' }).format(end);
  }

  /** Everything one square needs in the current view: its group key, label, count, level and tooltip. */
  function period(date, granularity) {
    const iso = date.toISOString().slice(0, 10);
    if (granularity === 'week') {
      const key = weekStart(iso);
      const entry = levels.week.get(key);
      const count = entry ? entry.count : 0;
      return { key, entry, count, label: say('weekOf', { label: weekLabel(key) }), tip: say('tipWeek', { value: countText(count), label: weekLabel(key) }) };
    }
    if (granularity === 'month') {
      const key = iso.slice(0, 7);
      const entry = levels.month.get(key);
      const count = entry ? entry.count : 0;
      const label = fmt({ month: 'long', year: 'numeric' }).format(date);
      return { key, entry, count, label, tip: say('tipMonth', { value: countText(count), label }) };
    }
    const entry = levels.day.get(iso);
    const count = entry ? entry.count : 0;
    const label = fmt({ month: 'short', day: 'numeric', year: 'numeric' }).format(date);
    return { key: iso, entry, count, label, tip: say('tipDay', { value: countText(count), label }) };
  }

  /** Inclusive date bounds of the selection; null is all time. */
  function range() {
    return selection ? periodRange(selection.granularity, selection.key) : null;
  }

  function showTip(x, y, text) {
    tooltip.textContent = text;
    tooltip.style.left = x + 'px';
    tooltip.style.top = (y - 8) + 'px';
    tooltip.classList.add('visible');
  }
  const hideTip = () => tooltip.classList.remove('visible');

  function select(next) {
    selection = next;
    weeksEl.querySelectorAll('button.day').forEach((el) => {
      const on = Boolean(selection && selection.key === el.dataset.key);
      el.classList.toggle('is-selected', on);
      el.setAttribute('aria-pressed', String(on));
    });
    weeksEl.classList.toggle('has-selection', Boolean(selection));
    part('selection').hidden = !selection;
    if (selection) part('selectionText').innerHTML = '<b>' + escape(selection.label) + '</b> · ' + escape(countText(selection.count));
    onSelect(range());
  }

  function paintText() {
    const c = copy();
    part('title').textContent = titleText();
    part('hint').textContent = hintText ? hintText() : '';
    part('clear').textContent = c.clear;
    part('less').textContent = c.less;
    part('more').textContent = c.more;
    granularityEl.setAttribute('aria-label', c.groupBy);
    yearEl.setAttribute('aria-label', c.year);
    part('yearPrev').title = c.prevYear;
    part('yearNext').title = c.nextYear;
    for (const option of granularityEl.options) option.textContent = c[option.value];
  }

  function render() {
    paintText();
    const year = Number(yearEl.value);
    const granularity = granularityEl.value;
    const start = new Date(Date.UTC(year, 0, 1));
    const cells = Array(start.getUTCDay()).fill(null);
    for (let d = new Date(start); d.getUTCFullYear() === year; d.setUTCDate(d.getUTCDate() + 1)) cells.push(new Date(d));
    while (cells.length % 7) cells.push(null);
    const weekCount = cells.length / 7;

    selection = null;
    weeksEl.innerHTML = '';
    monthsEl.innerHTML = '';
    weeksEl.setAttribute('aria-label', titleText() + ' ' + year);
    weeksEl.style.gridTemplateColumns = monthsEl.style.gridTemplateColumns = 'repeat(' + weekCount + ', 12px)';
    weeksEl.style.gridTemplateRows = 'repeat(7, 12px)';
    weeksEl.classList.toggle('mode-week', granularity === 'week');
    weeksEl.classList.toggle('mode-month', granularity === 'month');
    monthsEl.style.columnGap = granularity === 'month' ? '2px' : '3px';
    const labels = part('weekdayLabels');
    labels.classList.toggle('compact', granularity === 'week');
    labels.classList.toggle('compact-month', granularity === 'month');
    const weekday = fmt({ weekday: 'short' });
    // Sunday-first rows; label Mon, Wed and Fri like GitHub does (2026-11-01 is a Sunday).
    labels.innerHTML = '<span></span>' + [0, 1, 2, 3, 4, 5, 6]
      .map((i) => '<span>' + (i % 2 ? escape(weekday.format(new Date(Date.UTC(2026, 10, 1 + i)))) : '') + '</span>').join('');

    const sameMonth = (a, b) => b && a.getUTCMonth() === b.getUTCMonth();
    cells.forEach((date, index) => {
      if (!date) {
        const empty = document.createElement('span');
        empty.className = 'day is-empty-cell';
        weeksEl.appendChild(empty);
        return;
      }
      const p = period(date, granularity);
      const level = p.entry ? p.entry.level : 0;
      const el = document.createElement('button');
      el.type = 'button';
      el.className = 'day';
      el.dataset.level = String(level);
      el.dataset.key = p.key;
      el.setAttribute('aria-label', p.tip);
      el.addEventListener('click', () => select(selection && selection.key === p.key ? null : { key: p.key, granularity, label: p.label, count: p.count }));
      el.addEventListener('mouseenter', (e) => showTip(e.clientX, e.clientY, p.tip));
      el.addEventListener('mousemove', (e) => showTip(e.clientX, e.clientY, p.tip));
      el.addEventListener('mouseleave', hideTip);
      el.addEventListener('focus', () => { const r = el.getBoundingClientRect(); showTip(r.left + r.width / 2, r.top, p.tip); });
      el.addEventListener('blur', hideTip);
      if (granularity === 'month') {
        // Fill the 2px gaps inside a month with its own colour so it reads as one block.
        const right = cells[index + 7];
        const below = index % 7 < 6 ? cells[index + 1] : null;
        const color = 'var(--heat-' + level + ')';
        const shadows = [];
        if (sameMonth(date, right)) shadows.push('2px 0 0 0 ' + color);
        if (sameMonth(date, below)) shadows.push('0 2px 0 0 ' + color);
        if (sameMonth(date, right) && sameMonth(date, below)) shadows.push('2px 2px 0 0 ' + color);
        if (shadows.length) el.style.boxShadow = shadows.join(', ');
      }
      weeksEl.appendChild(el);
    });

    const monthName = fmt({ month: 'short' });
    for (let m = 0; m < 12; m++) {
      const first = start.getUTCDay() + Math.round((Date.UTC(year, m, 1) - start) / 86400000);
      const last = start.getUTCDay() + Math.round((Date.UTC(year, m + 1, 0) - start) / 86400000);
      const label = document.createElement('span');
      label.style.gridColumn = (Math.floor(first / 7) + 1) + ' / ' + (Math.floor(last / 7) + 2);
      label.textContent = monthName.format(new Date(Date.UTC(year, m, 1)));
      monthsEl.appendChild(label);
    }

    let total = 0;
    for (const [date, entry] of levels.day) if (date.startsWith(String(year))) total += entry.count;
    part('yearStat').innerHTML = yearText(total, year);
    const index = years.indexOf(yearEl.value);
    part('yearPrev').disabled = index >= years.length - 1;
    part('yearNext').disabled = index <= 0;
    select(null);
  }

  const step = (direction) => {
    const next = years.indexOf(yearEl.value) + direction;
    if (next < 0 || next >= years.length) return;
    yearEl.value = years[next];
    render();
  };
  part('yearPrev').addEventListener('click', () => step(1));
  part('yearNext').addEventListener('click', () => step(-1));
  yearEl.addEventListener('change', render);
  granularityEl.addEventListener('change', render);
  part('clear').addEventListener('click', () => select(null));

  return { render, range };
}
