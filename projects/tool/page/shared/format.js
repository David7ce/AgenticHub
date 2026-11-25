// format.js — numbers as every Workspaces page shows them.
//
// The Repos page's AI card and the IA page print the same figures, so the two
// hundred lines apart rule (short scale, exact value in the title) lives once.

/** 13.6M, 985k, 950 — the exact figure goes in a title attribute. */
function shortTokens(n) {
  const value = Number(n) || 0;
  const abs = Math.abs(value);
  const fixed = (x) => (x >= 100 ? Math.round(x).toString() : x.toFixed(1).replace(/\.0$/, ''));
  if (abs >= 1e9) return fixed(value / 1e9) + 'G';
  if (abs >= 1e6) return fixed(value / 1e6) + 'M';
  if (abs >= 1e3) return fixed(value / 1e3) + 'k';
  return String(Math.round(value));
}

/** Grouped digits in the page's language ('es' | 'en'). */
function formatNumber(value, lang) {
  return new Intl.NumberFormat(lang === 'en' ? 'en-US' : 'es-ES').format(Number(value) || 0);
}
