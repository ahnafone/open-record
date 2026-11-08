/** Stop caching a link this long before its own `expiresAt`. */
const EXPIRY_MARGIN_MS = 60_000;
/** Default cap on cached links; the oldest entry is evicted first when it is full. */
export const RESOLVE_CACHE_MAX_ENTRIES = 2000;

export interface CacheableStream {
  expiresAt?: string;
}

export interface ResolveCacheOptions<T extends CacheableStream> {
  /** Cache lifetime in ms (0 disables caching; in-flight de-duplication still applies). */
  ttlMs: number;
  resolve: (url: string) => Promise<T>;
  now?: () => number;
  /** Maps a URL to its cache key (default: the URL itself). See `canonicalMediaKey`. */
  key?: (url: string) => string;
  /** Hard cap on cached entries (default `RESOLVE_CACHE_MAX_ENTRIES`). */
  maxEntries?: number;
}

export interface ResolveCache<T> {
  get(url: string): Promise<T>;
  /** Number of cached entries, expired ones included until the next insert sweeps them. */
  size(): number;
}

/**
 * Canonical cache key for a media URL. YouTube watch, youtu.be, shorts, embed
 * and live links for one video all map to `youtube:<id>`, so one resolve serves
 * them all and a caller cannot grow the cache with decorated variants of the same
 * video (tracking or timestamp parameters are dropped). Any other URL is returned
 * unchanged: its query may carry an access token that changes what resolves, so
 * dropping it could hand one caller's link to someone who did not present it.
 */
export function canonicalMediaKey(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
  let id: string | null = null;
  if (host === 'youtu.be') {
    id = parsed.pathname.slice(1);
  } else if (host === 'youtube.com' || host.endsWith('.youtube.com')) {
    if (parsed.pathname === '/watch') {
      id = parsed.searchParams.get('v');
    } else {
      const m = /^\/(?:shorts|embed|live)\/([^/]+)$/.exec(parsed.pathname);
      id = m ? m[1] : null;
    }
  }
  return id && /^[\w-]{11}$/.test(id) ? `youtube:${id}` : url;
}

/**
 * Wraps a resolver with a TTL cache keyed by URL and de-duplication of
 * identical in-flight resolves. A cached entry is dropped before the link's
 * own `expiresAt` (with a safety margin), so callers never get a dead link.
 *
 * Bounded: every insert first drops expired entries, then evicts the oldest
 * entries while the cache is over `maxEntries`.
 */
export function createResolveCache<T extends CacheableStream>(options: ResolveCacheOptions<T>): ResolveCache<T> {
  const now = options.now ?? Date.now;
  const keyOf = options.key ?? ((url: string) => url);
  const maxEntries = options.maxEntries ?? RESOLVE_CACHE_MAX_ENTRIES;
  const entries = new Map<string, { value: T; until: number }>();
  const inflight = new Map<string, Promise<T>>();

  const sweepExpired = (at: number): void => {
    for (const [key, entry] of entries) {
      if (entry.until <= at) entries.delete(key);
    }
  };

  const store = (key: string, value: T): void => {
    if (options.ttlMs <= 0) return;
    const at = now();
    let until = at + options.ttlMs;
    if (value.expiresAt) {
      until = Math.min(until, Date.parse(value.expiresAt) - EXPIRY_MARGIN_MS);
    }
    if (until <= at) return;
    sweepExpired(at);
    // Re-insert so the Map's order tracks recency: the oldest key is evicted first.
    entries.delete(key);
    entries.set(key, { value, until });
    while (entries.size > maxEntries) {
      const oldest = entries.keys().next().value;
      if (oldest === undefined) break;
      entries.delete(oldest);
    }
  };

  return {
    async get(url: string): Promise<T> {
      const key = keyOf(url);
      const cached = entries.get(key);
      if (cached && cached.until > now()) return cached.value;
      entries.delete(key);

      const pending = inflight.get(key);
      if (pending) return pending;

      const promise = options
        .resolve(url)
        .then((value) => {
          store(key, value);
          return value;
        })
        .finally(() => inflight.delete(key));
      inflight.set(key, promise);
      return promise;
    },
    size: () => entries.size,
  };
}
