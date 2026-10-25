import { createHash } from 'node:crypto';

/** Stop caching a link this long before its own `expiresAt`. */
const EXPIRY_MARGIN_MS = 60_000;

export interface CacheableStream {
  expiresAt?: string;
}

export interface ResolveCacheOptions<T extends CacheableStream> {
  /** Cache lifetime in ms (0 disables caching; in-flight de-duplication still applies). */
  ttlMs: number;
  resolve: (url: string) => Promise<T>;
  now?: () => number;
}

export interface ResolveCache<T> {
  get(url: string): Promise<T>;
}

/**
 * Wraps a resolver with a TTL cache keyed by URL and de-duplication of
 * identical in-flight resolves. A cached entry is dropped before the link's
 * own `expiresAt` (with a safety margin), so callers never get a dead link.
 */
export function createResolveCache<T extends CacheableStream>(options: ResolveCacheOptions<T>): ResolveCache<T> {
  const now = options.now ?? Date.now;
  const entries = new Map<string, { value: T; until: number }>();
  const inflight = new Map<string, Promise<T>>();

  const store = (url: string, value: T): void => {
    if (options.ttlMs <= 0) return;
    let until = now() + options.ttlMs;
    if (value.expiresAt) {
      until = Math.min(until, Date.parse(value.expiresAt) - EXPIRY_MARGIN_MS);
    }
    if (until > now()) entries.set(url, { value, until });
  };

  return {
    async get(url: string): Promise<T> {
      const cached = entries.get(url);
      if (cached && cached.until > now()) return cached.value;
      entries.delete(url);

      const pending = inflight.get(url);
      if (pending) return pending;

      const promise = options
        .resolve(url)
        .then((value) => {
          store(url, value);
          return value;
        })
        .finally(() => inflight.delete(url));
      inflight.set(url, promise);
      return promise;
    },
  };
}

/** Rate-limit key: a hash of the presented Authorization header (never the raw token). */
export function tokenKey(authorization: string | undefined): string {
  return createHash('sha256')
    .update(authorization ?? '', 'utf8')
    .digest('base64url');
}
