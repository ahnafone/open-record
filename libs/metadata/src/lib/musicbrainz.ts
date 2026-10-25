/** Info-only recording result (not playable). */
export interface MetadataRecording {
  recordingMbid: string;
  title: string;
  /** Joined artist credit, e.g. "A feat. B". */
  artist: string;
  artistMbids: string[];
  album?: string;
  releaseMbid?: string;
  releaseGroupMbid?: string;
  year?: number;
  durationMs?: number;
  /** Genres/tags, most-voted first. */
  genres: string[];
  /** MusicBrainz search relevance, 0-100. */
  searchScore: number;
}

export interface EnrichQuery {
  title: string;
  artist: string;
  album?: string;
  durationMs?: number;
}

// ---------- Response parsing (defensive: the payload is untrusted) ----------

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v : undefined);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined;

function parseYear(date: unknown): number | undefined {
  const m = /^(\d{4})/.exec(str(date) ?? '');
  return m ? Number(m[1]) : undefined;
}

/** Genres first, then tags; sorted by vote count, deduped, max 5. */
export function parseGenres(entity: unknown): string[] {
  if (!isObj(entity)) return [];
  const items = [...arr(entity['genres']), ...arr(entity['tags'])]
    .filter(isObj)
    .map((t) => ({ name: str(t['name'])?.toLowerCase(), count: num(t['count']) ?? 0 }))
    .filter((t): t is { name: string; count: number } => !!t.name && t.count >= 0)
    .sort((a, b) => b.count - a.count);
  return [...new Set(items.map((t) => t.name))].slice(0, 5);
}

interface ParsedRelease {
  id?: string;
  title?: string;
  releaseGroupId?: string;
  year?: number;
  official: boolean;
  album: boolean;
}

function parseRelease(r: Obj): ParsedRelease {
  const rg = isObj(r['release-group']) ? r['release-group'] : {};
  return {
    id: str(r['id']),
    title: str(r['title']),
    releaseGroupId: str(rg['id']),
    year: parseYear(r['date']),
    official: str(r['status'])?.toLowerCase() === 'official',
    album: str(rg['primary-type'])?.toLowerCase() === 'album',
  };
}

/** Prefer the release matching `album`, then official albums, then the earliest. */
function pickRelease(releases: ParsedRelease[], album?: string): ParsedRelease | undefined {
  const rank = (r: ParsedRelease) =>
    (album && r.title ? similarity(r.title, album) * 4 : 0) + (r.official ? 2 : 0) + (r.album ? 1 : 0);
  return [...releases].sort(
    (a, b) => rank(b) - rank(a) || (a.year ?? 9999) - (b.year ?? 9999),
  )[0];
}

export function parseRecording(raw: unknown, album?: string): MetadataRecording | null {
  if (!isObj(raw)) return null;
  const id = str(raw['id']);
  const title = str(raw['title']);
  if (!id || !title) return null;
  const credits = arr(raw['artist-credit']).filter(isObj);
  const artist = credits
    .map((c) => `${str(c['name']) ?? (isObj(c['artist']) ? str(c['artist']['name']) : '') ?? ''}${typeof c['joinphrase'] === 'string' ? c['joinphrase'] : ''}`)
    .join('')
    .trim();
  const artistMbids = credits
    .map((c) => (isObj(c['artist']) ? str(c['artist']['id']) : undefined))
    .filter((v): v is string => !!v);
  const release = pickRelease(arr(raw['releases']).filter(isObj).map(parseRelease), album);
  return {
    recordingMbid: id,
    title,
    artist,
    artistMbids,
    album: release?.title,
    releaseMbid: release?.id,
    releaseGroupMbid: release?.releaseGroupId,
    year: parseYear(raw['first-release-date']) ?? release?.year,
    durationMs: num(raw['length']),
    genres: parseGenres(raw),
    searchScore: num(raw['score']) ?? 0,
  };
}

/** Parse a `/ws/2/recording?query=...&fmt=json` response. */
export function parseRecordingSearch(body: unknown, album?: string): MetadataRecording[] {
  if (!isObj(body)) return [];
  return arr(body['recordings'])
    .map((r) => parseRecording(r, album))
    .filter((r): r is MetadataRecording => r !== null);
}

// ---------- Query building ----------

/** Escape Lucene special characters inside a quoted phrase. */
export function luceneEscape(value: string): string {
  return value.replace(/[\\"]/g, '\\$&').trim();
}

export function buildEnrichQuery(q: EnrichQuery): string {
  return `recording:"${luceneEscape(q.title)}" AND artist:"${luceneEscape(q.artist)}"`;
}

// ---------- Scoring ----------

export function normalize(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s*[([].*?(feat|ft\.|remaster|version|edit|mix|live|mono|stereo).*?[)\]]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** 0..1 similarity: exact 1, containment 0.9, else token Dice coefficient. */
export function similarity(a: string, b: string): number {
  const na = normalize(a);
  const nb = normalize(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  if (na.includes(nb) || nb.includes(na)) return 0.9;
  const ta = new Set(na.split(' '));
  const tb = new Set(nb.split(' '));
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  return (2 * shared) / (ta.size + tb.size);
}

/**
 * Duration agreement: 1 within 3s, linear to 0 at 30s apart.
 * Neutral 0.5 when either side is unknown.
 */
export function durationScore(expectedMs?: number, actualMs?: number): number {
  if (!expectedMs || !actualMs) return 0.5;
  const diff = Math.abs(expectedMs - actualMs);
  if (diff <= 3000) return 1;
  if (diff >= 30000) return 0;
  return 1 - (diff - 3000) / 27000;
}

/** Weighted 0..1 match score for a candidate against the query. */
export function scoreCandidate(q: EnrichQuery, c: MetadataRecording): number {
  const title = similarity(q.title, c.title);
  const artist = similarity(q.artist, c.artist);
  const duration = durationScore(q.durationMs, c.durationMs);
  const album = q.album && c.album ? similarity(q.album, c.album) : 0.5;
  const search = Math.min(Math.max(c.searchScore, 0), 100) / 100;
  return 0.35 * title + 0.3 * artist + 0.2 * duration + 0.05 * album + 0.1 * search;
}

/** Minimum `scoreCandidate` value for `enrich` to accept a match. */
export const ENRICH_SCORE_THRESHOLD = 0.75;

export function bestCandidate(
  q: EnrichQuery,
  candidates: MetadataRecording[],
  threshold = ENRICH_SCORE_THRESHOLD,
): { candidate: MetadataRecording; score: number } | null {
  let best: { candidate: MetadataRecording; score: number } | null = null;
  for (const candidate of candidates) {
    // Guard against confident text matches that are clearly a different cut.
    if (q.durationMs && candidate.durationMs && durationScore(q.durationMs, candidate.durationMs) === 0) {
      continue;
    }
    const score = scoreCandidate(q, candidate);
    if (score >= threshold && (!best || score > best.score)) best = { candidate, score };
  }
  return best;
}
