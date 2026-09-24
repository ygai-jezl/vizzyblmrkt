/**
 * A small per-instance memo for Insights' BigQuery results (nav v2 phase 4):
 * the same slice is reused for five minutes per tenant instead of re-scanning on
 * every page view. Like countReview's cache, it's per server instance — a cold
 * instance just queries again. Failures (null) aren't cached.
 */
const TTL_MS = 5 * 60_000;
const store = new Map<string, { at: number; value: unknown }>();

export async function memo<T>(key: string, fn: () => Promise<T | null>, now = Date.now()): Promise<T | null> {
  const hit = store.get(key);
  if (hit && now - hit.at < TTL_MS) return hit.value as T;
  const value = await fn();
  if (value !== null) store.set(key, { at: now, value });
  return value;
}

/** Tests only. */
export function resetInsightsCache(): void {
  store.clear();
}
