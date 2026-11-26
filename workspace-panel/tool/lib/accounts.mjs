// accounts.mjs — who a commit belongs to, and whether an AI wrote or helped write it.
//
// Everything here comes from the commit itself: the author identity, or a
// Co-authored-by trailer. Nothing is guessed from a repo's owner or a folder
// name, and no address is ever displayed: the page names accounts, not emails.
//
// The owner account is the one configured for this machine (`authorName` /
// `githubUser` and `author` in local/config.json) plus the GitHub noreply
// alias of that user, so the summary and the calendar count the same commits.
// Any other account (a second GitHub identity, a work account) is listed in
// local/accounts.json — never in the code, because addresses are personal.

import { AUTHOR, AUTHORS, GITHUB_USER, readLocalJson } from './local.mjs';

/** One `{ name, emails }` entry, checked so a typo fails loudly instead of miscounting. */
function account(entry, source) {
  const ok = entry && typeof entry.name === 'string' && Array.isArray(entry.emails)
    && entry.emails.every((e) => typeof e === 'string');
  if (!ok) throw new Error(`${source}: each account needs a "name" and an "emails" array`);
  return { name: entry.name, emails: [...new Set(entry.emails)] };
}

/**
 * Builds the account list: the owner first, then the extra accounts. Exported
 * so tests can pass fixtures instead of depending on this machine's config.
 */
export function buildAccounts({ name, emails, githubUser } = {}, extra = []) {
  const aliases = githubUser ? [`${githubUser}@users.noreply.github.com`] : [];
  const owner = account({ name, emails: [...emails, ...aliases] }, 'owner');
  return [owner, ...extra.map((e) => account(e, 'workspace-panel/local/accounts.json'))];
}

/** Accounts as the page names them, with every address that signs them. */
export const ACCOUNTS = buildAccounts(
  { name: AUTHOR, emails: AUTHORS, githubUser: GITHUB_USER },
  readLocalJson('accounts.json', []),
);

/**
 * AI providers, grouped by provider (not by model): a commit by any Claude
 * model counts once as `Claude`. Automation that is not AI (dependabot, a CI
 * bot) is left out on purpose.
 */
export const AI_PROVIDERS = [
  { name: 'Claude', emails: ['noreply@anthropic.com'], names: /^claude\b/i, trailers: /claude/i },
  { name: 'Copilot', emails: ['198982749+copilot@users.noreply.github.com'], names: /copilot/i, trailers: /copilot/i },
  { name: 'Codex', emails: ['codex@local'], names: /^codex\b/i, trailers: /codex/i },
  { name: 'OpenCode', emails: ['opencode@local'], names: /^opencode\b/i, trailers: /opencode/i },
  { name: 'Arena', emails: ['agent@arena.ai', 'arena@example.com'], names: /^arena\b/i, trailers: /arena/i },
];

const lower = (value) => String(value ?? '').toLowerCase();

/**
 * One commit -> `{ owner, account, ai }`:
 *   owner   the author address is one this machine counts as its own;
 *   account the account that signed it, if it is a known one;
 *   ai      providers that authored it or appear as co-authors.
 */
export function classifyCommit({ name = '', email = '', trailers = '' } = {}, accounts = ACCOUNTS) {
  const address = lower(email);
  const author = String(name ?? '');
  const owner = accounts[0].emails.some((a) => lower(a) === address);
  const account = (accounts.find((a) => a.emails.some((e) => lower(e) === address)) ?? null)?.name ?? null;
  const coAuthors = String(trailers ?? '').split('\u001f').filter(Boolean);
  const ai = AI_PROVIDERS
    .filter((p) => p.emails.some((e) => lower(e) === address)
      || p.names.test(author)
      || coAuthors.some((t) => p.trailers.test(t)))
    .map((p) => p.name);
  return { owner, account, ai };
}
