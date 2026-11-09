/**
 * "Last activity before date X" means strictly before local midnight at the
 * start of X. Comparing against a UTC midnight would delete or keep a whole
 * extra day either side of the timezone, so the cutoff is built from local
 * calendar parts.
 */
export function parseLocalDate(text) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(text ?? "").trim());
  if (!match) throw new Error(`date must be YYYY-MM-DD, got "${text}"`);
  const [, y, m, d] = match.map(Number);
  const date = new Date(y, m - 1, d, 0, 0, 0, 0);
  if (
    date.getFullYear() !== y ||
    date.getMonth() !== m - 1 ||
    date.getDate() !== d
  ) {
    throw new Error(`not a real date: ${text}`);
  }
  return date.getTime();
}

export function formatLocalDate(epochMs) {
  const date = new Date(epochMs);
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function formatLocalDateTime(epochMs) {
  const date = new Date(epochMs);
  const pad = (n) => String(n).padStart(2, "0");
  return `${formatLocalDate(epochMs)} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Accepts epoch seconds or milliseconds and always returns milliseconds. */
export function toMs(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n < 1e12 ? Math.round(n * 1000) : Math.round(n);
}
