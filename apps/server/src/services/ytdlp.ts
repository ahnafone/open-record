import { execFile } from 'node:child_process';
import type { AudioQuality } from '@open-record/models';
import { createLimiter } from './resolve-limiter';

/** yt-dlp binary; override with YTDLP_PATH. */
export const YTDLP_BIN = process.env['YTDLP_PATH']?.trim() || 'yt-dlp';

/** Arguments every yt-dlp call gets: no user config files, JS challenges solved with Node. */
export const BASE_ARGS = [
  '--ignore-config',
  '--no-colors',
  '--js-runtimes',
  'node',
];

export const SEARCH_LIMIT = 15;
export const MAX_QUERY_LENGTH = 200;
const INFO_TIMEOUT_MS = 45_000;
const INFO_MAX_BUFFER = 32 * 1024 * 1024;
/** Queued yt-dlp calls give up waiting for a slot after this long. */
const QUEUE_WAIT_MS = 20_000;
/** Default number of yt-dlp calls allowed to wait for a slot. */
const DEFAULT_MAX_QUEUE = 16;
/** Audio format selector for streams: prefer m4a, which every phone plays natively. */
export const STREAM_FORMAT = 'bestaudio[ext=m4a]/bestaudio/best';

/** Average-bitrate caps (kbps) for the capped quality levels. */
export const QUALITY_MAX_ABR: Record<
  Exclude<AudioQuality, 'highest'>,
  number
> = {
  high: 160,
  medium: 128,
  low: 64,
};

/**
 * yt-dlp format selector for a quality level. Capped levels take the best
 * audio at or under the cap (m4a first); when every format is above it, the
 * smallest one above the cap (closest); when bitrates are unknown, the plain
 * `STREAM_FORMAT` choice.
 */
export function streamFormatFor(quality: AudioQuality = 'highest'): string {
  if (quality === 'highest') return STREAM_FORMAT;
  const cap = QUALITY_MAX_ABR[quality];
  return [
    `bestaudio[ext=m4a][abr<=${cap}]`,
    `bestaudio[abr<=${cap}]`,
    `worstaudio[ext=m4a][abr>${cap}]`,
    `worstaudio[abr>${cap}]`,
    STREAM_FORMAT,
  ].join('/');
}

export const SEARCH_SOURCES = [
  'youtube',
  'ytmusic',
  'soundcloud',
  'bandcamp',
  'audiomack',
  'mixcloud',
] as const;
export type SearchSource = (typeof SEARCH_SOURCES)[number];

export interface SearchResult {
  id: string;
  title: string;
  artist: string;
  durationSec?: number;
  thumbnailUrl?: string;
  url: string;
  site: string;
}

/** yt-dlp failed or was misused; `status` is the HTTP status to answer with. */
export class YtDlpError extends Error {
  constructor(
    message: string,
    readonly status = 502,
  ) {
    super(message);
  }
}

/** The subset of yt-dlp's info dict the server reads. */
export interface YtDlpInfo {
  id?: string;
  title?: string;
  track?: string;
  artist?: string;
  artists?: string[];
  creator?: string;
  uploader?: string;
  channel?: string;
  album?: string;
  genre?: string;
  genres?: string[];
  release_year?: number;
  upload_date?: string;
  duration?: number;
  thumbnail?: string;
  thumbnails?: { url?: string }[];
  url?: string;
  protocol?: string;
  ext?: string;
  http_headers?: Record<string, string>;
  webpage_url?: string;
  original_url?: string;
  extractor_key?: string;
  ie_key?: string;
  _type?: string;
  entries?: (YtDlpInfo | null)[];
}

/**
 * Builds the yt-dlp search target for a source. bandcamp, audiomack and
 * mixcloud have no search extractor in yt-dlp (neither a `xxsearch:` prefix
 * nor a search-URL extractor), so they return null and the route answers 400.
 */
