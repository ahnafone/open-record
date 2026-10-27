/**
 * Alternative titles and artist names for a song from MusicBrainz, so the app
 * can match the same track across languages and scripts (e.g. 米津玄師 vs
 * Kenshi Yonezu). Everything fails soft: any error yields empty lists.
 */

/** Same convention as `@open-record/metadata-lookup` (MusicBrainz requires a descriptive User-Agent). */
export const USER_AGENT = 'OpenRecordServer/1.0 (self-hosted personal music library tagger)';

const ENDPOINT = 'https://musicbrainz.org/ws/2/recording';
const TIMEOUT_MS = 6000;
const MAX_JSON_BYTES = 1024 * 1024;
const MIN_INTERVAL_MS = 1000;
const MAX_QUEUE = 30;
const HIT_TTL_MS = 24 * 60 * 60 * 1000;
const MISS_TTL_MS = 60 * 60 * 1000;
const MAX_CACHE = 1000;
const MAX_RESULTS = 3;
const MIN_SCORE = 80;
const STRONG_SCORE = 95;
export const MAX_ALIASES = 12;
export const MAX_ALIAS_FIELD = 300;

export interface AliasQuery {
  artist: string;
  title: string;
  isrc?: string;
}

export interface TrackAliases {
  titles: string[];
  artists: string[];
}

/** Minimal fetch the service needs; the global `fetch` fits. */
export type AliasFetch = (
  url: string,
  init: { headers: Record<string, string>; signal: AbortSignal; redirect: 'error' },
) => Promise<{ ok: boolean; status: number; headers?: { get(name: string): string | null }; text(): Promise<string> }>;

export interface AliasLookupOptions {
  fetch?: AliasFetch;
  now?: () => number;
  /** Spacing between MusicBrainz requests (default 1s, their published limit). */
  minIntervalMs?: number;
}

type Json = Record<string, unknown>;

const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const empty = (): TrackAliases => ({ titles: [], artists: [] });

/** Loose comparison form: NFKC, lowercase, no diacritics, punctuation or spaces. */
export function foldForMatch(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\p{P}\p{S}\s]+/gu, '');
}

function bigrams(s: string): string[] {
  const chars = [...s];
  if (chars.length < 2) return chars;
  const out: string[] = [];
  for (let i = 0; i < chars.length - 1; i++) out.push(chars[i] + chars[i + 1]);
  return out;
}

/** True when two strings are plausibly the same name (containment or Dice >= 0.6). */
export function looselyMatches(a: string, b: string): boolean {
  const x = foldForMatch(a);
  const y = foldForMatch(b);
  if (!x || !y) return false;
  if (x === y || x.includes(y) || y.includes(x)) return true;
  const bx = bigrams(x);
  const by = bigrams(y);
  const pool = new Map<string, number>();
  for (const g of by) pool.set(g, (pool.get(g) ?? 0) + 1);
  let hits = 0;
  for (const g of bx) {
    const n = pool.get(g) ?? 0;
    if (n > 0) {
      hits++;
      pool.set(g, n - 1);
    }
  }
  return (2 * hits) / (bx.length + by.length) >= 0.6;
}

/** Values of `name` and `sort-name` on each alias object. */
function aliasNames(raw: unknown): string[] {
  const out: string[] = [];
  for (const a of arr(raw)) {
    if (!isObj(a)) continue;
    const name = str(a['name']);
    const sort = str(a['sort-name']);
    if (name) out.push(name);
    if (sort) out.push(sort);
  }
  return out;
}

function recordingTitles(rec: Json): string[] {
  const out: string[] = [];
  const title = str(rec['title']);
  if (title) out.push(title);
  out.push(...aliasNames(rec['aliases']));
  for (const rel of arr(rec['relations'])) {
    if (!isObj(rel) || !isObj(rel['work'])) continue;
    const work = rel['work'];
    const wt = str(work['title']);
    if (wt) out.push(wt);
    out.push(...aliasNames(work['aliases']));
  }
  return out;
}

