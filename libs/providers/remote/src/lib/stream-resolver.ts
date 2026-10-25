import { Capacitor, type PluginListenerHandle } from '@capacitor/core';
import { Directory, Filesystem } from '@capacitor/filesystem';
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
}

export interface SavedFile {
  /** Store-relative path (`imported/<key>.audio.<ext>`), the form stored as a track's file path. */
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
  ): Promise<{ url: string; mimeType?: string; expiresAt?: number; headers?: Record<string, string>; meta?: StreamMeta }> {
    const stream = await this.options.client().streamUrl(pageUrl, signal);
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
    const stream = await this.options.client().streamUrl(pageUrl, opts.signal);
    const path = savedFilePath(opts.id, stream.mimeType);
    const result = this.native
      ? await this.downloadNative(stream.url, stream.httpHeaders ?? {}, path, opts)
      : await this.downloadWeb(stream.url, stream.httpHeaders ?? {}, path, stream.mimeType, opts);
    return { sourceFile: path, sizeBytes: result, mimeType: stream.mimeType };
  }

  private async downloadNative(url: string, headers: Record<string, string>, path: string, opts: SaveToDeviceOptions): Promise<number> {
    let listener: PluginListenerHandle | undefined;
    if (opts.onProgress) {
      listener = await Filesystem.addListener('progress', (status) => {
        if (status.url === url && status.contentLength > 0) {
          opts.onProgress?.(Math.min(1, status.bytes / status.contentLength));
        }
      });
    }
    try {
      await Filesystem.downloadFile({ url, headers, path, directory: Directory.Data, recursive: true, progress: !!opts.onProgress });
    } catch (err) {
      await this.removeNative(path);
      throw downloadError(err);
    } finally {
      await listener?.remove();
    }
    if (opts.signal?.aborted) {
      await this.removeNative(path);
      throw new AbortedError();
    }
    const { size } = await Filesystem.stat({ path, directory: Directory.Data });
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

  private async removeNative(path: string): Promise<void> {
    await Filesystem.deleteFile({ path, directory: Directory.Data }).catch(() => undefined);
  }
}

function downloadError(err: unknown): Error {
  const status = Number((err as { status?: unknown })?.status);
  if (Number.isFinite(status) && status >= 400) return new HttpError(status, `Could not fetch the audio (HTTP ${status}).`);
  return new NetworkError('Could not fetch the audio.', { cause: err });
}
