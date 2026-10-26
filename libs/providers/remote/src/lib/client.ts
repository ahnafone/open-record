import type { AudioQuality, DownloadSite, RemoteSearchResult } from '@open-record/models';
import { AuthError, HttpError, ProtocolError, RemoteBusyError, RemoteConfigError } from './errors';
import { createFetchTransport, type HttpRequest, type HttpTransport } from './transport';

/** Where the download server lives and the optional static bearer token. */
export interface RemoteConfig {
  /** e.g. `https://music.example.ts.net` or `http://192.168.1.20:8080`. A path prefix is kept. */
  baseUrl: string;
  /** Legacy/headless static token; used only when no user token is available. */
  token?: string;
}

/** How authenticated calls get their bearer token. */
export interface RemoteAuthOptions {
  /** The signed-in user's fresh access token (Supabase JWT), or null when signed out. Wins over the static token. */
  accessToken?: () => Promise<string | null | undefined>;
  /** Called when the server rejects an authenticated call (401/403). */
  onUnauthorized?: () => void;
}

/** Public client config from `GET /app-config` (the anon key is public by design). */
export interface RemoteAppConfig {
  supabaseUrl: string | null;
  supabaseAnonKey: string | null;
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

/** Alternative titles and artist names for one song (`GET /meta/aliases`). */
export interface TrackAliases {
  titles: string[];
  artists: string[];
}

/** Query for {@link RemoteClient.aliases}. */
export interface TrackAliasQuery {
  artist: string;
  title: string;
  isrc?: string;
}

const MAX_ALIASES = 12;

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

const strList = (v: unknown): string[] =>
  Array.isArray(v) ? [...new Set(v.map(str).filter((x): x is string => !!x))].slice(0, MAX_ALIASES) : [];

/** Validate an aliases response; anything malformed becomes empty lists. */
export function parseAliases(raw: unknown): TrackAliases {
  if (!isObj(raw)) return { titles: [], artists: [] };
  return { titles: strList(raw['titles']), artists: strList(raw['artists']) };
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
    private readonly auth: RemoteAuthOptions = {},
  ) {
    this.baseUrl = normalizeBaseUrl(config.baseUrl);
    this.token = config.token?.trim() ?? '';
  }

  /** The bearer header: the user's access token when signed in, else the static token (empty when neither). */
  async authHeaders(): Promise<Record<string, string>> {
    let token: string | null | undefined;
    try {
      token = await this.auth.accessToken?.();
    } catch {
      token = null;
    }
    const bearer = token?.trim() || this.token;
    return bearer ? { Authorization: `Bearer ${bearer}` } : {};
  }

  /** `GET /app-config` (no auth): the server's public account settings. */
  async appConfig(signal?: AbortSignal): Promise<RemoteAppConfig> {
    const data = await this.call({ method: 'GET', path: '/app-config', auth: false, signal, timeoutMs: 10_000 });
    if (!isObj(data)) throw new ProtocolError('Unexpected app config from the server.');
    return { supabaseUrl: str(data['supabaseUrl']) ?? null, supabaseAnonKey: str(data['supabaseAnonKey']) ?? null };
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

  /**
   * `GET /meta/aliases?artist=&title=[&isrc=]`: catalogue aliases (all
   * languages/scripts) for cross-language matching. A background lookup, so a
   * 401 does not prompt sign-in. Rejects like `search`; RemoteProvider turns
   * failures into empty lists.
   */
  async aliases(query: TrackAliasQuery, signal?: AbortSignal): Promise<TrackAliases> {
    const title = query.title.trim();
    if (!title) return { titles: [], artists: [] };
    const params = new URLSearchParams({ artist: query.artist.trim(), title });
    const isrc = query.isrc?.trim();
    if (isrc) params.set('isrc', isrc);
    return parseAliases(await this.call({ method: 'GET', path: `/meta/aliases?${params}`, signal, timeoutMs: 30_000, prompt: false }));
  }

  /** `POST /resolve {url}`: info for a pasted link. */
  async resolve(url: string, signal?: AbortSignal): Promise<RemoteSearchResult> {
    const result = parseSearchResult(await this.call({ method: 'POST', path: '/resolve', body: { url: url.trim() }, signal }));
    if (!result) throw new ProtocolError('Unexpected resolve response from the server.');
    return result;
  }

  /**
   * `POST /stream {url, quality?}`: a direct audio link for a page. Nothing is
   * proxied; the bytes come from the source. `quality` is omitted when
   * undefined (the server then picks the highest). Rejects with
   * {@link RemoteBusyError} on 503.
   */
  async streamUrl(pageUrl: string, signal?: AbortSignal, quality?: AudioQuality): Promise<RemoteStream> {
    const body: { url: string; quality?: AudioQuality } = { url: pageUrl.trim() };
    if (quality) body.quality = quality;
    return parseStream(await this.call({ method: 'POST', path: '/stream', body, signal, timeoutMs: 60_000 }));
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
    // Authenticated: call() throws AuthError when signed out or the token is bad
    // (no sign-in prompt: Settings shows the message in place).
    await this.call({ method: 'GET', path: '/ping', signal, timeoutMs: 10_000, prompt: false });
  }

  private async call(opts: {
    method: HttpRequest['method'];
    path: string;
    body?: unknown;
    auth?: boolean;
    /** Call `onUnauthorized` on 401/403 (default true for authenticated calls). */
    prompt?: boolean;
    signal?: AbortSignal;
    timeoutMs?: number;
  }): Promise<unknown> {
    const authed = opts.auth !== false;
    const headers: Record<string, string> = { Accept: 'application/json', ...(authed ? await this.authHeaders() : {}) };
    const res = await this.transport.request({
      method: opts.method,
      url: this.baseUrl + opts.path,
      headers,
      body: opts.body,
      signal: opts.signal,
      timeoutMs: opts.timeoutMs,
    });
    if (res.status === 401 || res.status === 403) {
      if (authed && opts.prompt !== false) this.auth.onUnauthorized?.();
      throw new AuthError(res.status);
    }
    if (res.status === 503) throw new RemoteBusyError(retryAfterSec(res.headers['retry-after']));
    if (res.status < 200 || res.status >= 300) throw new HttpError(res.status, serverMessage(res.data, res.status));
    return res.data;
  }
}

function retryAfterSec(raw: string | undefined): number | undefined {
  const sec = Number(raw);
  return Number.isFinite(sec) && sec >= 0 ? sec : undefined;
}

