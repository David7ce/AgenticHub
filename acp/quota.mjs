// quota.mjs — the one definition of "this pool is out of quota".
//
// The router uses it to decide whether to fail over, and `hubctl report` uses it
// to classify a failure; two regexes drifting apart meant a failure could be
// reported as quota and not retried, or the reverse.

export const QUOTA_PATTERN =
  /\b(429|quota|rate.?limit|usage limit|session limit|hour limit|weekly limit|insufficient|exceeded|allowance|credits?|exhaust\w*)\b/i;

export function isQuotaError(text) {
  if (!text) return false;
  return QUOTA_PATTERN.test(String(text));
}
