/** Decides whether a Supabase user may use the API: `(userId) => approved?`. */
export type AccessGate = (userId: string) => Promise<boolean>;

export interface AccessGateOptions {
  /** Supabase project URL, no trailing slash. */
  supabaseUrl: string;
  /** Service-role key. Sent only to `supabaseUrl`; never to clients or logs. */
  serviceRoleKey: string;
  /** Supabase user id that is always approved. */
  adminUserId?: string | null;
  /** How long an approved or denied answer is cached. */
  ttlMs?: number;
  /** Upper bound on cached users (oldest evicted first). */
  maxEntries?: number;
  /** Per-request timeout for the PostgREST lookup. */
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

/** A failed lookup is cached this long at most, so an outage is not hammered. */
const ERROR_TTL_MS = 3_000;
const DEFAULT_TTL_MS = 60_000;
const DEFAULT_MAX_ENTRIES = 5_000;
const DEFAULT_TIMEOUT_MS = 3_000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface CacheEntry {
  approved: boolean;
  expiresAt: number;
}

/**
 * Builds the approval gate. A user is approved when their `admin` id matches or
 * `public.access_requests` holds a row for them with `status = 'approved'`.
 *
 * Fails closed: any network, HTTP, timeout or parse error denies the request.
 * Answers are cached per user for `ttlMs` (denials too); failures for at most
 * `ERROR_TTL_MS`. Concurrent checks for one user share a single lookup.
 */
export function createAccessGate(options: AccessGateOptions): AccessGate {
  const {
    supabaseUrl,
    serviceRoleKey,
    adminUserId = null,
    ttlMs = DEFAULT_TTL_MS,
    maxEntries = DEFAULT_MAX_ENTRIES,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    fetchImpl = fetch,
    now = Date.now,
  } = options;
  const admin = adminUserId?.toLowerCase() ?? null;
  const base = supabaseUrl.replace(/\/+$/, '');
  const cache = new Map<string, CacheEntry>();
  const inFlight = new Map<string, Promise<boolean>>();

  const remember = (userId: string, approved: boolean, lifetimeMs: number): void => {
    cache.delete(userId);
    cache.set(userId, { approved, expiresAt: now() + lifetimeMs });
    if (cache.size > maxEntries) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
  };

  /** One PostgREST lookup. Resolves to `null` when the answer is unknown (error). */
  const lookup = async (userId: string): Promise<boolean | null> => {
    try {
      const url = `${base}/rest/v1/access_requests?select=status&user_id=eq.${userId}&limit=1`;
      const res = await fetchImpl(url, {
        method: 'GET',
        headers: {
          apikey: serviceRoleKey,
          Authorization: `Bearer ${serviceRoleKey}`,
          Accept: 'application/json',
        },
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) return null;
      const rows: unknown = await res.json();
      if (!Array.isArray(rows)) return null;
      return rows.some(
        (row) =>
          typeof row === 'object' &&
          row !== null &&
          (row as Record<string, unknown>)['status'] === 'approved',
      );
    } catch {
      // The error is deliberately dropped: it may echo request details.
      return null;
    }
  };

  return async (rawUserId) => {
    const userId = rawUserId.toLowerCase();
    if (admin && userId === admin) return true;
    // Checked before any network call, so the id cannot inject into the URL.
    if (!UUID.test(userId)) return false;

    const hit = cache.get(userId);
    if (hit && hit.expiresAt > now()) return hit.approved;

    const pending = inFlight.get(userId);
    if (pending) return pending;

    const check = (async (): Promise<boolean> => {
      try {
        const result = await lookup(userId);
        if (result === null) {
          remember(userId, false, Math.min(ttlMs, ERROR_TTL_MS));
          return false;
        }
        remember(userId, result, ttlMs);
        return result;
      } finally {
        inFlight.delete(userId);
      }
    })();
    inFlight.set(userId, check);
    return check;
  };
}
