import { normPath } from "./model.mjs";
import { parseLocalDate } from "./time.mjs";

/**
 * @typedef {Object} Filter
 * @property {string[]|null} agents   provider ids; null/empty means every agent
 * @property {string|null} project    exact project path
 * @property {string|null} before     YYYY-MM-DD, last activity before its local midnight
 * @property {boolean} includeArchived
 * @property {string} query          free text over title and path
 */

export const emptyFilter = () => ({
  agents: null,
  project: null,
  before: null,
  includeArchived: true,
  includeAutomated: true,
  query: "",
});

export function normalizeFilter(input = {}) {
  const agents = Array.isArray(input.agents) && input.agents.length
    ? [...new Set(input.agents.map(String))]
    : null;
  return {
    agents,
    project: input.project ? String(input.project) : null,
    before: input.before ? String(input.before) : null,
    includeArchived: input.includeArchived !== false,
    includeAutomated: input.includeAutomated !== false,
    query: String(input.query ?? "").trim(),
  };
}

/** Throws on a malformed date, so a typo can never widen a deletion. */
export function cutoffOf(filter) {
  return filter.before ? parseLocalDate(filter.before) : null;
}

export function matches(conv, filter) {
  if (filter.agents && !filter.agents.includes(conv.provider)) return false;
  if (!filter.includeArchived && conv.archived) return false;
  if (!filter.includeAutomated && conv.automated) return false;
  if (filter.project && normPath(conv.projectPath) !== normPath(filter.project)) return false;
  if (filter.before) {
    // Strictly before local midnight: 00:00 of that day is *not* "before" it.
    if (conv.lastActivity >= cutoffOf(filter)) return false;
  }
  if (filter.query) {
    const needle = filter.query.toLowerCase();
    const hay = `${conv.title} ${conv.projectPath}`.toLowerCase();
    if (!hay.includes(needle)) return false;
  }
  return true;
}

export function applyFilters(list, filterInput) {
  const filter = normalizeFilter(filterInput);
  return list.filter((conv) => matches(conv, filter));
}

/** Facets for the UI: every agent that appears, with counts. */
export function facets(list) {
  const byProvider = new Map();
  const byProject = new Map();
  for (const conv of list) {
    byProvider.set(conv.provider, (byProvider.get(conv.provider) ?? 0) + 1);
    const key = normPath(conv.projectPath);
    if (!byProject.has(key)) {
      byProject.set(key, { path: conv.projectPath, count: 0 });
    }
    byProject.get(key).count += 1;
  }
  return {
    agents: [...byProvider.entries()].map(([id, count]) => ({ id, count })).sort((a, b) => a.id.localeCompare(b.id)),
    projects: [...byProject.values()].sort((a, b) => a.path.localeCompare(b.path)),
  };
}
