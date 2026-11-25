// pool.mjs — bounded concurrency for per-repo work.

/**
 * Run `fn` over `items` with at most `jobs` in flight; results keep input order.
 * `stop()` is checked before each item, so a rate limit can end the run early
 * (skipped items stay `undefined`).
 */
export async function mapPool(items, jobs, fn, { stop = () => false } = {}) {
  const results = new Array(items.length);
  let next = 0;
  const width = Math.max(1, Math.min(jobs, items.length));
  await Promise.all(Array.from({ length: width }, async () => {
    while (next < items.length && !stop()) {
      const index = next++;
      results[index] = await fn(items[index], index);
    }
  }));
  return results;
}
