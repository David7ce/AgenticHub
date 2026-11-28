// stars.mjs — GitHub star counts, cached in local/stars.json.
//
// Only the `stars` command talks to the network; `build` reads the cache. The
// unauthenticated API allows 60 requests an hour, so a rate limit keeps what
// was fetched and stops instead of failing.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { LOCAL_DIR } from './paths.mjs';
import { mapPool } from './pool.mjs';

export const STARS_PATH = join(LOCAL_DIR, 'stars.json');
const API = 'https://api.github.com/repos';
const DAY_MS = 24 * 60 * 60 * 1000;
const VERSION = 2;

/** `https://github.com/Owner/Repo` -> `Owner/Repo`; null when not on GitHub. */
export function repoKeyFromWebUrl(webUrl) {
  if (!webUrl) return null;
  try {
    const url = new URL(webUrl);
    if (url.hostname.toLowerCase() !== 'github.com') return null;
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts.length < 2) return null;
    return `${parts[0]}/${parts[1]}`.replace(/\.git$/, '');
  } catch {
    return null;
  }
}

/** `{ "owner/repo": { stars, at } }`, empty when the cache is missing or unreadable. */
export function readStarsCache(path = STARS_PATH) {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    return raw?.version === VERSION && raw.entries && typeof raw.entries === 'object' ? raw.entries : {};
  } catch {
    return {};
  }
}

export function writeStarsCache(entries, path = STARS_PATH) {
  mkdirSync(dirname(path), { recursive: true });
  const body = { version: VERSION, updatedAt: new Date().toISOString(), entries };
  writeFileSync(path, `${JSON.stringify(body, null, 2)}\n`, 'utf8');
}

/** Set `row.stars` (number or null) from the cache. */
export function applyStars(rows, entries) {
  for (const row of rows) {
    const key = repoKeyFromWebUrl(row.webUrl);
    row.stars = key && entries[key] ? entries[key].stars ?? null : null;
  }
  return rows;
}

const isFresh = (entry, ttlDays) => Boolean(entry?.at) && Date.now() - Date.parse(entry.at) < ttlDays * DAY_MS;

/** Fetch missing or stale counts. A 404 is cached as null so it is not retried every run. */
export async function fetchStars({ rows, entries: cached, token = null, refresh = false, ttlDays = 7, jobs = 4, log = () => {} }) {
  const entries = { ...cached };
  const keys = [...new Set(rows.map((row) => repoKeyFromWebUrl(row.webUrl)).filter(Boolean))];
  const pending = keys.filter((key) => refresh || !isFresh(entries[key], ttlDays));
  const headers = {
    'user-agent': 'agenthub-projects',
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };

  let fetched = 0;
  let failed = 0;
  let rateLimited = false;
  await mapPool(pending, jobs, async (key) => {
    try {
      const response = await fetch(`${API}/${key}`, { headers });
      if (response.status === 404) {
        entries[key] = { stars: null, at: new Date().toISOString() };
        failed += 1;
        return;
      }
      if (response.status === 403 || response.status === 429) {
        rateLimited = true;
        return;
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      entries[key] = { stars: Number(data.stargazers_count) || 0, at: new Date().toISOString() };
      fetched += 1;
    } catch (error) {
      failed += 1;
      log(`  ${key}: ${error.message}`);
    }
  }, { stop: () => rateLimited });

  if (rateLimited) {
    log('GitHub rate limit reached; what was fetched is cached. Set GITHUB_TOKEN for 5,000 requests/hour.');
  }
  return { entries, fetched, failed, rateLimited, total: keys.length };
}
