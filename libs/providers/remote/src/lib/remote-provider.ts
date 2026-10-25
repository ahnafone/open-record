import type { DownloadJob, DownloadSite, PlayableSource, RemoteSearchResult, Track, TrackSource } from '@open-record/models';
import { RemoteClient, type RemoteConfig } from './client';
import { createDefaultDownloadTarget, type DownloadedFile, type DownloadTarget } from './download-target';
import { AbortedError, RemoteConfigError, RemoteError } from './errors';
import { createDefaultTransport, type HttpTransport } from './transport';

/** Provider id; remote (not yet downloaded) track ids are `remote:<encoded page url>`. */
export const REMOTE_PROVIDER_ID = 'remote';

const ID_PREFIX = `${REMOTE_PROVIDER_ID}:`;

/** Track id for a remote item. Self-contained so `download(trackId)` needs no cache. */
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

/** Pure mapping of a server search result to a (not yet playable) Track. */
export function toRemoteTrack(result: RemoteSearchResult): Track {
  const source: TrackSource = { site: result.site, url: result.url };
  if (result.id && result.id !== result.url) source.id = result.id;
  const track: Track = {
    id: remoteTrackId(result.url),
    providerId: REMOTE_PROVIDER_ID,
    title: result.title,
    artist: result.artist || 'Unknown artist',
    source,
  };
  if (result.durationSec) track.durationSec = Math.round(result.durationSec);
  if (result.thumbnailUrl) track.artUrl = result.thumbnailUrl;
  return track;
}

/**
 * Hands a finished file to the local import pipeline and returns the new
 * `local:` track (not yet persisted). The app wires this to
 * `LocalProvider.importDownloaded`.
 */
export type DownloadImporter = (
  file: DownloadedFile,
  extras: { source: TrackSource; fallback: Partial<Pick<Track, 'title' | 'artist' | 'album' | 'year' | 'genre' | 'durationSec'>> },
) => Promise<Track>;

export type DownloadPhase = 'starting' | DownloadJob['status'] | 'saving';

export interface DownloadProgress {
  phase: DownloadPhase;
  /** 0-100 server progress; 100 while saving. */
  progress: number;
  jobId?: string;
}

export interface DownloadToLibraryOptions {
  signal?: AbortSignal;
  onProgress?(progress: DownloadProgress): void;
}

export interface RemoteProviderOptions {
  /** Server URL + token; can be set later with `configure`. */
  config?: RemoteConfig | null;
  /** Default: CapacitorHttp on native, fetch on web. */
  transport?: HttpTransport;
  /** Default: Filesystem.downloadFile on native, Blob on web. */
  target?: DownloadTarget;
  /** Required for `downloadToLibrary`. */
  importer?: DownloadImporter;
  /** Site used by the generic `search(query)` (default `youtube`). */
  defaultSite?: DownloadSite;
  /** Job poll interval in ms (default 1000). */
  pollIntervalMs?: number;
}

/**
 * Search and download through the self-hosted download server. Satisfies
 * MusicSourceProvider from @open-record/music-source structurally (providers
 * may only import @open-record/models).
 *
 * Remote tracks are search results, not playable: `resolve` rejects. Use
 * `downloadToLibrary` to fetch one; the result is a normal `local:` track
 * (with `source` set) for the state layer to persist.
 */
export class RemoteProvider {
  readonly id = REMOTE_PROVIDER_ID;
  readonly capabilities = { search: true, download: true } as const;

  private _client: RemoteClient | null = null;
  private readonly transport: HttpTransport;
  private readonly target: DownloadTarget;

  constructor(private readonly options: RemoteProviderOptions = {}) {
    this.transport = options.transport ?? createDefaultTransport();
    this.target = options.target ?? createDefaultDownloadTarget();
    if (options.config) this.configure(options.config);
  }

