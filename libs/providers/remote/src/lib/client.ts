import type { DownloadJob, DownloadJobStatus, DownloadJobTrack, DownloadSite, RemoteSearchResult } from '@open-record/models';
import { AbortedError, AuthError, DownloadFailedError, HttpError, NetworkError, ProtocolError, RemoteConfigError } from './errors';
import { createFetchTransport, type HttpRequest, type HttpTransport } from './transport';

/** Where the download server lives and the shared bearer token. */
export interface RemoteConfig {
  /** e.g. `https://music.example.ts.net` or `http://192.168.1.20:8080`. A path prefix is kept. */
  baseUrl: string;
  token: string;
}

/** A GET request the platform download target performs itself (native `downloadFile`, web `fetch`). */
export interface AuthorizedRequest {
  url: string;
  headers: Record<string, string>;
}

export interface WaitOptions {
  /** Poll interval in ms (default 1000). */
  intervalMs?: number;
  /** Give up after this many ms (default 15 minutes). */
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Called after every poll. */
  onUpdate?(job: DownloadJob): void;
}

const JOB_STATUSES: readonly DownloadJobStatus[] = ['queued', 'downloading', 'processing', 'done', 'failed'];

/** Normalised base URL (no trailing slash). Throws {@link RemoteConfigError} for anything but http(s). */
export function normalizeBaseUrl(raw: string): string {
  const trimmed = raw.trim();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new RemoteConfigError('Enter a full server URL, e.g. https://music.example.com');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new RemoteConfigError('The server URL must start with http:// or https://');
  }
  return `${url.origin}${url.pathname}`.replace(/\/+$/, '');
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/** Validate one search result; `null` when unusable (no url/title). */
export function parseSearchResult(raw: unknown): RemoteSearchResult | null {
  if (!isObj(raw)) return null;
  const url = str(raw['url']);
  const title = str(raw['title']);
  if (!url || !title) return null;
  const result: RemoteSearchResult = {
    id: str(raw['id']) ?? url,
    title,
    artist: str(raw['artist']) ?? '',
    url,
    site: str(raw['site']) ?? 'web',
  };
  const duration = num(raw['durationSec']);
  if (duration !== undefined && duration > 0) result.durationSec = duration;
  const thumb = str(raw['thumbnailUrl']);
  if (thumb && /^https?:\/\//i.test(thumb)) result.thumbnailUrl = thumb;
  return result;
}

function parseJobTrack(raw: unknown): DownloadJobTrack | undefined {
  if (!isObj(raw)) return undefined;
  const title = str(raw['title']);
  if (!title) return undefined;
  const track: DownloadJobTrack = { title, artist: str(raw['artist']) ?? '' };
  const album = str(raw['album']);
  if (album) track.album = album;
  const year = num(raw['year']);
  if (year) track.year = year;
  const genre = str(raw['genre']);
  if (genre) track.genre = genre;
  const duration = num(raw['durationSec']);
  if (duration) track.durationSec = duration;
  const art = str(raw['artworkUrl']);
  if (art) track.artworkUrl = art;
  return track;
}

export function parseJob(raw: unknown): DownloadJob {
  if (!isObj(raw) || !str(raw['id']) || !JOB_STATUSES.includes(raw['status'] as DownloadJobStatus)) {
    throw new ProtocolError('Unexpected download job response from the server.');
  }
  const job: DownloadJob = {
    id: str(raw['id']) as string,
    status: raw['status'] as DownloadJobStatus,
    progress: Math.min(100, Math.max(0, num(raw['progress']) ?? 0)),
  };
  const error = str(raw['error']);
  if (error) job.error = error;
  const track = parseJobTrack(raw['track']);
  if (track) job.track = track;
  return job;
}

function serverMessage(data: unknown, status: number): string {
  if (isObj(data)) {
    const msg = str(data['error']) ?? str(data['message']);
    if (msg) return msg;
  }
  if (typeof data === 'string' && data.trim() && data.length < 300) return data.trim();
  return `The download server returned HTTP ${status}.`;
}

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

/**
 * Typed client for the Open Record download server. Every authenticated call
 * sends `Authorization: Bearer <token>`. Errors are `RemoteError`
 * subclasses: {@link AuthError} (401/403), {@link HttpError},
 * {@link NetworkError}, {@link ProtocolError}.
 */
export class RemoteClient {
  readonly baseUrl: string;
  private readonly token: string;

  constructor(
    config: RemoteConfig,
    private readonly transport: HttpTransport = createFetchTransport(),
  ) {
    this.baseUrl = normalizeBaseUrl(config.baseUrl);
    this.token = config.token.trim();
  }

  /** The bearer header (empty when no token is set). */
  authHeaders(): Record<string, string> {
    return this.token ? { Authorization: `Bearer ${this.token}` } : {};
  }

  /** `GET /search?q=&source=`. */
  async search(query: string, source: DownloadSite = 'youtube', signal?: AbortSignal): Promise<RemoteSearchResult[]> {
    const q = query.trim();
    if (!q) return [];
    const params = new URLSearchParams({ q, source });
    const data = await this.call({ method: 'GET', path: `/search?${params}`, signal });
    if (!isObj(data) || !Array.isArray(data['results'])) {
      throw new ProtocolError('Unexpected search response from the server.');
    }
    return data['results'].map(parseSearchResult).filter((r): r is RemoteSearchResult => r !== null);
  }

  /** `POST /resolve {url}`: info for a pasted link. */
  async resolve(url: string, signal?: AbortSignal): Promise<RemoteSearchResult> {
    const result = parseSearchResult(await this.call({ method: 'POST', path: '/resolve', body: { url: url.trim() }, signal }));
    if (!result) throw new ProtocolError('Unexpected resolve response from the server.');
    return result;
  }

  /** `POST /downloads {url}` -> the queued job. */
  async startDownload(url: string, signal?: AbortSignal): Promise<Pick<DownloadJob, 'id' | 'status'>> {
    const data = await this.call({ method: 'POST', path: '/downloads', body: { url: url.trim() }, signal });
    const job = parseJob({ progress: 0, ...(isObj(data) ? data : {}) });
    return { id: job.id, status: job.status };
  }

  /** `GET /downloads/:id`. */
  async getDownload(id: string, signal?: AbortSignal): Promise<DownloadJob> {
    return parseJob(await this.call({ method: 'GET', path: `/downloads/${encodeURIComponent(id)}`, signal }));
  }

  /**
   * Poll a job until it is `done` (resolves with it) or `failed` (rejects with
   * {@link DownloadFailedError}). Transient network errors are retried.
   */
  async waitForDownload(id: string, options: WaitOptions = {}): Promise<DownloadJob> {
    const interval = options.intervalMs ?? 1000;
    const deadline = Date.now() + (options.timeoutMs ?? 15 * 60_000);
    let networkFailures = 0;
    for (;;) {
      let job: DownloadJob | undefined;
      try {
        job = await this.getDownload(id, options.signal);
        networkFailures = 0;
      } catch (err) {
        // Phones drop Wi-Fi briefly; only give up after several misses in a row.
        if (!(err instanceof NetworkError) || ++networkFailures > 5) throw err;
      }
      if (job) {
        options.onUpdate?.(job);
        if (job.status === 'done') return job;
        if (job.status === 'failed') throw new DownloadFailedError(id, job.error ?? 'The download failed on the server.');
      }
      if (Date.now() > deadline) throw new DownloadFailedError(id, 'The download took too long.');
      await sleep(interval, options.signal);
    }
  }

  /** URL of a finished job's audio. It needs {@link authHeaders}; use {@link fileRequest}. */
  fileUrl(id: string): string {
    return `${this.baseUrl}/downloads/${encodeURIComponent(id)}/file`;
  }

  /** Everything needed to GET the finished file with auth. */
  fileRequest(id: string): AuthorizedRequest {
    return { url: this.fileUrl(id), headers: this.authHeaders() };
  }

  /**
   * `HEAD /downloads/:id/file`: content type, size and suggested file name
   * without the body. Best effort: resolves to `{}` when unavailable.
   */
  async fileInfo(id: string, signal?: AbortSignal): Promise<{ mimeType?: string; sizeBytes?: number; fileName?: string }> {
    try {
      const res = await this.transport.request({ method: 'HEAD', url: this.fileUrl(id), headers: this.authHeaders(), signal });
      if (res.status < 200 || res.status >= 300) return {};
      return parseFileHeaders(res.headers);
    } catch {
      return {};
    }
  }

  /** `GET /health` (no auth). Resolves when the server answers `{status:'ok'}`. */
  async health(signal?: AbortSignal): Promise<void> {
    const data = await this.call({ method: 'GET', path: '/health', auth: false, signal, timeoutMs: 10_000 });
    if (!isObj(data) || data['status'] !== 'ok') throw new ProtocolError('That URL did not answer like an Open Record server.');
  }

  /**
   * Settings "Test connection": `health()` then an authenticated probe
   * (`GET /downloads/<unknown id>`; 404 means the token was accepted).
   * Rejects with {@link AuthError} for a bad token.
   */
  async testConnection(signal?: AbortSignal): Promise<void> {
    await this.health(signal);
    try {
      await this.call({ method: 'GET', path: '/downloads/connection-test', signal, timeoutMs: 10_000 });
    } catch (err) {
      if (err instanceof HttpError && err.status === 404) return;
      throw err;
    }
  }

  private async call(opts: {
    method: HttpRequest['method'];
    path: string;
    body?: unknown;
    auth?: boolean;
    signal?: AbortSignal;
    timeoutMs?: number;
  }): Promise<unknown> {
    const headers: Record<string, string> = { Accept: 'application/json', ...(opts.auth === false ? {} : this.authHeaders()) };
    const res = await this.transport.request({
      method: opts.method,
      url: this.baseUrl + opts.path,
      headers,
      body: opts.body,
      signal: opts.signal,
      timeoutMs: opts.timeoutMs,
    });
    if (res.status === 401 || res.status === 403) throw new AuthError(res.status);
    if (res.status < 200 || res.status >= 300) throw new HttpError(res.status, serverMessage(res.data, res.status));
    return res.data;
  }
}

/** Content type / length / file name from response headers (lower-cased keys). */
export function parseFileHeaders(headers: Record<string, string>): { mimeType?: string; sizeBytes?: number; fileName?: string } {
  const out: { mimeType?: string; sizeBytes?: number; fileName?: string } = {};
  const type = headers['content-type']?.split(';')[0]?.trim().toLowerCase();
  if (type && type !== 'application/octet-stream') out.mimeType = type;
  const size = Number(headers['content-length']);
  if (Number.isFinite(size) && size > 0) out.sizeBytes = size;
  const disposition = headers['content-disposition'] ?? '';
  const star = /filename\*\s*=\s*(?:UTF-8'')?([^;]+)/i.exec(disposition);
  const plain = /filename\s*=\s*"?([^";]+)"?/i.exec(disposition);
  let name: string | undefined;
  try {
    name = star?.[1] ? decodeURIComponent(star[1].trim().replace(/^"|"$/g, '')) : plain?.[1]?.trim();
  } catch {
    name = plain?.[1]?.trim();
  }
  if (name) out.fileName = name.split(/[\\/]/).pop();
  return out;
}
