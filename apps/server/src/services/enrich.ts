/**
 * Catalogue metadata for songs imported from YouTube playlists. Each song is
 * looked up in YouTube Music (yt-dlp), the iTunes Search API, the Deezer
 * search API and MusicBrainz; candidates are scored against the query and
 * confident ones are merged (weaker ones come back as review suggestions). Every source has its own timeout and fails
 * soft. Results (never raw payloads) are kept in a bounded in-memory cache.
 */
import {
  ENRICH_SOURCES,
  type EnrichMatch,
  type EnrichQuery,
  type EnrichSource,
} from '@open-record/models';
import { buildSearchUrl, foldForMatch, musicBrainzJson, textQuery, USER_AGENT } from './musicbrainz';
import { createLimiter } from './resolve-limiter';
import { runYtDlpJson, searchTarget, toSearchResult, type YtDlpInfo } from './ytdlp';

/** A song as one catalogue describes it. */
export interface EnrichCandidate {
  source: EnrichSource;
  title: string;
  artist: string;
  album?: string;
  year?: number;
  genre?: string;
  artUrl?: string;
  durationSec?: number;
}

/** Scores at or above this replace the YouTube metadata. */
export const HIGH_CONFIDENCE = 0.82;
/** Weaker matches at or above this are returned as review suggestions. */
export const LOW_CONFIDENCE = 0.45;
/** Most suggestions returned per song when none is confident. */
export const MAX_SUGGESTIONS = 3;
export const MAX_ENRICH_FIELD = 300;

const HTTP_TIMEOUT_MS = 6000;
const YTMUSIC_TIMEOUT_MS = 25_000;
const MAX_JSON_BYTES = 1024 * 1024;
const ITEM_CONCURRENCY = 3;
const HIT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MISS_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_CACHE = 2000;
const CANDIDATES = 5;

// ---------------------------------------------------------------------------
// Scoring (pure)
// ---------------------------------------------------------------------------

/** Bracketed noise and featured-artist tails that never decide a match. */
const BRACKET = /\s*[([][^)\]]*[)\]]/g;
const FEAT = /\s+(?:feat\.?|ft\.?|featuring|with)\s+.+$/i;
const VERSION_WORDS = ['live', 'remix', 'acoustic', 'instrumental', 'karaoke', 'cover', 'demo', 'slowed', 'sped up', 'nightcore'];

/** Title comparison form: brackets, "feat." tails and punctuation removed. */
export function normalizeTitle(s: string): string {
  return foldForMatch(s.replace(BRACKET, ' ').replace(FEAT, '')) || foldForMatch(s);
}

function bigrams(s: string): string[] {
  const chars = [...s];
  if (chars.length < 2) return chars;
  const out: string[] = [];
  for (let i = 0; i < chars.length - 1; i++) out.push(chars[i] + chars[i + 1]);
  return out;
}

/** 0..1 similarity of two folded strings (Dice over bigrams, containment counts high). */
export function similarity(x: string, y: string): number {
  if (!x || !y) return 0;
  if (x === y) return 1;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  if (long.includes(short) && short.length >= 3) return Math.max(0.75, 0.75 + 0.25 * (short.length / long.length));
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
  return (2 * hits) / (bx.length + by.length);
}

/** Individual names in an artist credit ("A feat. B", "A & B", "A, B"). */
export function splitArtists(s: string): string[] {
  return s
    .split(/\s*(?:,|&|;|\/|\+|\bx\b|\band\b|\bfeat\.?|\bft\.?|\bfeaturing\b|\bwith\b|\bvs\.?)\s*/i)
    .map(foldForMatch)
    .filter(Boolean);
}

function artistSimilarity(query: string, candidate: string): number {
  if (!query.trim()) return 0.5;
  const whole = similarity(foldForMatch(query), foldForMatch(candidate));
  let best = whole;
  for (const a of splitArtists(query)) {
    for (const b of splitArtists(candidate)) best = Math.max(best, similarity(a, b));
  }
  return best;
}