export function searchTarget(
  source: SearchSource,
  query: string,
): string | null {
  switch (source) {
    case 'youtube':
      return `ytsearch${SEARCH_LIMIT}:${query}`;
    case 'soundcloud':
      return `scsearch${SEARCH_LIMIT}:${query}`;
    case 'ytmusic':
      // YoutubeMusicSearchURL extractor; #songs limits it to the Songs shelf.
      return `https://music.youtube.com/search?q=${encodeURIComponent(query)}#songs`;
    default:
      return null;
  }
}

/** Short site name for a URL (youtube, ytmusic, soundcloud, bandcamp, ...). */
export function siteFromUrl(raw: string): string {
  let host: string;
  try {
    host = new URL(raw).hostname.toLowerCase().replace(/^(www|m)\./, '');
  } catch {
    return 'unknown';
  }
  if (host === 'music.youtube.com') return 'ytmusic';
  if (
    host === 'youtube.com' ||
    host === 'youtu.be' ||
    host.endsWith('.youtube.com')
  )
    return 'youtube';
  for (const site of ['soundcloud', 'bandcamp', 'audiomack', 'mixcloud']) {
    if (host === `${site}.com` || host.endsWith(`.${site}.com`)) return site;
  }
  return host;
}

const clean = (s: unknown): string | undefined =>
  typeof s === 'string' && s.trim() ? s.trim() : undefined;

/**
 * Cleans a channel/uploader name into an artist name: drops YouTube's
 * auto-generated " - Topic" suffix and a trailing "VEVO" (splitting the
 * remaining CamelCase, so "DaftPunkVEVO" becomes "Daft Punk"). Empty when nothing is left.
 */
export function normalizeArtist(raw: string | undefined): string {
  let name = raw?.trim() ?? '';
  name = name.replace(/\s+-\s+Topic$/i, '').trim();
  const vevo = /^(.*?)\s*VEVO$/.exec(name);
  if (vevo) {
    const base = vevo[1].trim();
    name = /\s/.test(base) ? base : base.replace(/([a-z])([A-Z])/g, '$1 $2');
  }
  return name.trim();
}

/** Best artist guess from the info dict; empty when none is known. */
export function artistOf(info: YtDlpInfo): string {
  const candidates = [
    info.artist,
    info.artists?.[0],
    info.creator,
    info.uploader,
    info.channel,
  ];
  for (const c of candidates) {
    const name = normalizeArtist(clean(c));
    if (name) return name;
  }
  return '';
}

/** Channel names that belong to a label or aggregator rather than the artist. */
const LABEL_LIKE =
  /VEVO$|\b(records|recordings|music|entertainment|label|media|tv|official charts|lyrics|hits)\b/i;

/** Bracketed title noise: "(Official Music Video)", "[Lyrics]", "(HD)", ... ("Remastered" is kept). */
const TITLE_NOISE =
  /\s*[([]\s*(?:official\s+)?(?:(?:music|lyrics?|hd|4k)\s+)?(?:video|audio|visuali[sz]er)(?:\s+(?:hd|4k|hq))?\s*[)\]]|\s*[([]\s*(?:lyrics?|hd|hq|4k|official)\s*[)\]]/gi;

const squash = (s: string): string =>
  s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

/**
 * Splits video-style titles into track and artist. Drops bracketed noise
 * such as "(Official Music Video)" and, for "Artist - Title" titles, takes
 * the artist from the title when the channel is missing, label-like or VEVO
 * (or is the same artist). `artist` is the raw channel/uploader name.
 */
