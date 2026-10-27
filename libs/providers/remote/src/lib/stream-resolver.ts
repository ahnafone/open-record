import { Capacitor, CapacitorHttp, type PluginListenerHandle } from '@capacitor/core';
import { Directory, Filesystem } from '@capacitor/filesystem';
import { withDownloadLocation, type AudioQuality, type DownloadLocation } from '@open-record/models';
import type { RemoteClient } from './client';
import { AbortedError, HttpError, NetworkError, RemoteConfigError } from './errors';

/** Folder (in the app data directory) that holds saved audio; same as the local provider's. */
export const SAVED_DIR = 'imported';

export interface StreamMeta {
  title: string;
  artist: string;
  album?: string;
  durationSec?: number;
  artworkUrl?: string;
}

export interface StreamLink {
  url: string;
  mimeType?: string;
  /** Epoch milliseconds after which `url` stops working. */
  expiresAt?: number;
  /** Headers the link needs (User-Agent, Referer, Origin); web and native may not be able to send them. */
  headers?: Record<string, string>;
  meta?: StreamMeta;
}

export interface SaveToDeviceOptions {
  /** Track id; the stored file name is derived from it. */
  id: string;
  /** Fraction 0..1. */
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
  /** Download quality; omitted = server default (highest). */
  quality?: AudioQuality;
  /** Native only: where the file is written; omitted = app data. Web ignores it. */
  location?: DownloadLocation;
}

export interface SavedFile {
  /**
   * Store-relative path (`imported/<key>.audio.<ext>`), the form stored as a
   * track's file path; prefixed `external:` when written to external storage.
   */
  sourceFile: string;
  sizeBytes: number;
  mimeType?: string;
}

/** Web only: a downloaded blob to store under `path`; resolves to the stored size in bytes. */
export type SaveBlob = (path: string, file: { name: string; mimeType?: string; size: number; blob: Blob }) => Promise<number>;

export interface RemoteStreamResolverOptions {
  /** Read lazily so reconfiguring the server takes effect without rebuilding the resolver. */
  client: () => RemoteClient;
  /** Required on web for `saveToDevice` (native writes with Filesystem). */
  saveBlob?: SaveBlob;
  /** Default: `Capacitor.isNativePlatform()`. */
  isNative?: boolean;
}

const EXT_BY_MIME: Record<string, string> = {
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/aac': 'aac',
  'audio/ogg': 'ogg',
  'audio/opus': 'opus',
  'audio/webm': 'webm',
  'audio/flac': 'flac',
  'audio/x-flac': 'flac',
  'audio/wav': 'wav',
};