function durationScore(a?: number, b?: number): number | undefined {
  if (a === undefined || b === undefined || a <= 0 || b <= 0) return undefined;
  const diff = Math.abs(a - b);
  if (diff <= 2) return 1;
  if (diff <= 5) return 0.9;
  if (diff <= 10) return 0.6;
  if (diff <= 20) return 0.3;
  return 0;
}

function versionWords(s: string): Set<string> {
  const lower = s.toLowerCase();
  return new Set(VERSION_WORDS.filter((w) => new RegExp(`\\b${w}\\b`).test(lower)));
}

/**
 * 0..1 confidence that `candidate` is the song described by `query`: title
 * similarity (0.55), artist similarity (0.35) and duration closeness (0.10,
 * weights renormalised when either duration is unknown). Weak titles or
 * artists, far-off durations and live/remix/... mismatches cap the score
 * below {@link HIGH_CONFIDENCE}.
 */
export function scoreCandidate(
  query: EnrichQuery,
  candidate: Pick<EnrichCandidate, 'title' | 'artist' | 'durationSec'>,
): number {
  const title = similarity(normalizeTitle(query.title), normalizeTitle(candidate.title));
  const artist = artistSimilarity(query.artist, candidate.artist);
  const duration = durationScore(query.durationSec, candidate.durationSec);
  let score = duration === undefined ? 0.6 * title + 0.4 * artist : 0.55 * title + 0.35 * artist + 0.1 * duration;
  if (title < 0.6 || artist < 0.5) score = Math.min(score, 0.5);
  if (duration === 0) score = Math.min(score, 0.6);
  const qv = versionWords(query.title);
  const cv = versionWords(candidate.title);
  if (qv.size !== cv.size || [...qv].some((w) => !cv.has(w))) score = Math.min(score, 0.6);
  return Math.max(0, Math.min(1, Math.round(score * 1000) / 1000));
}

type Scored = { c: EnrichCandidate; score: number };

/** One match from scored candidates: fields from the highest-priority source, gaps filled from the others. */
function mergeRanked(ranked: Scored[]): EnrichMatch {
  const primary = ranked[0];
  const match: EnrichMatch = {
    title: primary.c.title,
    artist: primary.c.artist,
    confidence: primary.score,
    sources: ranked.map((r) => r.c.source),
  };
  for (const { c } of ranked) {
    if (match.album === undefined && c.album) match.album = c.album;
    if (match.year === undefined && c.year) match.year = c.year;
    if (match.genre === undefined && c.genre) match.genre = c.genre;
    if (match.artUrl === undefined && c.artUrl) match.artUrl = c.artUrl;
    if (match.durationSec === undefined && c.durationSec) match.durationSec = c.durationSec;
  }
  return match;
}

/** Best candidate per source, in source priority order. */
function bestPerSource(scored: Scored[]): Scored[] {
  const best = new Map<EnrichSource, Scored>();
  for (const x of scored) {
    const prev = best.get(x.c.source);
    if (!prev || x.score > prev.score) best.set(x.c.source, x);
  }
  return ENRICH_SOURCES.map((s) => best.get(s)).filter((x): x is Scored => !!x);
}

/**
 * Merges confident candidates: fields come from the highest-priority source
 * (YT Music > iTunes > Deezer > MusicBrainz) and gaps are filled from the
 * others. When no candidate reaches {@link HIGH_CONFIDENCE}, returns the best
 * weaker suggestion (at or above {@link LOW_CONFIDENCE}) with up to
 * {@link MAX_SUGGESTIONS}-1 more in `alternatives`, each with its own score
 * (the same song from several sources is merged into one). Null when nothing
 * reaches the floor.
 */