export function parseTitle(
  title: string,
  artist?: string,
): { title: string; artist: string } {
  const raw = artist?.trim() ?? '';
  const channel = normalizeArtist(raw);
  let text =
    title
      .replace(TITLE_NOISE, '')
      .replace(/\s{2,}/g, ' ')
      .trim() || title.trim();

  const split = /^(.+?)\s+[-\u2013\u2014]\s+(.+)$/.exec(text);
  if (split) {
    const left = split[1].trim();
    const right = split[2]
      .trim()
      .replace(/^["'\u201c\u2018](.+)["'\u201d\u2019]$/, '$1');
    const sameArtist = !!channel && squash(left).includes(squash(channel));
    if (!channel || LABEL_LIKE.test(raw) || sameArtist) {
      return { title: right, artist: left };
    }
  }
  text = text.replace(/^["'\u201c](.+)["'\u201d]$/, '$1');
  return { title: text, artist: channel };
}

const BOOST =
  /official\s+(?:music\s+)?video|official\s+lyrics?\s+video|official\s+audio/i;
const DEMOTE_WORDS = ['cover', 'live', 'reaction', 'karaoke', 'remix'] as const;

/** Relevance adjustment for a raw result title: + for official uploads, - for unrequested variants. */
export function relevanceScore(title: string, query: string): number {
  const q = query.toLowerCase();
  let score = BOOST.test(title) ? 1 : 0;
  for (const word of DEMOTE_WORDS) {
    const re = new RegExp(`\\b${word}\\b`, 'i');
    if (re.test(title) && !re.test(q)) score -= 1;
  }
  return score;
}

/** Stable re-ordering by `relevanceScore`; ties keep the source's order. */
export function rankByRelevance<T>(
  items: T[],
  query: string,
  titleOf: (item: T) => string,
): T[] {
  return items
    .map((item, i) => ({
      item,
      i,
      score: relevanceScore(titleOf(item), query),
    }))
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .map((x) => x.item);
}

export function thumbnailOf(info: YtDlpInfo): string | undefined {
  const url = clean(info.thumbnail) ?? clean(info.thumbnails?.at(-1)?.url);
  return url && /^https?:\/\//.test(url) ? url : undefined;
}

export function durationOf(info: YtDlpInfo): number | undefined {
  return typeof info.duration === 'number' &&
    Number.isFinite(info.duration) &&
    info.duration > 0
    ? Math.round(info.duration)
    : undefined;
}

/** Maps one yt-dlp info dict (full or flat-playlist entry) to the API shape. */
export function toSearchResult(
  info: YtDlpInfo,
  site?: string,
): SearchResult | null {
  const url =
    clean(info.webpage_url) ?? clean(info.url) ?? clean(info.original_url);
  const id = clean(info.id);
  if (!url || !id || !/^https?:\/\//.test(url)) return null;
  const track = clean(info.track);
  const metaArtist = normalizeArtist(
    clean(info.artist) ?? clean(info.artists?.[0]) ?? clean(info.creator),
  );
  let title: string;
  let artist: string;
  const resolvedSite = site ?? siteFromUrl(url);
  if (track) {
    title = track;
    artist = artistOf(info);
  } else if (resolvedSite === 'ytmusic') {
    // YouTube Music titles are already track names; a " - " there is part of the name.
    title = clean(info.title) ?? id;
    artist = artistOf(info);
  } else {
    const parsed = parseTitle(
      clean(info.title) ?? id,
      clean(info.uploader) ?? clean(info.channel),
    );
    title = parsed.title || id;
    artist = metaArtist || parsed.artist;
  }
  const result: SearchResult = {
    id,
    title,
    artist,
    url,
    site: resolvedSite,
  };
  const durationSec = durationOf(info);
  if (durationSec !== undefined) result.durationSec = durationSec;
  const thumbnailUrl = thumbnailOf(info);
  if (thumbnailUrl) result.thumbnailUrl = thumbnailUrl;
  return result;
}

/** Global cap on concurrent yt-dlp processes; replaced by `configureResolveLimits`. */
let limiter = createLimiter({
  max: 2,
  maxQueue: DEFAULT_MAX_QUEUE,
  waitMs: QUEUE_WAIT_MS,
});

/** Sets the yt-dlp concurrency cap and wait-queue length (called from buildApp). */
export function configureResolveLimits(
  max: number,
  maxQueue = DEFAULT_MAX_QUEUE,
): void {
  limiter = createLimiter({ max, maxQueue, waitMs: QUEUE_WAIT_MS });
}

/** Runs yt-dlp under the global concurrency cap (503 when the queue is full). */
export function runYtDlpJson(args: string[]): Promise<YtDlpInfo> {
  return limiter.run(() => execYtDlpJson(args));
}

function execYtDlpJson(args: string[]): Promise<YtDlpInfo> {
  return new Promise((resolve, reject) => {
    execFile(
      YTDLP_BIN,
      [...BASE_ARGS, ...args],
      {
        timeout: INFO_TIMEOUT_MS,
        killSignal: 'SIGKILL',
        maxBuffer: INFO_MAX_BUFFER,
        windowsHide: true,
      },
      (err, stdout, stderr) => {
        if (err) {
          const code = (err as NodeJS.ErrnoException).code;
          if (code === 'ENOENT')
            return reject(
              new YtDlpError('yt-dlp is not installed on the server', 500),
            );
          if ((err as { killed?: boolean }).killed)
            return reject(new YtDlpError('yt-dlp timed out', 504));
          return reject(
            new YtDlpError(lastError(String(stderr)) ?? 'yt-dlp failed'),
          );
        }
        try {
          resolve(JSON.parse(String(stdout)) as YtDlpInfo);
        } catch {
          reject(new YtDlpError('yt-dlp returned invalid output'));
        }
      },
    );
  });
}

/** Last `ERROR:` line from yt-dlp stderr, trimmed for the client. */
export function lastError(stderr: string): string | undefined {
  const line = stderr
    .split('\n')
    .reverse()
    .find((l) => l.startsWith('ERROR:'));
  return line?.replace(/^ERROR:\s*/, '').slice(0, 300) || undefined;
}

/** Searches a source; returns at most SEARCH_LIMIT results, official uploads first. */
export async function search(
  query: string,
  source: SearchSource,
): Promise<SearchResult[]> {
  const target = searchTarget(source, query);
  if (!target)
    throw new YtDlpError(
      `search is not supported for ${source}; paste a link instead`,
      400,
    );
  const info = await runYtDlpJson([
    '-J',
    '--flat-playlist',
    '--playlist-end',
    String(SEARCH_LIMIT),
    '--',
    target,
  ]);
  const site = source;
  const mapped = (info.entries ?? [])
    .filter(
      (e): e is YtDlpInfo =>
        !!e &&
        (e._type === undefined || e._type === 'url' || e._type === 'video'),
    )
    .map((e) => ({
      raw: clean(e.title) ?? '',
      result: toSearchResult(e, site),
    }))
    .filter(
      (x): x is { raw: string; result: SearchResult } => x.result !== null,
    )
    .slice(0, SEARCH_LIMIT);
  const results = rankByRelevance(mapped, query, (x) => x.raw).map(
    (x) => x.result,
  );

  await enrichMissingArtists(results);

  for (const r of results) {
    // Flat YouTube Music entries carry only id + title; the thumbnail is derivable.
    if (
      !r.thumbnailUrl &&
      (site === 'youtube' || site === 'ytmusic') &&
      /^[\w-]{11}$/.test(r.id)
    ) {
      r.thumbnailUrl = `https://i.ytimg.com/vi/${r.id}/hqdefault.jpg`;
    }
  }
  return results;
}

/** Parallel per-result metadata lookups during one search. */
const ENRICH_CONCURRENCY = 3;
/** A search stops waiting for lookups after this long and answers with what it has. */
const ENRICH_BUDGET_MS = 15_000;
const ENRICH_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const ENRICH_CACHE_MAX = 1000;
/** Only these sites are looked up again (their URLs come straight from a yt-dlp search). */
const ENRICH_SITES = new Set(['youtube', 'ytmusic', 'soundcloud']);

type TrackMeta = Pick<
  SearchResult,
  'title' | 'artist' | 'durationSec' | 'thumbnailUrl'
>;
const metaCache = new Map<string, { meta: TrackMeta; expires: number }>();

function cachedMeta(key: string): TrackMeta | undefined {
  const hit = metaCache.get(key);
  if (!hit) return undefined;
  if (hit.expires <= Date.now()) {
    metaCache.delete(key);
    return undefined;
  }
  return hit.meta;
}

function cacheMeta(key: string, meta: TrackMeta): void {
  metaCache.delete(key);
  metaCache.set(key, { meta, expires: Date.now() + ENRICH_CACHE_TTL_MS });
  while (metaCache.size > ENRICH_CACHE_MAX) {
    const oldest = metaCache.keys().next().value;
    if (oldest === undefined) break;
    metaCache.delete(oldest);
  }
}

function applyMeta(r: SearchResult, meta: TrackMeta): void {
  r.artist = meta.artist;
  if (meta.title) r.title = meta.title;
  if (r.durationSec === undefined && meta.durationSec !== undefined)
    r.durationSec = meta.durationSec;
  if (!r.thumbnailUrl && meta.thumbnailUrl) r.thumbnailUrl = meta.thumbnailUrl;
}

/**
 * Fills in results that came back without an artist (YouTube Music flat
 * search has none) with one `-J --no-playlist` lookup each, through the
 * global yt-dlp limiter, a few at a time, cached by id. Lookup failures and
 * lookups past the time budget leave the result as it was.
 */
async function enrichMissingArtists(results: SearchResult[]): Promise<void> {
  const todo: SearchResult[] = [];
  for (const r of results) {
    if (
      r.artist ||
      !ENRICH_SITES.has(siteFromUrl(r.url)) ||
      !r.url.startsWith('https://')
    )
      continue;
    const meta = cachedMeta(`${r.site}:${r.id}`);
    if (meta) applyMeta(r, meta);
    else todo.push(r);
  }
  if (!todo.length) return;

  let next = 0;
  let expired = false;
  const worker = async (): Promise<void> => {
    while (!expired && next < todo.length) {
      const r = todo[next++];
      try {
        const info = await runYtDlpJson(['-J', '--no-playlist', '--', r.url]);
        const full = toSearchResult(
          {
            ...info,
            id: clean(info.id) ?? r.id,
            webpage_url: clean(info.webpage_url) ?? r.url,
          },
          r.site,
        );
        if (!full?.artist) continue;
        const meta: TrackMeta = { title: full.title, artist: full.artist };
        if (full.durationSec !== undefined) meta.durationSec = full.durationSec;
        if (full.thumbnailUrl) meta.thumbnailUrl = full.thumbnailUrl;
        cacheMeta(`${r.site}:${r.id}`, meta);
        if (!expired) applyMeta(r, meta);
      } catch {
        // Keep the flat result; a failed lookup never fails the search.
      }
    }
  };

  let timer: ReturnType<typeof setTimeout> | undefined;
  const budget = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ENRICH_BUDGET_MS);
    timer.unref?.();
  });
  const workers = Array.from(
    { length: Math.min(ENRICH_CONCURRENCY, todo.length) },
    worker,
  );
  await Promise.race([Promise.all(workers), budget]);
  clearTimeout(timer);
  expired = true;
}

/** Metadata for one already-validated URL (no download). */
export async function resolveUrl(url: string): Promise<SearchResult> {
  const info = await runYtDlpJson(['-J', '--no-playlist', '--', url]);
  if (info._type === 'playlist')
    throw new YtDlpError(
      'playlists are not supported; use a single track link',
      400,
    );
  const result = toSearchResult(
    info,
    siteFromUrl(clean(info.webpage_url) ?? url),
  );
  if (!result) throw new YtDlpError('yt-dlp returned no usable metadata');
  return result;
}

/** A link for the phone to play directly from the source CDN. */
export interface StreamResponse {
  url: string;
  mimeType?: string;
  /** ISO time after which the link stops working (from the URL's `expire` parameter). */
  expiresAt?: string;
  /** Only the headers the native player may need (User-Agent, Referer, Origin). */
  httpHeaders?: Record<string, string>;
  track: {
    title: string;
    artist: string;
    album?: string;
    durationSec?: number;
    thumbnailUrl?: string;
  };
}

const STREAM_HEADERS = ['user-agent', 'referer', 'origin'] as const;
const MIME_BY_EXT: Record<string, string> = {
  m4a: 'audio/mp4',
  mp4: 'audio/mp4',
  aac: 'audio/aac',
  mp3: 'audio/mpeg',
  opus: 'audio/ogg',
  ogg: 'audio/ogg',
  webm: 'audio/webm',
  flac: 'audio/flac',
  wav: 'audio/wav',
};

/** `expire` query parameter of a media URL (unix seconds) as ISO, when present and valid. */
export function expiresAtOf(mediaUrl: string): string | undefined {
  const raw = new URL(mediaUrl).searchParams.get('expire');
  if (!raw || !/^\d{9,11}$/.test(raw)) return undefined;
  return new Date(Number(raw) * 1000).toISOString();
}

/**
 * Maps the yt-dlp info dict for a single `STREAM_FORMAT` selection to the
 * stream response. Pure: no I/O. Segmented (HLS/DASH) or non-HTTP formats
 * are refused with 422 because the phone's native player cannot take them here.
 */
export function toStreamResponse(info: YtDlpInfo): StreamResponse {
  if (info._type === 'playlist') {
    throw new YtDlpError(
      'playlists are not supported; use a single track link',
      400,
    );
  }
  const mediaUrl = clean(info.url);
  if (!mediaUrl || !/^https?:\/\//.test(mediaUrl)) {
    throw new YtDlpError('no direct audio link for this page', 422);
  }
  if (
    !/^https?$/.test(info.protocol ?? '') ||
    /\.m3u8?(\?|$)/i.test(mediaUrl)
  ) {
    throw new YtDlpError(
      'this source only offers segmented streams, which are not supported',
      422,
    );
  }

  const response: StreamResponse = {
    url: mediaUrl,
    track: {
      title: clean(info.track) ?? clean(info.title) ?? 'Untitled',
      artist: artistOf(info),
    },
  };
  const ext = clean(info.ext)?.toLowerCase();
  if (ext && MIME_BY_EXT[ext]) response.mimeType = MIME_BY_EXT[ext];
  try {
    const expiresAt = expiresAtOf(mediaUrl);
    if (expiresAt) response.expiresAt = expiresAt;
  } catch {
    // Unparseable media URL: no expiry known.
  }

  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(info.http_headers ?? {})) {
    if (
      (STREAM_HEADERS as readonly string[]).includes(name.toLowerCase()) &&
      typeof value === 'string'
    ) {
      headers[name] = value;
    }
  }
  if (Object.keys(headers).length) response.httpHeaders = headers;

  const album = clean(info.album);
  if (album) response.track.album = album;
  const durationSec = durationOf(info);
  if (durationSec !== undefined) response.track.durationSec = durationSec;
  const thumbnailUrl = thumbnailOf(info);
  if (thumbnailUrl) response.track.thumbnailUrl = thumbnailUrl;
  return response;
}

/** Resolves a validated page URL to a direct, playable audio link (nothing is downloaded). */
export async function resolveStream(
  url: string,
  quality: AudioQuality = 'highest',
): Promise<StreamResponse> {
  const info = await runYtDlpJson([
    '-J',
    '--no-playlist',
    '-f',
    streamFormatFor(quality),
    '--',
    url,
  ]);
  return toStreamResponse(info);
}