function recordingArtists(rec: Json): string[] {
  const out: string[] = [];
  for (const credit of arr(rec['artist-credit'])) {
    if (!isObj(credit)) continue;
    const credited = str(credit['name']);
    if (credited) out.push(credited);
    if (!isObj(credit['artist'])) continue;
    const artist = credit['artist'];
    const name = str(artist['name']);
    const sort = str(artist['sort-name']);
    if (name) out.push(name);
    if (sort) out.push(sort);
    out.push(...aliasNames(artist['aliases']));
  }
  return out;
}

/** Case/space-insensitive de-duplication, capped, with each value length-bounded. */
function dedupe(values: string[], cap = MAX_ALIASES): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of values) {
    const v = raw.replace(/\s+/g, ' ').trim();
    if (!v || v.length > MAX_ALIAS_FIELD) continue;
    const key = v.normalize('NFKC').toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(v);
    if (out.length >= cap) break;
  }
  return out;
}

/**
 * Parse a MusicBrainz recording search response. With `exact` (an ISRC hit)
 * the top results are trusted; otherwise only results with a decent score
 * whose title or artist loosely matches the query are used.
 */
export function parseRecordingAliases(body: unknown, query: AliasQuery, exact = false): TrackAliases {
  if (!isObj(body)) return empty();
  const titles: string[] = [];
  const artists: string[] = [];
  let used = 0;
  for (const rec of arr(body['recordings'])) {
    if (used >= MAX_RESULTS) break;
    if (!isObj(rec)) continue;
    const t = recordingTitles(rec);
    const a = recordingArtists(rec);
    if (!t.length) continue;
    if (!exact) {
      const score = typeof rec['score'] === 'number' ? rec['score'] : Number(rec['score']);
      if (!(score >= MIN_SCORE)) continue;
      const titleOk = t.some((x) => looselyMatches(x, query.title));
      const artistOk = !!query.artist.trim() && a.some((x) => looselyMatches(x, query.artist));
      // Artist-only agreement needs a near-certain search score (title may be in another script).
      if (!titleOk && !(artistOk && score >= STRONG_SCORE)) continue;
    }
    titles.push(...t);
    artists.push(...a);
    used++;
  }
  return { titles: dedupe(titles), artists: dedupe(artists) };
}

/** Escape Lucene special characters inside a quoted phrase. */
function phrase(s: string): string {
  return `"${s.replace(/[\\"]/g, '\\$&')}"`;
}

export function buildSearchUrl(luceneQuery: string): string {
  const params = new URLSearchParams({ query: luceneQuery, fmt: 'json', limit: '5' });
  // `inc` uses a literal '+' separator (URLSearchParams would encode it as %2B).
  return `${ENDPOINT}?${params}&inc=aliases+artist-credits`;
}

export function textQuery(q: AliasQuery): string {
  const title = q.title.trim().slice(0, MAX_ALIAS_FIELD);
  const artist = q.artist.trim().slice(0, MAX_ALIAS_FIELD);
  const parts = [`recording:${phrase(title)}`];
  if (artist) parts.push(`artist:${phrase(artist)}`);
  return parts.join(' AND ');
}

const ISRC_RE = /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/;

export function normalizeIsrc(raw: string | undefined): string | undefined {
  const v = raw?.replace(/[\s-]/g, '').toUpperCase();
  return v && ISRC_RE.test(v) ? v : undefined;
}

export interface AliasLookup {
  lookup(query: AliasQuery): Promise<TrackAliases>;
}

/** GET a MusicBrainz JSON document through a 1 req/s serialized queue. */
export type PacedJson = (url: string) => Promise<unknown>;

/**
 * A serialized MusicBrainz fetcher: each request starts at least
 * `minIntervalMs` after the previous one, the queue is bounded, redirects
 * are refused and bodies are size-capped.
 */