export function mergeCandidates(query: EnrichQuery, candidates: EnrichCandidate[]): EnrichMatch | null {
  const scored = candidates.map((c) => ({ c, score: scoreCandidate(query, c) }));
  const confident = bestPerSource(scored.filter((x) => x.score >= HIGH_CONFIDENCE));
  if (confident.length) return mergeRanked(confident);
  const groups = new Map<string, Scored[]>();
  for (const x of scored) {
    if (x.score < LOW_CONFIDENCE) continue;
    const key = `${foldForMatch(x.c.artist)}|${foldForMatch(x.c.title)}`;
    groups.set(key, [...(groups.get(key) ?? []), x]);
  }
  const suggestions = [...groups.values()]
    .map((group) => ({ ...mergeRanked(bestPerSource(group)), confidence: Math.max(...group.map((x) => x.score)) }))
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, MAX_SUGGESTIONS);
  if (!suggestions.length) return null;
  const [first, ...rest] = suggestions;
  return rest.length ? { ...first, alternatives: rest } : first;
}

// ---------------------------------------------------------------------------
// Sources (each fails soft to [])
// ---------------------------------------------------------------------------

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() ? v.trim().slice(0, MAX_ENRICH_FIELD) : undefined;
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined);
const yearOf = (v: unknown): number | undefined => {
  const m = typeof v === 'string' ? /^(\d{4})/.exec(v) : null;
  const y = m ? Number(m[1]) : num(v);
  return y && y >= 1800 && y <= 2200 ? Math.trunc(y) : undefined;
};
const httpsUrl = (v: unknown): string | undefined => {
  const s = str(v);
  return s && s.startsWith('https://') && s.length <= 2048 ? s : undefined;
};

/** GET JSON from a fixed public API host; no redirects, size-capped, own timeout. */
async function getJson(url: string): Promise<unknown> {
  const res = await globalThis.fetch(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    redirect: 'error',
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const declared = Number(res.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > MAX_JSON_BYTES) throw new Error('response too large');
  const text = await res.text();
  if (text.length > MAX_JSON_BYTES) throw new Error('response too large');
  return JSON.parse(text) as unknown;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('timed out')), ms);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export function parseItunes(body: unknown): EnrichCandidate[] {
  if (!isObj(body)) return [];
  const out: EnrichCandidate[] = [];
  for (const r of arr(body['results']).slice(0, CANDIDATES)) {
    if (!isObj(r)) continue;
    const title = str(r['trackName']);
    const artist = str(r['artistName']);
    if (!title || !artist) continue;
    const c: EnrichCandidate = { source: 'itunes', title, artist };
    const album = str(r['collectionName']);
    if (album) c.album = album;
    const year = yearOf(r['releaseDate']);
    if (year) c.year = year;
    const genre = str(r['primaryGenreName']);
    if (genre) c.genre = genre;
    const art = httpsUrl(r['artworkUrl100']);
    if (art) c.artUrl = art.replace(/\/\d+x\d+bb\./, '/600x600bb.');
    const ms = num(r['trackTimeMillis']);
    if (ms) c.durationSec = Math.round(ms / 1000);
    out.push(c);
  }
  return out;
}

export function parseDeezer(body: unknown): EnrichCandidate[] {
  if (!isObj(body)) return [];
  const out: EnrichCandidate[] = [];
  for (const r of arr(body['data']).slice(0, CANDIDATES)) {
    if (!isObj(r)) continue;
    const title = str(r['title']);
    const artist = isObj(r['artist']) ? str(r['artist']['name']) : undefined;
    if (!title || !artist) continue;
    const c: EnrichCandidate = { source: 'deezer', title, artist };
    if (isObj(r['album'])) {
      const album = str(r['album']['title']);
      if (album) c.album = album;
      const art = httpsUrl(r['album']['cover_xl']) ?? httpsUrl(r['album']['cover_big']);
      if (art) c.artUrl = art;
    }
    const d = num(r['duration']);
    if (d) c.durationSec = Math.round(d);
    out.push(c);
  }
  return out;
}

