// common.js — helpers both tabs use. Pure functions first (tested in Node),
// then the page chrome: language, theme, tabs, sortable headers.

let lang = shellLang();

function t(key, vars) {
  let out = (I18N[lang] && I18N[lang][key]) ?? I18N.en[key] ?? key;
  if (vars) out = out.replace(/\{(\w+)\}/g, (match, name) => (vars[name] ?? match));
  return out;
}
function plural(n, one, many) { return t(n === 1 ? one : many, { n }); }

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

/** 22761 -> "22.8k"; the exact count goes in the tooltip. */
function formatStars(n) {
  if (n == null) return null;
  if (n < 1000) return String(n);
  const k = n / 1000;
  return (k >= 100 ? String(Math.round(k)) : k.toFixed(1).replace(/\.0$/, '')) + 'k';
}

function normalizeName(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function githubAccount(url) {
  if (!url) return null;
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    if (host !== 'github.com' && !host.endsWith('.github.com')) return null;
    return u.pathname.split('/').filter(Boolean)[0] || null;
  } catch { return null; }
}

/** vscode:// link that asks for a new window; each segment encoded so spaces, # and ? stay in the path. */
function vscodeUrl(path) {
  const parts = String(path ?? '').replace(/\\/g, '/').split('/');
  const encoded = parts.map((part, i) => (i === 0 && /^[A-Za-z]:$/.test(part) ? part : encodeURIComponent(part))).join('/');
  return 'vscode://file/' + (encoded.endsWith('/') ? encoded : encoded + '/') + '?windowId=_blank';
}

/** The route that works whatever the URI handler does. */
function codeNewWindowCommand(path) {
  return 'code -n "' + String(path ?? '').replace(/"/g, '') + '"';
}

/**
 * The calendar's year line: "2861 commits by Owner (1761 by Claude),
 * 213 commits by Second-Account (12 by Claude) in 2026". Each account carries its
 * own AI breakdown, so the numbers are not silently attributed to the last
 * account on the line. An account with no commits that year is left out, and so
 * is an empty provider list; `fallback` keeps a page without activity data
 * readable. Older activity data without per-account `ai` still shows the global
 * provider list after the accounts. Returns HTML.
 */
function formatYearActivity(activity, year, fallback = { total: 0, author: '' }) {
  const inYear = (days) => Object.entries(days || {})
    .reduce((sum, [date, count]) => (date.startsWith(year + '-') ? sum + (Number(count) || 0) : sum), 0);
  const accounts = (activity?.accounts ?? [])
    .map((a) => ({
      name: a.name,
      n: inYear(a.days),
      ai: a.ai
        ? a.ai
          .map((p) => ({ name: p.provider, n: inYear(p.days) }))
          .filter((p) => p.n > 0)
          .sort((x, y) => y.n - x.n || x.name.localeCompare(y.name))
        : null,
    }))
    .filter((a) => a.n > 0);
  const globalAi = (activity?.ai ?? [])
    .map((p) => ({ name: p.provider, n: inYear(p.days) }))
    .filter((p) => p.n > 0)
    .sort((a, b) => b.n - a.n || a.name.localeCompare(b.name));
  const hasAccountAi = accounts.some((a) => a.ai?.length);
  const providersHtml = (list) => list
    .map((p) => t('aiBy', { n: p.n, name: esc(p.name) }))
    .join(t('listJoin'));
  const byAuthor = accounts.length
    ? accounts.map((a) => {
      let line = plural(a.n, 'commitOne', 'commitMany') + ' ' + t('byName', { name: esc(a.name) });
      if (a.ai?.length) line += ' (' + providersHtml(a.ai) + ')';
      return line;
    })
    : (fallback.author
      ? [plural(fallback.total, 'commitOne', 'commitMany') + ' ' + t('byName', { name: esc(fallback.author) })]
      : []);
  let text = byAuthor.join(t('listJoin'));
  if (!hasAccountAi && globalAi.length) {
    const listed = providersHtml(globalAi);
    text = text ? text + ' (' + listed + ')' : listed;
  }
  if (!text) text = t(fallback.total === 1 ? 'commitOne' : 'commitMany', { n: fallback.total });
  return t('yearTotal', { accounts: text, year });
}

/** Sort value: arrays by length, missing values below every real one. */
function sortValue(raw) {
  if (Array.isArray(raw)) return raw.length;
  if (typeof raw === 'boolean') return raw ? 1 : 0;
  if (raw == null) return -1;
  return raw;
}
function compareBy(key, dir) {
  return (a, b) => {
    const av = sortValue(a[key]);
    const bv = sortValue(b[key]);
    const cmp = typeof av === 'number' && typeof bv === 'number'
      ? av - bv
      : String(av).localeCompare(String(bv));
    return cmp * dir;
  };
}

// --- Icons ---------------------------------------------------------------
// Avatars need network; onerror swaps in an inline mark so the page stays
// complete offline. A folder only gets a GitHub avatar when some repo inside it
// is owned by an account of that name, so it never borrows a stranger's face.

const GENERIC_ICON = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">'
  + '<circle cx="4" cy="3" r="1.7" fill="#9ca3af"/><circle cx="4" cy="13" r="1.7" fill="#9ca3af"/>'
  + '<circle cx="12" cy="6" r="1.7" fill="#9ca3af"/>'
  + '<path d="M4 4.7v6.6M4 8h2.2A3.8 3.8 0 0 0 10 4.2V6" fill="none" stroke="#9ca3af" stroke-width="1.4"/></svg>',
);
function accountFallback(img) { img.onerror = null; img.src = GENERIC_ICON; img.classList.add('generic'); }

