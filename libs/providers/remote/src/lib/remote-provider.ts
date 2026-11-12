import type {
  AudioQuality,
  DownloadSite,
  EnrichMatch,
  EnrichQuery,
  PlayableSource,
  RemotePlaylist,
  RemotePlaylistEntry,
  RemoteSearchResult,
  Track,
  TrackSource,
} from '@open-record/models';
import { RemoteClient, type RemoteAuthOptions, type RemoteConfig, type TrackAliasQuery, type TrackAliases } from './client';
import { createLinkCache } from './link-cache';
import {
  GuestHostError,
  HttpError,
  NetworkError,
  ProtocolError,
  RemoteConfigError,
  RemoteError,
} from './errors';
import { RemoteStreamResolver, type SaveBlob, type StreamLink } from './stream-resolver';
import { createDefaultTransport, type HttpTransport } from './transport';

/** Provider id; remote track ids are `remote:<encoded page url>`. */
export const REMOTE_PROVIDER_ID = 'remote';

const ID_PREFIX = `${REMOTE_PROVIDER_ID}:`;

const MIME_BY_EXT: Record<string, string> = {
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  ogg: 'audio/ogg',
  opus: 'audio/opus',
  webm: 'audio/webm',
  flac: 'audio/flac',
  wav: 'audio/wav',
};