export function parseMusicBrainz(body: unknown): EnrichCandidate[] {
  if (!isObj(body)) return [];
  const out: EnrichCandidate[] = [];
  for (const r of arr(body['recordings']).slice(0, CANDIDATES)) {
    if (!isObj(r)) continue;
    const title = str(r['title']);
    let artist = '';
    for (const credit of arr(r['artist-credit'])) {
      if (!isObj(credit)) continue;
      const name = str(credit['name']) ?? (isObj(credit['artist']) ? str(credit['artist']['name']) : undefined);
      if (name) artist += name + (typeof credit['joinphrase'] === 'string' ? credit['joinphrase'] : '');
    }
    artist = artist.trim();
    if (!title || !artist) continue;
    const c: EnrichCandidate = { source: 'musicbrainz', title, artist };
    const release = arr(r['releases']).find(isObj);
    const album = release ? str(release['title']) : undefined;
    if (album) c.album = album;
    const year = yearOf(r['first-release-date']);
    if (year) c.year = year;
    const tags = arr(r['tags'])
      .filter(isObj)
      .sort((a, b) => (num(b['count']) ?? 0) - (num(a['count']) ?? 0));
    const genre = tags.length ? str(tags[0]['name']) : undefined;
    if (genre) c.genre = genre.replace(/\b\w/g, (ch) => ch.toUpperCase());
    const ms = num(r['length']);
    if (ms) c.durationSec = Math.round(ms / 1000);
    out.push(c);
  }
  return out;
}

const searchTerm = (q: EnrichQuery): string => `${q.artist} ${q.title}`.trim();

async function fromItunes(q: EnrichQuery): Promise<EnrichCandidate[]> {
  const params = new URLSearchParams({ term: searchTerm(q), media: 'music', entity: 'song', limit: String(CANDIDATES) });
  return parseItunes(await getJson(`https://itunes.apple.com/search?${params}`));
}

async function fromDeezer(q: EnrichQuery): Promise<EnrichCandidate[]> {
  const quote = (s: string): string => `"${s.replace(/"/g, ' ')}"`;
  const query = q.artist.trim() ? `artist:${quote(q.artist)} track:${quote(q.title)}` : q.title;
  const params = new URLSearchParams({ q: query, limit: String(CANDIDATES) });
  return parseDeezer(await getJson(`https://api.deezer.com/search?${params}`));
}

async function fromMusicBrainz(q: EnrichQuery): Promise<EnrichCandidate[]> {
  return parseMusicBrainz(await musicBrainzJson(buildSearchUrl(textQuery(q))));
}

/** One YT Music lookup at a time server-wide, so enrichment never crowds out playback. */
const ytMusicGate = createLimiter({ max: 1, maxQueue: 8, waitMs: 15_000 });