function makeIcons(rows, ownerIcons, projectIcons) {
  const ownerAccounts = new Map();
  const projectAccounts = new Map();
  for (const r of rows) {
    const account = githubAccount(r.webUrl);
    if (!account) continue;
    const ownerKey = normalizeName(r.owner);
    if (normalizeName(account) === ownerKey && !ownerAccounts.has(ownerKey)) ownerAccounts.set(ownerKey, account);
    const projectKey = ownerKey + '|' + normalizeName(r.project);
    if (normalizeName(account) === normalizeName(r.project) && !projectAccounts.has(projectKey)) {
      projectAccounts.set(projectKey, account);
    }
  }
  const img = (src, extra) => '<img class="acct' + (extra || '') + '" src="' + esc(src) + '" alt="" loading="lazy" onerror="accountFallback(this)">';
  const avatar = (account) => {
    if (!account) return '<span title="' + esc(t('notGithub')) + '">' + img(GENERIC_ICON, ' generic') + '</span>';
    const profile = 'https://github.com/' + encodeURIComponent(account);
    return '<a href="' + esc(profile) + '" target="_blank" rel="noopener" title="' + esc(account) + '">' + img(profile + '.png?size=48') + '</a>';
  };
  const fromSpec = (spec) => (spec.href
    ? '<a href="' + esc(spec.href) + '" target="_blank" rel="noopener" title="' + esc(spec.label) + '">' + img(spec.src) + '</a>'
    : '<span title="' + esc(spec.label) + '">' + img(spec.src) + '</span>');
  return {
    owner(owner) {
      const spec = ownerIcons[normalizeName(owner)];
      return spec ? fromSpec(spec) : avatar(ownerAccounts.get(normalizeName(owner)));
    },
    project(owner, project) {
      if (!project) return '';
      const spec = projectIcons[normalizeName(project)];
      return spec ? fromSpec(spec) : avatar(projectAccounts.get(normalizeName(owner) + '|' + normalizeName(project)));
    },
  };
}

// --- Page chrome ---------------------------------------------------------

// Opened from disk: a private window may throw on every storage access.
function stored(key) { try { return localStorage.getItem(key); } catch { return null; } }
function store(key, value) { try { localStorage.setItem(key, value); } catch { /* ignore */ } }

const $ = (id) => document.getElementById(id);

async function copyText(button, text, ok, fail) {
  const original = button.textContent;
  try {
    await navigator.clipboard.writeText(text);
    button.textContent = ok;
  } catch {
    button.textContent = fail;
  }
  setTimeout(() => { button.textContent = original; }, 1300);
}

/** Header clicks sort by `data-sort`; the arrow lives in its own span, so translating never erases it. */
function wireSort(table, state, render) {
  const paint = () => table.querySelectorAll('th[data-sort]').forEach((th) => {
    const on = th.dataset.sort === state.key;
    th.querySelector('.arrow').textContent = on ? (state.dir === 1 ? '▲' : '▼') : '';
    if (on) th.setAttribute('aria-sort', state.dir === 1 ? 'ascending' : 'descending');
    else th.removeAttribute('aria-sort');
  });
  table.querySelectorAll('th[data-sort]').forEach((th) => th.addEventListener('click', () => {
    const key = th.dataset.sort;
    state.dir = state.key === key ? -state.dir : (state.defaultDir?.[key] ?? 1);
    state.key = key;
    paint();
    render();
  }));
  paint();
}

function fillSelect(select, allLabel, values, current, label = (v) => v) {
  select.innerHTML = '<option value="">' + esc(allLabel) + '</option>'
    + values.map((v) => '<option value="' + esc(v) + '">' + esc(label(v)) + '</option>').join('');
  select.value = values.includes(current) ? current : '';
  return select.value;
}

function applyStaticText() {
  document.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n); });
  document.querySelectorAll('[data-i18n-title]').forEach((el) => { el.title = t(el.dataset.i18nTitle); });
  document.querySelectorAll('[data-i18n-placeholder]').forEach((el) => { el.placeholder = t(el.dataset.i18nPlaceholder); });
  document.querySelectorAll('[data-i18n-aria]').forEach((el) => { el.setAttribute('aria-label', t(el.dataset.i18nAria)); });
}

function startApp(views) {
  const renderAll = () => {
    applyStaticText();
    views.forEach((view) => view.render());
  };
  initShell({
    tab: 'repos',
    stamp: () => t('generated', { root: DATA.root, date: DATA.generatedAt }),
    onLang: (next) => { lang = next; renderAll(); },
  });
  renderAll();
}