/** Best-effort MIME type from a file URL or path (query and hash ignored). */
function mimeFromPath(path: string): string | undefined {
  const clean = path.split(/[?#]/)[0] ?? path;
  const ext = clean.slice(clean.lastIndexOf('.') + 1).toLowerCase();
  return MIME_BY_EXT[ext];
}

/** Track id for a remote item. Self-contained so no cache is needed to resolve it. */
export function remoteTrackId(url: string): string {
  return ID_PREFIX + encodeURIComponent(url);
}

/** Page URL from a remote track id, or `null` if it is not one. */
export function urlFromRemoteTrackId(trackId: string): string | null {
  if (!trackId.startsWith(ID_PREFIX)) return null;
  try {
    return decodeURIComponent(trackId.slice(ID_PREFIX.length)) || null;
  } catch {
    return null;
  }
}

/** Artist shown when neither the server nor a metadata lookup knows it. */
export const UNKNOWN_ARTIST = 'Unknown artist';

/**
 * Longest a single `withArtist` call waits for its artist, counted from the
 * call (time queued behind other lookups included). Past it the track shows
 * "Unknown artist" for now; the lookup keeps running and caches its answer.
 */
const ARTIST_LOOKUP_TIMEOUT_MS = 4000;
/** Artist lookups in flight at once (iTunes/Deezer are rate limited). */
const ARTIST_LOOKUP_CONCURRENCY = 2;

/** YT Music results needed before search skips the plain-YouTube fallback. */
const MIN_MUSIC_RESULTS = 3;
/** Longest a fallback (plain YouTube) hit may run; longer ones are mixes, sets or albums. */
const MUSIC_FALLBACK_MAX_SEC = 600;
/**
 * Titles of full albums, concerts, live sets, reactions, podcasts, compilations
 * and long mixes (case-insensitive). Bare words like "Reaction", "Chain Reaction"
 * or "24 Hours" are songs, so they only match with their usual context.
 */
const NON_MUSIC_TITLE = new RegExp(
  [
    String.raw`\bfull\s+(album|concert|set|show|mixtape|playlist)\b`,
    String.raw`\blive\s+(set|concert)s?\b`,
    String.raw`\bpodcast`,
    String.raw`\bcompilation\b`,
    String.raw`\breacts?\s+to\b`,
    String.raw`\breaction\s+(to|video)\b`,
    String.raw`[([]\s*reaction\s*[)\]]`,
    // Long "N hours" only with mix-style context somewhere in the title: "1 hour mix", "10 Hours of Rain Ambience"
    String.raw`^(?=.*\b(mix|mixes|playlist|music|loop|ambien\w*|relax\w*|sleep)\b).*\b\d+\s*hours?\b`,
  ].join('|'),
  'i',
);

/**
 * Whether a plain-YouTube fallback hit looks like a song: not over 10 minutes
 * (unknown duration passes) and no full-album/concert/live-set/reaction/podcast/
 * compilation/long-mix wording in the title.
 */
export function isMusicFallback(track: Track): boolean {
  if (track.durationSec !== undefined && track.durationSec > MUSIC_FALLBACK_MAX_SEC) return false;
  return !NON_MUSIC_TITLE.test(track.title);
}

/** Whether a failed YT Music search should fall back to plain YouTube (server or network trouble, not auth/quota/busy/abort). */
function isFallbackError(err: unknown): boolean {
  return err instanceof HttpError || err instanceof ProtocolError || err instanceof NetworkError || err instanceof GuestHostError;
}

const YOUTUBE_VIDEO_ID = /^[\w-]{11}$/;

/** YouTube video id from a youtube.com / music.youtube.com / youtu.be page URL, or `undefined`. */
function youtubeVideoId(url: string | undefined): string | undefined {
  if (!url) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  const host = parsed.hostname.replace(/^(www|m|music)\./, '');
  const id =
    host === 'youtube.com'
      ? parsed.searchParams.get('v')
      : host === 'youtu.be'
        ? (parsed.pathname.split('/')[1] ?? null)
        : null;
  return id && YOUTUBE_VIDEO_ID.test(id) ? id : undefined;
}

/** Dedup key: the YouTube video id (same video on YT Music and YouTube), else the track id. */
function canonicalKey(track: Track): string {
  const videoId = youtubeVideoId(track.source?.url);
  return videoId ? `yt:${videoId}` : track.id;
}

/** Runs at most `max` tasks at once; the rest wait in FIFO order. */
function createLimiter(max: number): <T>(task: () => Promise<T>) => Promise<T> {
  let active = 0;
  const queue: (() => void)[] = [];
  const pump = () => {
    while (active < max && queue.length) queue.shift()?.();
  };
  return <T>(task: () => Promise<T>) =>
    new Promise<T>((resolve, reject) => {
      queue.push(() => {
        active++;
        Promise.resolve()
          .then(task)
          .then(resolve, reject)
          .finally(() => {
            active--;
            pump();
          });
      });
      pump();
    });
}

/**
 * Artist for a track the server returned without one (e.g. via an iTunes/Deezer
 * search on the title). Resolves `undefined` when there is no confident match.
 */
export type ArtistLookup = (query: { title: string; durationSec?: number }) => Promise<string | undefined>;

/** Pure mapping of a server search result to a (not yet playable) Track. */
export function toRemoteTrack(result: RemoteSearchResult): Track {
  const source: TrackSource = { site: result.site, url: result.url };
  if (result.id && result.id !== result.url) source.id = result.id;
  const track: Track = {
    id: remoteTrackId(result.url),
    providerId: REMOTE_PROVIDER_ID,
    title: result.title,
    artist: result.artist || UNKNOWN_ARTIST,
    source,
  };
  if (result.durationSec) track.durationSec = Math.round(result.durationSec);
  if (result.thumbnailUrl) track.artUrl = result.thumbnailUrl;
  return track;
}

/** A playlist entry as a remote Track, keeping the title/uploader YouTube showed. */
export function playlistEntryToTrack(entry: RemotePlaylistEntry): Track {
  const track = toRemoteTrack({
    id: entry.id,
    title: entry.title,
    artist: entry.artist,
    url: entry.url,
    site: entry.site,
    durationSec: entry.durationSec,
    thumbnailUrl: entry.thumbnailUrl,
  });
  if (track.source) {
    track.source.originalTitle = entry.originalTitle;
    if (entry.uploader) track.source.originalArtist = entry.uploader;
  }
  if (entry.album) track.album = entry.album;
  return track;
}

/** A fetched public playlist with its entries as Tracks. */
export interface ImportedPlaylist {
  title: string;
  url: string;
  site: string;
  tracks: Track[];
  unavailable: number;
  truncated: boolean;
  /** A single song link (one track, no playlist). */
  single: boolean;
}

export interface RemoteProviderOptions extends RemoteAuthOptions {
  /** Server URL (+ optional static token); can be set later with `configure`. */
  config?: RemoteConfig | null;
  /** Default: CapacitorHttp on native, fetch on web. */
  transport?: HttpTransport;
  /** Site used by the generic `search(query)` (default `youtube`). */
  defaultSite?: DownloadSite;
  /**
   * Playable URL of a saved copy of `trackId`, or `undefined` when not saved.
   * The app supplies it from the library's stored file path.
   */
  lookupSavedFile?(trackId: string): Promise<string | undefined>;
  /** Web only: stores a saved blob for `saveToDevice`. */
  saveBlob?: SaveBlob;
  /** Clock for link expiry (default `Date.now`). */
  now?: () => number;
  /** Streaming quality, read on every resolve (default: server default, highest). */
  streamQuality?: () => AudioQuality | undefined;
  /** Fills in a missing artist (the app wires the iTunes/Deezer lookup). */
  lookupArtist?: ArtistLookup;
}

/**
 * Search and stream through the self-hosted server. Satisfies
 * MusicSourceProvider from @open-record/music-source structurally (providers
 * may only import @open-record/models).
 *
 * Playback: `resolve` returns the saved local file when one exists, otherwise a
 * short-lived stream link from the server (cached until shortly before it
 * expires). Saving to the device is done by `streams.saveToDevice`. Search is
 * not a library source, so `capabilities.search` is false.
 */
export class RemoteProvider {
  readonly id = REMOTE_PROVIDER_ID;
  readonly capabilities = { search: false, download: false } as const;

  /** Stream links and device saves (`POST /stream`). */
  readonly streams: RemoteStreamResolver;

  private _client: RemoteClient | null = null;
  private readonly transport: HttpTransport;
  /** Keyed by `<quality>|<trackId>` so a quality change never reuses an old link. */
  private readonly links: (key: string, signal?: AbortSignal) => Promise<StreamLink>;
  /** Looked-up artists per track id (`undefined` = no confident match). */
  private readonly artists = new Map<string, Promise<string | undefined>>();
  private readonly limitArtistLookup = createLimiter(ARTIST_LOOKUP_CONCURRENCY);

  constructor(private readonly options: RemoteProviderOptions = {}) {
    this.transport = options.transport ?? createDefaultTransport();
    this.streams = new RemoteStreamResolver({ client: () => this.client, saveBlob: options.saveBlob });
    this.links = createLinkCache(
      async (key) => {
        const at = key.indexOf('|');
        const quality = key.slice(0, at) as AudioQuality | '';
        const trackId = key.slice(at + 1);
        const url = urlFromRemoteTrackId(trackId);
        if (!url) throw new RemoteError(`"${trackId}" is not a remote track.`);
        return this.streams.resolve(url, undefined, quality || undefined);
      },
      { now: options.now },
    );
    if (options.config) this.configure(options.config);
  }

  /** Set or clear the server. Throws `RemoteConfigError` for a bad URL. */
  configure(config: RemoteConfig | null): void {
    this._client = config?.baseUrl.trim()
      ? new RemoteClient(config, this.transport, {
          accessToken: this.options.accessToken,
          onUnauthorized: this.options.onUnauthorized,
          guestStreaming: this.options.guestStreaming,
          signedIn: this.options.signedIn,
          onGuestRejected: this.options.onGuestRejected,
        })
      : null;
  }

  get configured(): boolean {
    return this._client !== null;
  }

  /** The configured client; throws `RemoteConfigError` when none is set. */
  get client(): RemoteClient {
    if (!this._client) throw new RemoteConfigError('No download server is set up.');
    return this._client;
  }

  /** Reachable and token accepted; rejects with `AuthError`, `NetworkError`, ... */
  testConnection(signal?: AbortSignal): Promise<void> {
    return this.client.testConnection(signal);
  }

  /** Reachable without a token (`/health` + `/app-config`); for signed-out pairing. */
  probeServer(signal?: AbortSignal): Promise<void> {
    return this.client.probeServer(signal);
  }

  /**
   * MusicSourceProvider search, music-first: YouTube Music's Songs shelf. Only
   * when that yields fewer than `MIN_MUSIC_RESULTS` (or fails with a server or
   * network error) does it also query plain YouTube; those extra hits pass
   * `isMusicFallback` and are deduped by video id. Auth, guest-limit and busy
   * errors are rethrown. Empty when no server is configured.
   */
  async search(query: string, signal?: AbortSignal): Promise<Track[]> {
    if (!this._client) return [];
    const primary = this.options.defaultSite ?? 'ytmusic';
    if (primary !== 'ytmusic') return this.searchSite(query, primary, signal);

    let music: Track[] = [];
    let musicError: unknown;
    try {
      music = await this.searchSite(query, 'ytmusic', signal);
    } catch (err) {
      // Auth, guest limit, busy and abort errors are not for a fallback to hide.
      if (signal?.aborted || !isFallbackError(err)) throw err;
      musicError = err;
    }
    signal?.throwIfAborted();
    if (music.length >= MIN_MUSIC_RESULTS) return music;

    const seen = new Set(music.map(canonicalKey));
    let fallback: Track[];
    try {
      fallback = await this.searchTracks(query, 'youtube', signal, (t) => isMusicFallback(t) && !seen.has(canonicalKey(t)));
    } catch (err) {
      // Keep whatever YT Music found; surface the error only when there is nothing.
      if (signal?.aborted || !isFallbackError(err)) throw err;
      if (music.length) return music;
      throw musicError ?? err;
    }
    signal?.throwIfAborted();
    return [...music, ...fallback];
  }

  async searchSite(query: string, site: DownloadSite, signal?: AbortSignal): Promise<Track[]> {
    return this.searchTracks(query, site, signal);
  }

  /** Server search mapped to Tracks; `keep` drops hits before any artist lookup runs on them. */
  private async searchTracks(
    query: string,
    site: DownloadSite,
    signal?: AbortSignal,
    keep?: (track: Track) => boolean,
  ): Promise<Track[]> {
    const results = await this.client.search(query, site, signal);
    const hits = keep ? results.filter((r) => keep(toRemoteTrack(r))) : results;
    return Promise.all(hits.map((r) => this.withArtist(r)));
  }

  /**
   * Alternative titles/artist names from the server's catalogue lookup. Never
   * rejects: no server, a network/auth error or a bad response give empty lists.
   */
  async aliases(query: TrackAliasQuery, signal?: AbortSignal): Promise<TrackAliases> {
    if (!this._client) return { titles: [], artists: [] };
    try {
      return await this._client.aliases(query, signal);
    } catch {
      return { titles: [], artists: [] };
    }
  }

  /** A public YouTube / YT Music playlist (or one song) as Tracks (server `POST /playlist`). Rejects like `resolveUrl`. */
  async importPlaylist(url: string, signal?: AbortSignal): Promise<ImportedPlaylist> {
    const list: RemotePlaylist = await this.client.playlist(url, signal);
    return {
      title: list.title,
      url: list.url,
      site: list.site,
      tracks: list.entries.map(playlistEntryToTrack),
      unavailable: list.unavailable,
      truncated: list.truncated,
      single: list.single === true,
    };
  }

  /** Catalogue matches for up to 10 songs (server `POST /meta/enrich`). Rejects on errors so callers can pause. */
  async enrich(items: EnrichQuery[], signal?: AbortSignal): Promise<(EnrichMatch | null)[]> {
    return this.client.enrich(items, signal);
  }

  /** A pasted link as a Track (server `POST /resolve`). */
  async resolveUrl(url: string, signal?: AbortSignal): Promise<Track> {
    return this.withArtist(await this.client.resolve(url, signal));
  }

  /**
   * Maps a result, filling a missing artist from `lookupArtist` (cached per
   * track id). Any failure or timeout falls back to "Unknown artist".
   */
  private async withArtist(result: RemoteSearchResult): Promise<Track> {
    const track = toRemoteTrack(result);
    const lookup = this.options.lookupArtist;
    if (result.artist || !lookup || !track.title) return track;
    // One deadline for this call, queue time included. A lookup that misses it
    // keeps running and fills the cache for a later search.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), ARTIST_LOOKUP_TIMEOUT_MS);
    });
    try {
      const pending = this.artists.get(track.id) ?? this.startArtistLookup(track, lookup);
      const artist = await Promise.race([pending, deadline]);
      return artist ? { ...track, artist } : track;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Queues the lookup and caches it per track id. A failure removes the entry so a later search retries. */
  private startArtistLookup(track: Track, lookup: ArtistLookup): Promise<string | undefined> {
    const pending: Promise<string | undefined> = this.limitArtistLookup(() =>
      lookup({ title: track.title, durationSec: track.durationSec }),
    )
      .then((a) => a?.trim() || undefined)
      .catch(() => {
        if (this.artists.get(track.id) === pending) this.artists.delete(track.id);
        return undefined;
      });
    this.artists.set(track.id, pending);
    return pending;
  }

  /**
   * Playable source for a remote track: the saved local file if there is one
   * (no server call). Undefined when not saved or when the lookup fails.
   */
  async resolveSaved(trackId: string): Promise<PlayableSource | undefined> {
    const lookup = this.options.lookupSavedFile;
    if (!lookup) return undefined;
    try {
      const url = await lookup(trackId);
      if (!url) return undefined;
      const mimeType = mimeFromPath(url);
      return mimeType ? { url, kind: 'file', mimeType } : { url, kind: 'file' };
    } catch {
      return undefined;
    }
  }

  async resolve(trackId: string, signal?: AbortSignal): Promise<PlayableSource> {
    const saved = await this.resolveSaved(trackId);
    if (saved) return saved;
    const quality = this.options.streamQuality?.() ?? '';
    const link = await this.links(`${quality}|${trackId}`, signal);
    return link.mimeType ? { url: link.url, kind: 'remote', mimeType: link.mimeType } : { url: link.url, kind: 'remote' };
  }
}