/** Square album art from a YT Music thumbnail list (googleusercontent), largest last. */
function squareArt(info: YtDlpInfo): string | undefined {
  const urls = (info.thumbnails ?? []).map((t) => httpsUrl(t.url)).filter((u): u is string => !!u);
  return urls.filter((u) => /\.googleusercontent\.com\//.test(u)).at(-1);
}

/**
 * YT Music: a flat Songs search, then one full lookup of the best title match
 * for its track/artist/album/year (flat entries carry little more than a title).
 */
async function fromYtMusic(q: EnrichQuery): Promise<EnrichCandidate[]> {
  const target = searchTarget('ytmusic', searchTerm(q).slice(0, 200));
  if (!target) return [];
  return ytMusicGate.run(async () => {
    const flat = await runYtDlpJson(['-J', '--flat-playlist', '--playlist-end', '3', '--', target]);
    const wanted = normalizeTitle(q.title);
    const pick = (flat.entries ?? [])
      .filter((e): e is YtDlpInfo => !!e && typeof e.id === 'string' && /^[\w-]{11}$/.test(e.id))
      .map((e) => ({ e, s: similarity(wanted, normalizeTitle(e.title ?? '')) }))
      .sort((a, b) => b.s - a.s)[0];
    if (!pick || pick.s < 0.6) return [];
    const url = `https://music.youtube.com/watch?v=${pick.e.id}`;
    const info = await runYtDlpJson(['-J', '--no-playlist', '--', url]);
    const r = toSearchResult({ ...info, id: pick.e.id, webpage_url: url }, 'ytmusic');
    if (!r?.title || !r.artist) return [];
    const c: EnrichCandidate = { source: 'ytmusic', title: r.title.slice(0, MAX_ENRICH_FIELD), artist: r.artist.slice(0, MAX_ENRICH_FIELD) };
    const album = str(info.album);
    if (album) c.album = album;
    const year = yearOf(info.release_year);
    if (year) c.year = year;
    const genre = str(info.genre) ?? str(info.genres?.[0]);
    if (genre) c.genre = genre;
    const art = squareArt(info);
    if (art) c.artUrl = art;
    if (r.durationSec) c.durationSec = r.durationSec;
    return [c];
  });
}

type SourceFn = (q: EnrichQuery) => Promise<EnrichCandidate[]>;

const SOURCES: { fn: SourceFn; timeoutMs: number }[] = [
  { fn: fromYtMusic, timeoutMs: YTMUSIC_TIMEOUT_MS },
  { fn: fromItunes, timeoutMs: HTTP_TIMEOUT_MS + 1000 },
  { fn: fromDeezer, timeoutMs: HTTP_TIMEOUT_MS + 1000 },
  // Waits in the shared 1 req/s queue, so it gets a longer budget.
  { fn: fromMusicBrainz, timeoutMs: 20_000 },
];

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

const cache = new Map<string, { value: EnrichMatch | null; until: number }>();
const inflight = new Map<string, Promise<EnrichMatch | null>>();

const cacheKey = (q: EnrichQuery): string =>
  [foldForMatch(q.artist), normalizeTitle(q.title), q.durationSec ? Math.round(q.durationSec / 5) : ''].join('|');

function remember(key: string, value: EnrichMatch | null): void {
  cache.delete(key);
  const confident = !!value && value.confidence >= HIGH_CONFIDENCE;
  cache.set(key, { value, until: Date.now() + (confident ? HIT_TTL_MS : MISS_TTL_MS) });
  while (cache.size > MAX_CACHE) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

async function lookupUncached(q: EnrichQuery): Promise<{ value: EnrichMatch | null; complete: boolean }> {
  const settled = await Promise.allSettled(SOURCES.map((s) => withTimeout(s.fn(q), s.timeoutMs)));
  const candidates = settled.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
  const value = mergeCandidates(q, candidates);
  // A miss or weak match with failed sources is not cached: a retry may do better.
  return { value, complete: settled.every((r) => r.status === 'fulfilled') };
}

/** Best catalogue match for one song (confident, or weaker suggestions), or null. Never throws. */
export async function enrichOne(raw: EnrichQuery): Promise<EnrichMatch | null> {
  const q: EnrichQuery = {
    title: raw.title.trim().slice(0, MAX_ENRICH_FIELD),
    artist: raw.artist.trim().slice(0, MAX_ENRICH_FIELD),
  };
  if (raw.durationSec && raw.durationSec > 0) q.durationSec = Math.round(raw.durationSec);
  if (raw.album?.trim()) q.album = raw.album.trim().slice(0, MAX_ENRICH_FIELD);
  if (!q.title) return null;
  const key = cacheKey(q);
  const hit = cache.get(key);
  if (hit && hit.until > Date.now()) {
    cache.delete(key);
    cache.set(key, hit);
    return hit.value;
  }
  cache.delete(key);
  const pending = inflight.get(key);
  if (pending) return pending;
  const promise = lookupUncached(q)
    .then(({ value, complete }) => {
      if (complete || (value && value.confidence >= HIGH_CONFIDENCE)) remember(key, value);
      return value;
    })
    .catch(() => null)
    .finally(() => inflight.delete(key));
  inflight.set(key, promise);
  return promise;
}

/** Enriches a batch a few songs at a time; one failing song or source never fails the batch. */
export async function enrichBatch(items: EnrichQuery[]): Promise<(EnrichMatch | null)[]> {
  const results: (EnrichMatch | null)[] = new Array(items.length).fill(null);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      results[i] = await enrichOne(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(ITEM_CONCURRENCY, items.length) }, worker));
  return results;
}