export function createPacedJson(options: AliasLookupOptions = {}): PacedJson {
  // Read the global lazily so it can be swapped (tests) after the module loads.
  const fetchFn: AliasFetch = options.fetch ?? ((url, init) => globalThis.fetch(url, init));
  const now = options.now ?? Date.now;
  const interval = options.minIntervalMs ?? MIN_INTERVAL_MS;
  let tail: Promise<void> = Promise.resolve();
  let lastStart = -Infinity;
  let queued = 0;
  const paced = <T>(task: () => Promise<T>): Promise<T> => {
    if (queued >= MAX_QUEUE) return Promise.reject(new Error('musicbrainz queue full'));
    queued++;
    const run = tail.then(async () => {
      const wait = lastStart + interval - now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      lastStart = now();
      queued--;
      return task();
    });
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  return (url: string): Promise<unknown> =>
    paced(async () => {
      const res = await fetchFn(url, {
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
        redirect: 'error',
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} from musicbrainz`);
      const declared = Number(res.headers?.get('content-length') ?? '');
      if (Number.isFinite(declared) && declared > MAX_JSON_BYTES) throw new Error('response too large');
      const text = await res.text();
      if (text.length > MAX_JSON_BYTES) throw new Error('response too large');
      return JSON.parse(text) as unknown;
    });
}

/** Process-wide MusicBrainz queue shared by aliases and enrichment (keeps us at 1 req/s overall). */
export const musicBrainzJson: PacedJson = createPacedJson();

/** Aliases service with a 1 req/s serialized queue and a bounded TTL cache. */
export function createAliasLookup(options: AliasLookupOptions = {}): AliasLookup {
  const now = options.now ?? Date.now;
  const custom = options.fetch || options.now || options.minIntervalMs !== undefined;
  const getJson = custom ? createPacedJson(options) : musicBrainzJson;
  const cache = new Map<string, { value: TrackAliases; until: number }>();
  const inflight = new Map<string, Promise<TrackAliases>>();

  const fetchAliases = async (q: AliasQuery): Promise<{ value: TrackAliases; ok: boolean }> => {
    try {
      const isrc = normalizeIsrc(q.isrc);
      if (isrc) {
        const byIsrc = parseRecordingAliases(await getJson(buildSearchUrl(`isrc:${isrc}`)), q, true);
        if (byIsrc.titles.length) return { value: byIsrc, ok: true };
      }
      if (!q.title.trim()) return { value: empty(), ok: true };
      return { value: parseRecordingAliases(await getJson(buildSearchUrl(textQuery(q))), q), ok: true };
    } catch {
      return { value: empty(), ok: false };
    }
  };

  const store = (key: string, value: TrackAliases): void => {
    const hit = value.titles.length > 0 || value.artists.length > 0;
    cache.delete(key);
    cache.set(key, { value, until: now() + (hit ? HIT_TTL_MS : MISS_TTL_MS) });
    while (cache.size > MAX_CACHE) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
  };

  return {
    async lookup(q: AliasQuery): Promise<TrackAliases> {
      const key = [normalizeIsrc(q.isrc) ?? '', foldForMatch(q.artist), foldForMatch(q.title)].join('|');
      const cached = cache.get(key);
      if (cached && cached.until > now()) {
        cache.delete(key); // refresh LRU position
        cache.set(key, cached);
        return cached.value;
      }
      cache.delete(key);
      const pending = inflight.get(key);
      if (pending) return pending;
      const promise = fetchAliases(q)
        .then(({ value, ok }) => {
          // Transient failures (network, busy queue) are not cached as misses.
          if (ok) store(key, value);
          return value;
        })
        .finally(() => inflight.delete(key));
      inflight.set(key, promise);
      return promise;
    },
  };
}

/** Process-wide instance used by the route. */
export const aliasLookup = createAliasLookup();