/** 53-bit string hash (cyrb53): a short, filesystem-safe key derived from a track id. */
function cyrb53(text: string): number {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

/** Store-relative path for a saved track: `imported/remote-<hash>.audio.<ext>`. */
export function savedFilePath(trackId: string, mimeType?: string): string {
  const ext = (mimeType && EXT_BY_MIME[mimeType.toLowerCase()]) ?? 'audio';
  return `${SAVED_DIR}/remote-${cyrb53(trackId).toString(36)}.audio.${ext}`;
}

/**
 * Asks the download server for a direct link (`POST /stream`) and saves a
 * link to app storage. Structurally satisfies `StreamResolverPort` from
 * @open-record/state (providers may import models only).
 */
export class RemoteStreamResolver {
  constructor(private readonly options: RemoteStreamResolverOptions) {}

  private get native(): boolean {
    return this.options.isNative ?? Capacitor.isNativePlatform();
  }

  /** A playable link for a page URL. Calls the server; cache it with the returned `expiresAt`. */
  async resolve(
    pageUrl: string,
    signal?: AbortSignal,
    quality?: AudioQuality,
  ): Promise<{ url: string; mimeType?: string; expiresAt?: number; headers?: Record<string, string>; meta?: StreamMeta }> {
    const stream = await this.options.client().streamUrl(pageUrl, signal, quality);
    const link: StreamLink = { url: stream.url, meta: { ...stream.track, artworkUrl: stream.track.thumbnailUrl } };
    if (stream.mimeType) link.mimeType = stream.mimeType;
    if (stream.httpHeaders) link.headers = stream.httpHeaders;
    if (stream.expiresAt) {
      const ms = Date.parse(stream.expiresAt);
      if (Number.isFinite(ms)) link.expiresAt = ms;
    }
    return link;
  }

  /**
   * Fetch the page's audio into app storage. Native: `Filesystem.downloadFile`
   * with progress events; web: `fetch` into a Blob handed to `saveBlob`.
   * Rejects with AbortedError when cancelled (the partial file is removed).
   */
  async saveToDevice(pageUrl: string, opts: SaveToDeviceOptions): Promise<SavedFile> {
    if (opts.signal?.aborted) throw new AbortedError();
    const resolved = await this.options.client().streamUrl(pageUrl, opts.signal, opts.quality);
    const stream = { ...resolved, url: unthrottled(resolved.url) };
    const path = savedFilePath(opts.id, stream.mimeType);
    if (this.native) {
      const location = opts.location ?? 'data';
      const size = await this.withLinkRetry(opts.signal, () =>
        this.downloadNative(stream.url, stream.httpHeaders ?? {}, path, nativeDirectory(location), opts),
      );
      return { sourceFile: withDownloadLocation(path, location), sizeBytes: size, mimeType: stream.mimeType };
    }
    const result = await this.withLinkRetry(opts.signal, () =>
      this.downloadWeb(stream.url, stream.httpHeaders ?? {}, path, stream.mimeType, opts),
    );
    return { sourceFile: path, sizeBytes: result, mimeType: stream.mimeType };
  }

  /**
   * Checks that a page URL can be saved without downloading it: asks the server
   * for a stream link, then fetches the first 1 KB of that link. Retries the
   * usual 403 warm-up. Rejects (HttpError / NetworkError) when it cannot play.
   */
  async probe(pageUrl: string, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw new AbortedError();
    const stream = await this.options.client().streamUrl(pageUrl, signal);
    const mime = stream.mimeType?.toLowerCase() ?? '';
    if (mime.includes('mpegurl') || /\.m3u8(\?|$)/i.test(stream.url) || /\/manifest\//i.test(stream.url)) {
      throw new HttpError(422, 'Live streams can’t be downloaded.');
    }
    await this.withLinkRetry(signal, () => this.probeRange(stream.url, stream.httpHeaders ?? {}, signal));
  }

  private async probeRange(url: string, headers: Record<string, string>, signal?: AbortSignal): Promise<void> {
    let target = url;
    const sendHeaders: Record<string, string> = this.native ? { ...headers } : {};
    try {
      const parsed = new URL(url);
      if (parsed.hostname.endsWith('.googlevideo.com')) {
        parsed.searchParams.set('range', '0-1023');
        target = parsed.toString();
      } else {
        sendHeaders['Range'] = 'bytes=0-1023';
      }
    } catch {
      throw new HttpError(422, 'The server returned an invalid link.');
    }
    let status: number;
    let contentType: string;
    if (this.native) {
      let res: { status: number; headers: Record<string, string> };
      try {
        res = await CapacitorHttp.request({ url: target, method: 'GET', headers: sendHeaders, responseType: 'blob' });
      } catch (err) {
        if (signal?.aborted) throw new AbortedError();
        throw new NetworkError('Could not fetch the audio.', { cause: err });
      }
      status = res.status;
      contentType = headerValue(res.headers, 'content-type');
    } else {
      let res: Response;
      try {
        res = await fetch(target, { headers: sendHeaders, signal });
      } catch (err) {
        if (signal?.aborted) throw new AbortedError();
        throw new NetworkError('Could not fetch the audio.', { cause: err });
      }
      await res.body?.cancel().catch(() => undefined);
      status = res.status;
      contentType = res.headers.get('content-type') ?? '';
    }
    if (signal?.aborted) throw new AbortedError();
    if (status !== 200 && status !== 206) throw new HttpError(status, `Could not fetch the audio (HTTP ${status}).`);
    const type = contentType.split(';')[0].trim().toLowerCase();
    if (type && !/^(audio|video)\//.test(type) && type !== 'application/octet-stream') {
      throw new HttpError(415, 'The link does not point to audio.');
    }
  }

  /**
   * A freshly minted googlevideo link answers 403 (404 through Android's
   * downloader, which reports no status) for roughly 2-4 s before it starts
   * serving, so retry the fetch a few times before calling it failed.
   */
  private async withLinkRetry<T>(signal: AbortSignal | undefined, attempt: () => Promise<T>): Promise<T> {
    for (let i = 0; ; i++) {
      try {
        return await attempt();
      } catch (err) {
        if (i >= LINK_RETRY_DELAYS_MS.length || !isLinkNotReady(err, this.native)) throw err;
        await sleep(LINK_RETRY_DELAYS_MS[i], signal);
      }
    }
  }

  private async downloadNative(
    url: string,
    headers: Record<string, string>,
    path: string,
    directory: Directory,
    opts: SaveToDeviceOptions,
  ): Promise<number> {
    let listener: PluginListenerHandle | undefined;
    if (opts.onProgress) {
      listener = await Filesystem.addListener('progress', (status) => {
        if (status.url === url && status.contentLength > 0) {
          opts.onProgress?.(Math.min(1, status.bytes / status.contentLength));
        }
      });
    }
    try {
      // downloadFile does not create the folder on Android (ENOENT), whatever `recursive` says.
      await Filesystem.mkdir({ path: SAVED_DIR, directory, recursive: true }).catch(() => undefined);
      await Filesystem.downloadFile({ url, headers, path, directory, recursive: true, progress: !!opts.onProgress });
    } catch (err) {
      await this.removeNative(path, directory);
      throw downloadError(err);
    } finally {
      await listener?.remove();
    }
    if (opts.signal?.aborted) {
      await this.removeNative(path, directory);
      throw new AbortedError();
    }
    const { size } = await Filesystem.stat({ path, directory });
    opts.onProgress?.(1);
    return size;
  }

  private async downloadWeb(
    url: string,
    headers: Record<string, string>,
    path: string,
    mimeType: string | undefined,
    opts: SaveToDeviceOptions,
  ): Promise<number> {
    if (!this.options.saveBlob) throw new RemoteConfigError('Saving files is not wired on this platform.');
    let res: Response;
    try {
      res = await fetch(url, { headers, signal: opts.signal });
    } catch (err) {
      if (opts.signal?.aborted) throw new AbortedError();
      throw new NetworkError('Could not fetch the audio.', { cause: err });
    }
    if (!res.ok) throw new HttpError(res.status, `Could not fetch the audio (HTTP ${res.status}).`);
    const total = Number(res.headers.get('content-length'));
    const parts: BlobPart[] = [];
    let received = 0;
    const reader = res.body?.getReader();
    while (reader) {
      const { done, value } = await reader.read();
      if (done) break;
      if (opts.signal?.aborted) {
        await reader.cancel().catch(() => undefined);
        throw new AbortedError();
      }
      parts.push(value);
      received += value.byteLength;
      if (total > 0) opts.onProgress?.(Math.min(1, received / total));
    }
    const type = mimeType ?? res.headers.get('content-type')?.split(';')[0]?.trim();
    const blob = new Blob(parts, { type: type || undefined });
    const size = await this.options.saveBlob(path, { name: path.split('/').pop() ?? path, mimeType: type || undefined, size: blob.size, blob });
    opts.onProgress?.(1);
    return size;
  }

  private async removeNative(path: string, directory: Directory): Promise<void> {
    await Filesystem.deleteFile({ path, directory }).catch(() => undefined);
  }
}

/**
 * YouTube serves a plain whole-file request at ~30 KB/s but a ranged one at full
 * speed, so ask for the whole file as an explicit range.
 */
function unthrottled(url: string): string {
  try {
    const parsed = new URL(url);
    if (!parsed.hostname.endsWith('.googlevideo.com') || parsed.searchParams.has('range')) return url;
    parsed.searchParams.set('range', '0-999999999');
    return parsed.toString();
  } catch {
    return url;
  }
}

/** Waits between media fetch attempts while a fresh link warms up (~10 s in all). */
const LINK_RETRY_DELAYS_MS = [2_000, 3_000, 5_000];

/** 403/404 from the media host, or (native) a download error without a status. */
function isLinkNotReady(err: unknown, native: boolean): boolean {
  if (err instanceof HttpError) return err.status === 403 || err.status === 404;
  return native && err instanceof NetworkError;
}

/** Resolves after `ms`; rejects with AbortedError when `signal` aborts first. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new AbortedError());
    const onAbort = () => {
      clearTimeout(timer);
      reject(new AbortedError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function nativeDirectory(location: DownloadLocation): Directory {
  return location === 'external' ? Directory.External : Directory.Data;
}

function downloadError(err: unknown): Error {
  const status = Number((err as { status?: unknown })?.status);
  if (Number.isFinite(status) && status >= 400) return new HttpError(status, `Could not fetch the audio (HTTP ${status}).`);
  return new NetworkError('Could not fetch the audio.', { cause: err });
}

function headerValue(headers: Record<string, string> | undefined, name: string): string {
  if (!headers) return '';
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name);
  return key ? String(headers[key]) : '';
}
