// shell.js — the Workspaces header shared by Repos, IA and Notas: tabs, language, theme.
// Every page keeps language and theme under the same storage keys, so the choice
// carries across tabs. Storage may be unavailable on file:// — never fatal.

const SHELL_COPY = {
  es: {
    title: 'Workspaces Panel', homeLabel: 'Workspaces Panel, inicio', tabRepos: 'Repositorios', tabIa: 'Uso de IA', tabNotes: 'Roadmap', skip: 'Saltar al contenido',
    toLight: 'Cambiar a tema claro', toDark: 'Cambiar a tema oscuro', iconLight: '☀', iconDark: '☽',
    pageHome: 'Workspaces Panel · Inicio', pageRepos: 'Workspaces Panel · Repositorios', pageIa: 'Workspaces Panel · Uso de IA', pageNotes: 'Workspaces Panel · Roadmap',
  },
  en: {
    title: 'Workspaces Panel', homeLabel: 'Workspaces Panel, home', tabRepos: 'Repositories', tabIa: 'AI Usage', tabNotes: 'Roadmap', skip: 'Skip to content',
    toLight: 'Switch to light theme', toDark: 'Switch to dark theme', iconLight: '☀', iconDark: '☽',
    pageHome: 'Workspaces Panel · Home', pageRepos: 'Workspaces Panel · Repositories', pageIa: 'Workspaces Panel · AI Usage', pageNotes: 'Workspaces Panel · Roadmap',
  },
};

function readStored(key) { try { return localStorage.getItem(key); } catch { return null; } }
function writeStored(key, value) { try { localStorage.setItem(key, value); } catch { /* storage blocked */ } }

// The language chosen on this page load; storage alone is not enough because it
// can be blocked, and every part of the page (calendar included) asks shellLang().
let chosenLang = null;

/** The current language: this page's choice, else the stored one, else Spanish. */
function shellLang() {
  if (chosenLang) return chosenLang;
  const saved = readStored('lang');
  return saved === 'en' || saved === 'es' ? saved : 'es';
}

function rememberLang(lang) {
  chosenLang = lang;
  writeStored('lang', lang);
}

/** A fragment carries focus between offline pages without relying on cross-file storage. */
function initTabFocus(links, location = globalThis.location, history = globalThis.history) {
  if (!location) return;
  const marker = '#ws-tab-focus';
  const current = links.find((link) => link.getAttribute('aria-current') === 'page');
  for (const link of links) {
    link.addEventListener('click', (event) => {
      if (link === current || event.defaultPrevented || event.button !== 0
          || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      const target = new URL(link.href, location.href);
      target.hash = marker;
      event.preventDefault();
      location.assign(target.href);
    });
  }
  if (current && location.hash === marker) {
    current.focus({ preventScroll: true });
    try {
      const clean = new URL(location.href);
      clean.hash = '';
      history.replaceState(history.state, '', clean.href);
    } catch { /* navigation focus still works if history is restricted */ }
  }
}

/**
 * Wire the header. `stamp()` returns the line under the title and is optional
 * (the notes page ships it already rendered); `onLang(lang)` re-renders the page
 * after a language change. A page generated in one language omits the selector.
 */
function initShell({ tab, stamp, onLang }) {
  const root = document.documentElement;
  const byId = (id) => document.getElementById(id);
  const themeBtn = byId('themeBtn');
  const langEl = byId('lang');
  let lang = shellLang();

  const savedTheme = readStored('theme');
  if (savedTheme === 'light' || savedTheme === 'dark') root.setAttribute('data-theme', savedTheme);
  const effectiveTheme = () => root.getAttribute('data-theme')
    || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');

  function paint() {
    const copy = SHELL_COPY[lang];
    // A page without the selector has Spanish content (Roadmap): its chrome follows the
    // chosen language, the document stays Spanish.
    root.lang = langEl ? lang : 'es';
    document.title = tab === 'ia' ? copy.pageIa : tab === 'notes' ? copy.pageNotes : tab === 'home' ? copy.pageHome : copy.pageRepos;
    byId('brandText').textContent = copy.title;
    byId('brandHome').setAttribute('aria-label', copy.homeLabel);
    byId('skipLink').textContent = copy.skip;
    byId('tabRepos').textContent = copy.tabRepos;
    byId('tabIa').textContent = copy.tabIa;
    byId('tabNotes').textContent = copy.tabNotes;
    // Icon only: the action is in the tooltip and the accessible name.
    const dark = effectiveTheme() === 'dark';
    themeBtn.textContent = dark ? copy.iconLight : copy.iconDark;
    themeBtn.title = dark ? copy.toLight : copy.toDark;
    themeBtn.setAttribute('aria-label', themeBtn.title);
    if (langEl) langEl.value = lang;
    if (stamp) byId('shellStamp').textContent = stamp();
  }

  themeBtn.addEventListener('click', () => {
    const next = effectiveTheme() === 'dark' ? 'light' : 'dark';
    root.setAttribute('data-theme', next);
    writeStored('theme', next);
    paint();
  });
  if (langEl) {
    langEl.addEventListener('change', () => {
      lang = langEl.value === 'en' ? 'en' : 'es';
      rememberLang(lang);
      if (onLang) onLang(lang);
      paint();
    });
  }
  paint();
  initTabFocus(['tabRepos', 'tabIa', 'tabNotes'].map(byId));
  return { paint };
}