  /** Set or clear the server. Throws `RemoteConfigError` for a bad URL. */
  configure(config: RemoteConfig | null): void {
    this._client = config?.baseUrl.trim() ? new RemoteClient(config, this.transport) : null;
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

  /** MusicSourceProvider search on the default site. Empty when no server is configured. */
  async search(query: string): Promise<Track[]> {
    if (!this._client) return [];
    return this.searchSite(query, this.options.defaultSite ?? 'youtube');
  }

  async searchSite(query: string, site: DownloadSite, signal?: AbortSignal): Promise<Track[]> {
    return (await this.client.search(query, site, signal)).map(toRemoteTrack);
  }

  /** A pasted link as a Track (server `POST /resolve`). */
  async resolveUrl(url: string, signal?: AbortSignal): Promise<Track> {
    return toRemoteTrack(await this.client.resolve(url, signal));
  }

  async resolve(trackId: string): Promise<PlayableSource> {
    throw new RemoteError(`"${trackId}" has not been downloaded yet.`);
  }

  /**
   * Run a server download job and import the file locally. Accepts a remote
   * Track (from `searchSite` / `resolveUrl`) or a page URL. Resolves to the new
   * `local:` track; the caller persists it.
   */
  async downloadToLibrary(trackOrUrl: Track | string, opts: DownloadToLibraryOptions = {}): Promise<Track> {
    const importer = this.options.importer;
    if (!importer) throw new RemoteConfigError('Downloads are not wired to the library.');
    const client = this.client;
    const url = typeof trackOrUrl === 'string' ? trackOrUrl : (trackOrUrl.source?.url ?? urlFromRemoteTrackId(trackOrUrl.id));
    if (!url) throw new RemoteError('This track has no download link.');
    const hint = typeof trackOrUrl === 'string' ? undefined : trackOrUrl;
    const { signal, onProgress } = opts;

    onProgress?.({ phase: 'starting', progress: 0 });
    const { id: jobId } = await client.startDownload(url, signal);
    const job = await client.waitForDownload(jobId, {
      signal,
      intervalMs: this.options.pollIntervalMs,
      onUpdate: (j) => onProgress?.({ phase: j.status, progress: j.progress, jobId }),
    });
    onProgress?.({ phase: 'saving', progress: 100, jobId });

    const meta = job.track;
    const title = meta?.title ?? hint?.title;
    const artist = meta?.artist || hint?.artist;
    const info = await client.fileInfo(jobId, signal);
    const file = await this.target.fetch({
      ...client.fileRequest(jobId),
      baseName: [artist, title].filter(Boolean).join(' - ') || 'download',
      fileName: info.fileName,
      mimeType: info.mimeType,
      signal,
    });
    try {
      if (signal?.aborted) throw new AbortedError();
      const source: TrackSource = hint?.source ? { ...hint.source } : { site: 'web', url };
      const fallback: Parameters<DownloadImporter>[1]['fallback'] = {};
      if (title) fallback.title = title;
      if (artist) fallback.artist = artist;
      if (meta?.album) fallback.album = meta.album;
      if (meta?.year) fallback.year = meta.year;
      if (meta?.genre) fallback.genre = meta.genre;
      const duration = meta?.durationSec ?? hint?.durationSec;
      if (duration) fallback.durationSec = Math.round(duration);
      return await importer(file, { source, fallback });
    } finally {
      await this.target.release(file).catch(() => undefined);
    }
  }

  /**
   * MusicSourceProvider download: streams the finished server file into
   * `sink` (fetch-based; web and tests). The app should prefer
   * `downloadToLibrary`, which also imports the file.
   */
  async download(
    trackId: string,
    sink: {
      start?(info: { mimeType?: string; sizeBytes?: number }): void | Promise<void>;
      write(chunk: Uint8Array): Promise<void>;
      close(): Promise<void>;
      abort(reason?: unknown): Promise<void>;
    },
  ): Promise<void> {
    const url = urlFromRemoteTrackId(trackId);
    if (!url) throw new RemoteError(`"${trackId}" is not a remote track.`);
    const client = this.client;
    try {
      const { id } = await client.startDownload(url);
      await client.waitForDownload(id, { intervalMs: this.options.pollIntervalMs });
      const { url: fileUrl, headers } = client.fileRequest(id);
      const res = await fetch(fileUrl, { headers });
      if (!res.ok || !res.body) throw new RemoteError(`Could not fetch the downloaded file (HTTP ${res.status}).`);
      const size = Number(res.headers.get('content-length'));
      await sink.start?.({
        mimeType: res.headers.get('content-type') ?? undefined,
        sizeBytes: Number.isFinite(size) && size > 0 ? size : undefined,
      });
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        await sink.write(value);
      }
      await sink.close();
    } catch (err) {
      await sink.abort(err).catch(() => undefined);
      throw err;
    }
  }
}
