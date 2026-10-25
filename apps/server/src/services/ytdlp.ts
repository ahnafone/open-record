import { execFile } from 'node:child_process';

/** yt-dlp binary; override with YTDLP_PATH. */
export const YTDLP_BIN = process.env['YTDLP_PATH']?.trim() || 'yt-dlp';

/** Arguments every yt-dlp call gets: no user config files, JS challenges solved with Node. */
export const BASE_ARGS = ['--ignore-config', '--no-colors', '--js-runtimes', 'node'];

export const SEARCH_LIMIT = 15;
export const MAX_QUERY_LENGTH = 200;
const INFO_TIMEOUT_MS = 45_000;
const INFO_MAX_BUFFER = 32 * 1024 * 1024;

export const SEARCH_SOURCES = ['youtube', 'ytmusic', 'soundcloud', 'bandcamp', 'audiomack', 'mixcloud'] as const;
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
export function searchTarget(source: SearchSource, query: string): string | null {
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
  if (host === 'youtube.com' || host === 'youtu.be' || host.endsWith('.youtube.com')) return 'youtube';
  for (const site of ['soundcloud', 'bandcamp', 'audiomack', 'mixcloud']) {
    if (host === `${site}.com` || host.endsWith(`.${site}.com`)) return site;
  }
  return host;
}

const clean = (s: unknown): string | undefined => (typeof s === 'string' && s.trim() ? s.trim() : undefined);

/** Best artist guess; drops YouTube's auto-generated " - Topic" channel suffix. */
export function artistOf(info: YtDlpInfo): string {
  const raw =
    clean(info.artist) ?? clean(info.artists?.[0]) ?? clean(info.creator) ?? clean(info.uploader) ?? clean(info.channel);
  return raw?.replace(/\s+-\s+Topic$/, '') ?? '';
}

export function thumbnailOf(info: YtDlpInfo): string | undefined {
  const url = clean(info.thumbnail) ?? clean(info.thumbnails?.at(-1)?.url);
  return url && /^https?:\/\//.test(url) ? url : undefined;
}

export function durationOf(info: YtDlpInfo): number | undefined {
  return typeof info.duration === 'number' && Number.isFinite(info.duration) && info.duration > 0
    ? Math.round(info.duration)
    : undefined;
}

/** Maps one yt-dlp info dict (full or flat-playlist entry) to the API shape. */
export function toSearchResult(info: YtDlpInfo, site?: string): SearchResult | null {
  const url = clean(info.webpage_url) ?? clean(info.url) ?? clean(info.original_url);
  const id = clean(info.id);
  if (!url || !id || !/^https?:\/\//.test(url)) return null;
  const result: SearchResult = {
    id,
    title: clean(info.track) ?? clean(info.title) ?? id,
    artist: artistOf(info),
    url,
    site: site ?? siteFromUrl(url),
  };
  const durationSec = durationOf(info);
  if (durationSec !== undefined) result.durationSec = durationSec;
  const thumbnailUrl = thumbnailOf(info);
  if (thumbnailUrl) result.thumbnailUrl = thumbnailUrl;
  return result;
}

/** Runs yt-dlp (argument array, never a shell) and parses its single JSON document. */
export function runYtDlpJson(args: string[]): Promise<YtDlpInfo> {
  return new Promise((resolve, reject) => {
    execFile(
      YTDLP_BIN,
      [...BASE_ARGS, ...args],
      { timeout: INFO_TIMEOUT_MS, killSignal: 'SIGKILL', maxBuffer: INFO_MAX_BUFFER, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) {
          const code = (err as NodeJS.ErrnoException).code;
          if (code === 'ENOENT') return reject(new YtDlpError('yt-dlp is not installed on the server', 500));
          if ((err as { killed?: boolean }).killed) return reject(new YtDlpError('yt-dlp timed out', 504));
          return reject(new YtDlpError(lastError(String(stderr)) ?? 'yt-dlp failed'));
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

/** Searches a source; returns at most SEARCH_LIMIT results. */
export async function search(query: string, source: SearchSource): Promise<SearchResult[]> {
  const target = searchTarget(source, query);
  if (!target) throw new YtDlpError(`search is not supported for ${source}; paste a link instead`, 400);
  const info = await runYtDlpJson([
    '-J',
    '--flat-playlist',
    '--playlist-end',
    String(SEARCH_LIMIT),
    '--',
    target,
  ]);
  const site = source;
  return (info.entries ?? [])
    .filter((e): e is YtDlpInfo => !!e && (e._type === undefined || e._type === 'url' || e._type === 'video'))
    .map((e) => toSearchResult(e, site))
    .filter((r): r is SearchResult => r !== null)
    .map((r) => {
      // Flat YouTube Music entries carry only id + title; the thumbnail is derivable.
      if (!r.thumbnailUrl && (site === 'youtube' || site === 'ytmusic') && /^[\w-]{11}$/.test(r.id)) {
        r.thumbnailUrl = `https://i.ytimg.com/vi/${r.id}/hqdefault.jpg`;
      }
      return r;
    })
    .slice(0, SEARCH_LIMIT);
}

/** Metadata for one already-validated URL (no download). */
export async function resolveUrl(url: string): Promise<SearchResult> {
  const info = await runYtDlpJson(['-J', '--no-playlist', '--', url]);
  if (info._type === 'playlist') throw new YtDlpError('playlists are not supported; use a single track link', 400);
  const result = toSearchResult(info, siteFromUrl(clean(info.webpage_url) ?? url));
  if (!result) throw new YtDlpError('yt-dlp returned no usable metadata');
  return result;
}
