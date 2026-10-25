import { Capacitor } from '@capacitor/core';
import { Directory, Filesystem } from '@capacitor/filesystem';
import { parseFileHeaders, type AuthorizedRequest } from './client';
import { AbortedError, AuthError, HttpError, NetworkError } from './errors';

/**
 * A finished download on this device, ready for the local import pipeline.
 * Structurally identical to `PickedAudio` in @open-record/providers/local, so
 * it can be handed to `LocalProvider.importDownloaded` as is.
 */
export interface DownloadedFile {
  /** File name with extension; the extension decides the stored file's type. */
  name: string;
  mimeType?: string;
  size: number;
  /** Web: the file contents. */
  blob?: Blob;
  /** Native: `file://` URI of a temporary copy in the cache directory. */
  path?: string;
}

export interface DownloadTargetRequest extends AuthorizedRequest {
  /** Name without extension, e.g. `Artist - Title`; the extension comes from the type. */
  baseName: string;
  /** File name the server suggested (Content-Disposition), used as is when present. */
  fileName?: string;
  mimeType?: string;
  signal?: AbortSignal;
}

/**
 * Where finished server files land before import. Web keeps them in memory
 * as a Blob; native streams them to disk with Filesystem.downloadFile so
 * large files never cross the JS bridge.
 */
export interface DownloadTarget {
  fetch(req: DownloadTargetRequest): Promise<DownloadedFile>;
  /** Delete temporary data once the file has been imported (or failed). */
  release(file: DownloadedFile): Promise<void>;
}

function statusError(status: number): Error {
  return status === 401 || status === 403 ? new AuthError(status) : new HttpError(status, `Could not fetch the downloaded file (HTTP ${status}).`);
}

/** Web target: `fetch` with the bearer header, kept as a Blob. */
export class BlobDownloadTarget implements DownloadTarget {
  constructor(private readonly fetchImpl: typeof fetch = (...args) => fetch(...args)) {}

  async fetch(req: DownloadTargetRequest): Promise<DownloadedFile> {
    let res: Response;
    try {
      res = await this.fetchImpl(req.url, { headers: req.headers, signal: req.signal });
    } catch (err) {
      if (req.signal?.aborted) throw new AbortedError();
      throw new NetworkError('Could not fetch the downloaded file.', { cause: err });
    }
    if (!res.ok) throw statusError(res.status);
    const headers: Record<string, string> = {};
    res.headers.forEach((value, key) => (headers[key.toLowerCase()] = value));
    const info = parseFileHeaders(headers);
    const blob = await res.blob();
    const mimeType = info.mimeType ?? req.mimeType ?? (blob.type || undefined);
    return { name: buildFileName(req.baseName, mimeType, info.fileName ?? req.fileName), mimeType, size: blob.size, blob };
  }

  async release(): Promise<void> {
    // Nothing on disk; the Blob is garbage collected.
  }
}

/** Temp folder (in `Directory.Cache`) for files between download and import. */
export const DOWNLOAD_CACHE_DIR = 'downloads';

/** Native target: Filesystem.downloadFile into the cache directory. */
export class NativeDownloadTarget implements DownloadTarget {
  async fetch(req: DownloadTargetRequest): Promise<DownloadedFile> {
    if (req.signal?.aborted) throw new AbortedError();
    const name = buildFileName(req.baseName, req.mimeType, req.fileName);
    const ext = /\.([a-z0-9]{1,5})$/i.exec(name)?.[1] ?? 'audio';
    const path = `${DOWNLOAD_CACHE_DIR}/${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
    try {
      // Deprecated in favour of @capacitor/file-transfer, which is not installed; still supported in v8.
      await Filesystem.downloadFile({ url: req.url, headers: req.headers, path, directory: Directory.Cache, recursive: true });
    } catch (err) {
      await Filesystem.deleteFile({ path, directory: Directory.Cache }).catch(() => undefined);
      const status = Number((err as { status?: unknown })?.status ?? /\b(40[13]|[45]\d\d)\b/.exec(String(err))?.[1]);
      if (Number.isFinite(status) && status >= 400) throw statusError(status);
      throw new NetworkError('Could not fetch the downloaded file.', { cause: err });
    }
    if (req.signal?.aborted) {
      await Filesystem.deleteFile({ path, directory: Directory.Cache }).catch(() => undefined);
      throw new AbortedError();
    }
    const [{ size }, { uri }] = await Promise.all([
      Filesystem.stat({ path, directory: Directory.Cache }),
      Filesystem.getUri({ path, directory: Directory.Cache }),
    ]);
    return { name, mimeType: req.mimeType, size, path: uri };
  }

  async release(file: DownloadedFile): Promise<void> {
    if (!file.path) return;
    await Filesystem.deleteFile({ path: file.path }).catch(() => undefined);
  }
}

/** Native filesystem download on Android/iOS, Blob in the browser. */
export function createDefaultDownloadTarget(): DownloadTarget {
  return Capacitor.isNativePlatform() ? new NativeDownloadTarget() : new BlobDownloadTarget();
}

const EXT_BY_MIME: Record<string, string> = {
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/m4a': 'm4a',
  'audio/aac': 'aac',
  'audio/ogg': 'ogg',
  'audio/opus': 'opus',
  'audio/webm': 'webm',
  'audio/flac': 'flac',
  'audio/x-flac': 'flac',
  'audio/wav': 'wav',
};

const safeName = (name: string) =>
  // eslint-disable-next-line no-control-regex -- strip control characters from server-supplied names
  name.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);

/**
 * Safe file name for import: the server's name when it has an audio
 * extension, else `baseName` plus an extension from `mimeType` (none if unknown).
 */
export function buildFileName(baseName: string, mimeType?: string, serverName?: string): string {
  const server = serverName ? safeName(serverName) : '';
  if (/\.(mp3|m4a|mp4|aac|ogg|oga|opus|webm|flac|wav)$/i.test(server)) return server;
  const base = safeName(baseName) || 'download';
  const ext = mimeType ? EXT_BY_MIME[mimeType.toLowerCase()] : undefined;
  return ext ? `${base}.${ext}` : base;
}
