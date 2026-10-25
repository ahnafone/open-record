import type { DownloadSite, RemoteSearchResult } from '@open-record/models';
import { AuthError, HttpError, ProtocolError, RemoteBusyError, RemoteConfigError } from './errors';
import { createFetchTransport, type HttpRequest, type HttpTransport } from './transport';

/** Where the download server lives and the shared bearer token. */
export interface RemoteConfig {
  /** e.g. `https://music.example.ts.net` or `http://192.168.1.20:8080`. A path prefix is kept. */
  baseUrl: string;
  token: string;
}

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

/** Direct audio link for one page (`POST /stream`). `expiresAt` is an ISO time. */
export interface RemoteStream {
  url: string;
  mimeType?: string;
  expiresAt?: string;
  httpHeaders?: Record<string, string>;
  track: { title: string; artist: string; album?: string; durationSec?: number; thumbnailUrl?: string };
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

export function parseStream(raw: unknown): RemoteStream {
  if (!isObj(raw)) throw new ProtocolError('Unexpected stream response from the server.');
  const url = str(raw['url']);
  if (!url || !/^https?:\/\//i.test(url)) throw new ProtocolError('The server returned no playable link.');
  const meta = isObj(raw['track']) ? raw['track'] : {};
  const stream: RemoteStream = {
    url,
    track: { title: str(meta['title']) ?? 'Untitled', artist: str(meta['artist']) ?? '' },
  };
  const mimeType = str(raw['mimeType']);
  if (mimeType) stream.mimeType = mimeType;
  const expiresAt = str(raw['expiresAt']);
  if (expiresAt) stream.expiresAt = expiresAt;
  if (isObj(raw['httpHeaders'])) {
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(raw['httpHeaders'])) {
      if (typeof value === 'string') headers[name] = value;
    }
    if (Object.keys(headers).length) stream.httpHeaders = headers;
  }
  const album = str(meta['album']);
  if (album) stream.track.album = album;
  const duration = num(meta['durationSec']);
  if (duration && duration > 0) stream.track.durationSec = duration;
  const thumb = str(meta['thumbnailUrl']);
  if (thumb && /^https?:\/\//i.test(thumb)) stream.track.thumbnailUrl = thumb;
  return stream;
}

function serverMessage(data: unknown, status: number): string {
  if (isObj(data)) {
    const msg = str(data['error']) ?? str(data['message']);
    if (msg) return msg;
  }
  if (typeof data === 'string' && data.trim() && data.length < 300) return data.trim();
  return `The download server returned HTTP ${status}.`;
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

  /**
   * `POST /stream {url}`: a direct audio link for a page. Nothing is proxied;
   * the bytes come from the source. Rejects with {@link RemoteBusyError} on 503.
   */
  async streamUrl(pageUrl: string, signal?: AbortSignal): Promise<RemoteStream> {
    return parseStream(await this.call({ method: 'POST', path: '/stream', body: { url: pageUrl.trim() }, signal, timeoutMs: 60_000 }));
  }

  /** `GET /health` (no auth). Resolves when the server answers `{status:'ok'}`. */
  async health(signal?: AbortSignal): Promise<void> {
    const data = await this.call({ method: 'GET', path: '/health', auth: false, signal, timeoutMs: 10_000 });
    if (!isObj(data) || data['status'] !== 'ok') throw new ProtocolError('That URL did not answer like an Open Record server.');
  }

  /**
   * Settings "Test connection": `health()` then an authenticated probe
   * (`GET /ping`, an authenticated route).
   * Rejects with {@link AuthError} for a bad token.
   */
  async testConnection(signal?: AbortSignal): Promise<void> {
    await this.health(signal);
    // Authenticated: call() throws AuthError on a bad token.
    await this.call({ method: 'GET', path: '/ping', signal, timeoutMs: 10_000 });
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
    if (res.status === 503) throw new RemoteBusyError(retryAfterSec(res.headers['retry-after']));
    if (res.status < 200 || res.status >= 300) throw new HttpError(res.status, serverMessage(res.data, res.status));
    return res.data;
  }
}

function retryAfterSec(raw: string | undefined): number | undefined {
  const sec = Number(raw);
  return Number.isFinite(sec) && sec >= 0 ? sec : undefined;
}

