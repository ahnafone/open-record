import { AbortedError } from './errors';

/** A link is dropped this long before its own `expiresAt`, so callers never get a dead link. */
export const LINK_EXPIRY_MARGIN_MS = 60_000;

export interface ExpiringLink {
  /** Epoch milliseconds after which the link stops working. Absent: not cached. */
  expiresAt?: number;
}

export interface LinkCacheOptions {
  now?: () => number;
  marginMs?: number;
}

/** Waits for `pending`, but gives up (only for this caller) when `signal` aborts. */
function withSignal<T>(pending: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return pending;
  if (signal.aborted) return Promise.reject(new AbortedError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new AbortedError());
    signal.addEventListener('abort', onAbort, { once: true });
    pending.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (err: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(err);
      },
    );
  });
}

/**
 * In-memory cache of resolved links keyed by track id. Entries are reused until
 * `expiresAt - margin`; concurrent calls for the same key share one load.
 * A failed load is not cached.
 */
export function createLinkCache<T extends ExpiringLink>(
  load: (key: string) => Promise<T>,
  options: LinkCacheOptions = {},
): (key: string, signal?: AbortSignal) => Promise<T> {
  const now = options.now ?? (() => Date.now());
  const margin = options.marginMs ?? LINK_EXPIRY_MARGIN_MS;
  const cached = new Map<string, { value: T; until: number }>();
  const inflight = new Map<string, Promise<T>>();

  return (key, signal) => {
    const hit = cached.get(key);
    if (hit && hit.until > now()) return withSignal(Promise.resolve(hit.value), signal);
    cached.delete(key);

    let pending = inflight.get(key);
    if (!pending) {
      pending = load(key)
        .then((value) => {
          if (value.expiresAt !== undefined && value.expiresAt - margin > now()) {
            cached.set(key, { value, until: value.expiresAt - margin });
          }
          return value;
        })
        .finally(() => inflight.delete(key));
      inflight.set(key, pending);
    }
    return withSignal(pending, signal);
  };
}
