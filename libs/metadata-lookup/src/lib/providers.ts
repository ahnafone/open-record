import type { MetadataMatch, MetadataQuery } from './types';

/** Minimal request init the lookup uses; a global `fetch` or an injected native transport both fit. */
export interface MetadataFetchInit {
  headers?: Record<string, string>;
  signal?: AbortSignal;
  redirect?: 'error' | 'follow' | 'manual';
}

/** Injected HTTP client. Must resolve to a response-like object (`ok`, `status`, `text()`). */
export type MetadataFetch = (
  url: string,
  init?: MetadataFetchInit,
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export const USER_AGENT = 'OpenRecordServer/1.0 (self-hosted personal music library tagger)';
const TIMEOUT_MS = 6000;
const MAX_JSON_BYTES = 2 * 1024 * 1024;

type Json = Record<string, unknown>;

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

async function getJson(fetchFn: MetadataFetch, url: string): Promise<Json> {
  const res = await fetchFn(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
    redirect: 'error',
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
  const text = await res.text();
  if (text.length > MAX_JSON_BYTES) throw new Error('response too large');
  const body: unknown = JSON.parse(text);
  if (!body || typeof body !== 'object') throw new Error('unexpected response');
  return body as Json;
}

function searchTerm(q: MetadataQuery): string {
  return [q.artist, q.title].filter(Boolean).join(' ').slice(0, 200);
}

/** iTunes `artworkUrl100` ".../100x100bb.jpg" -> ".../1000x1000bb.jpg". */
export function upsizeItunesArtwork(url: string): string {
  return url.replace(/\/\d+x\d+(bb)?(-\d+)?\.(jpg|jpeg|png|webp)$/i, '/1000x1000bb.jpg');
}

export function parseItunes(body: Json): MetadataMatch[] {
  const results = Array.isArray(body['results']) ? (body['results'] as Json[]) : [];
  const out: MetadataMatch[] = [];
  for (const r of results) {
    if (!r || typeof r !== 'object' || (r['kind'] !== undefined && r['kind'] !== 'song')) continue;
    const title = str(r['trackName']);
    const artist = str(r['artistName']);
    if (!title || !artist) continue;
    const year = Number.parseInt(str(r['releaseDate'])?.slice(0, 4) ?? '', 10);
    const ms = num(r['trackTimeMillis']);
    const art = str(r['artworkUrl100']);
    out.push({
      title,
      artist,
      album: str(r['collectionName']),
      year: Number.isFinite(year) ? year : undefined,
      genre: str(r['primaryGenreName']),
      artworkUrl: art ? upsizeItunesArtwork(art) : undefined,
      durationSec: ms !== undefined ? Math.round(ms / 1000) : undefined,
      source: 'itunes',
    });
  }
  return out;
}

export function parseDeezer(body: Json): MetadataMatch[] {
  const data = Array.isArray(body['data']) ? (body['data'] as Json[]) : [];
  const out: MetadataMatch[] = [];
  for (const r of data) {
    if (!r || typeof r !== 'object') continue;
    const artistObj = (r['artist'] ?? {}) as Json;
    const albumObj = (r['album'] ?? {}) as Json;
    const title = str(r['title']);
    const artist = str(artistObj['name']);
    if (!title || !artist) continue;
    out.push({
      title,
      artist,
      album: str(albumObj['title']),
      artworkUrl: str(albumObj['cover_xl']),
      durationSec: num(r['duration']),
      source: 'deezer',
    });
  }
  return out;
}

export async function searchItunes(q: MetadataQuery, fetchFn: MetadataFetch): Promise<MetadataMatch[]> {
  const url = new URL('https://itunes.apple.com/search');
  url.searchParams.set('term', searchTerm(q));
  url.searchParams.set('media', 'music');
  url.searchParams.set('entity', 'song');
  url.searchParams.set('limit', '10');
  return parseItunes(await getJson(fetchFn, url.toString()));
}

export async function searchDeezer(q: MetadataQuery, fetchFn: MetadataFetch): Promise<MetadataMatch[]> {
  const url = new URL('https://api.deezer.com/search');
  url.searchParams.set('q', searchTerm(q));
  url.searchParams.set('limit', '10');
  const body = await getJson(fetchFn, url.toString());
  // Deezer reports quota/other errors with HTTP 200 and an `error` object.
  if (body['error']) throw new Error('Deezer API error');
  return parseDeezer(body);
}
