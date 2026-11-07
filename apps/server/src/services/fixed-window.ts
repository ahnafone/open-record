export interface FixedWindowOptions {
  /** Hits allowed per key in one window. */
  max: number;
  windowMs: number;
  /** Hard cap on tracked keys, so a spray of distinct keys cannot grow memory. */
  maxKeys: number;
  now?: () => number;
}

/**
 * Counts one hit for `key`. Returns 0 when the hit is allowed, or the whole
 * seconds (at least 1) until the key's window resets when it is over budget.
 * An over-budget hit is not counted.
 */
export type FixedWindowHit = (key: string) => number;

/**
 * Fixed-window counter keyed by string (e.g. client IP). When a new key arrives
 * at `maxKeys`, expired windows are swept, but at most once per window, so a
 * full map of live windows costs O(1) per insert: the oldest key is dropped.
 */
export function createFixedWindow({
  max,
  windowMs,
  maxKeys,
  now = Date.now,
}: FixedWindowOptions): FixedWindowHit {
  const buckets = new Map<string, { count: number; resetAt: number }>();
  let lastSweepAt = Number.NEGATIVE_INFINITY;

  const sweep = (at: number): void => {
    lastSweepAt = at;
    for (const [key, bucket] of buckets) {
      if (bucket.resetAt <= at) buckets.delete(key);
    }
  };

  return (key) => {
    const at = now();
    const bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= at) {
      if (!bucket && buckets.size >= maxKeys) {
        if (at - lastSweepAt >= windowMs) sweep(at);
        if (buckets.size >= maxKeys) {
          const oldest = buckets.keys().next().value;
          if (oldest !== undefined) buckets.delete(oldest);
        }
      }
      // Re-insert so the Map's order tracks recency: the oldest key is evicted first.
      buckets.delete(key);
      buckets.set(key, { count: 1, resetAt: at + windowMs });
      return 0;
    }
    if (bucket.count >= max) {
      return Math.max(1, Math.ceil((bucket.resetAt - at) / 1000));
    }
    bucket.count += 1;
    return 0;
  };
}
