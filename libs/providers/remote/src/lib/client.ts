import {
  ENRICH_SOURCES,
  MAX_ENRICH_BATCH,
  type AudioQuality,
  type DownloadSite,
  type EnrichMatch,
  type EnrichQuery,
  type EnrichSource,
  type RemotePlaylist,
  type RemotePlaylistEntry,
  type RemoteSearchResult,
} from '@open-record/models';
import {
  AuthError,
  GuestHostError,
  GuestLimitError,
  HttpError,
  ProtocolError,
  RemoteBusyError,
  RemoteConfigError,
} from './errors';
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
  /**
   * True when a signed-out (guest) caller may search and stream on this server
   * (web build on the public server with `guestStreaming` on). A guest call
   * then sends no bearer and does not open the sign-in prompt on 401/403.
   */
  guestStreaming?: () => boolean;
  /**
   * True when a user session is known (signed in), even if no token could be
   * obtained (e.g. a failed refresh). Such a caller is never a guest and gets
   * the sign-in prompt on 401/403. Absent or false means a guest candidate.
   */
  signedIn?: () => boolean;
  /** Called when a guest call (no session) is rejected with 401/403, so the app can re-read the guest flag. */
  onGuestRejected?: () => void;
}

/** Public client config from `GET /app-config` (the anon key is public by design). */
export interface RemoteAppConfig {
  supabaseUrl: string | null;
  supabaseAnonKey: string | null;
  /** The server lets signed-out callers search and stream (subject to a guest limit). */
  guestStreaming: boolean;
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

const httpUrl = (v: unknown): string | undefined => {
  const s = str(v);
  return s && /^https?:\/\//i.test(s) ? s : undefined;
};

function parsePlaylistEntry(raw: unknown): RemotePlaylistEntry | null {
  if (!isObj(raw)) return null;
  const id = str(raw['id']);
  const url = httpUrl(raw['url']);
  const title = str(raw['title']);
  if (!id || !url || !title) return null;
  const entry: RemotePlaylistEntry = {
    id,
    url,
    site: str(raw['site']) ?? 'youtube',
    title,
    artist: str(raw['artist']) ?? '',
    originalTitle: str(raw['originalTitle']) ?? title,
  };
  const uploader = str(raw['uploader']);
  if (uploader) entry.uploader = uploader;
  const album = str(raw['album']);
  if (album) entry.album = album;
  const duration = num(raw['durationSec']);
  if (duration && duration > 0) entry.durationSec = duration;
  const thumb = httpUrl(raw['thumbnailUrl']);
  if (thumb) entry.thumbnailUrl = thumb;
  return entry;
}

/** Validate a `POST /playlist` response (a playlist, or a single song when `single` is set). */
export function parsePlaylist(raw: unknown): RemotePlaylist {
  if (!isObj(raw) || !Array.isArray(raw['entries'])) throw new ProtocolError('Unexpected playlist response from the server.');
  const url = httpUrl(raw['url']);
  if (!url) throw new ProtocolError('Unexpected playlist response from the server.');
  const playlist: RemotePlaylist = {
    id: str(raw['id']) ?? url,
    title: str(raw['title']) ?? 'YouTube playlist',
    url,
    site: str(raw['site']) ?? 'youtube',
    entries: raw['entries'].map(parsePlaylistEntry).filter((e): e is RemotePlaylistEntry => e !== null),
    unavailable: Math.max(0, Math.trunc(num(raw['unavailable']) ?? 0)),
    truncated: raw['truncated'] === true,
  };
  const uploader = str(raw['uploader']);
  if (uploader) playlist.uploader = uploader;
  if (raw['single'] === true) playlist.single = true;
  return playlist;
}

/** Most weaker suggestions kept from one enrich result (alongside the match itself). */
const MAX_ENRICH_ALTERNATIVES = 2;

/**
 * Validate one `POST /meta/enrich` result; null when absent or malformed.
 * Keeps up to {@link MAX_ENRICH_ALTERNATIVES} valid weaker `alternatives`.
 */
export function parseEnrichMatch(raw: unknown): EnrichMatch | null {
  const match = parseEnrichFields(raw);
  if (!match || !isObj(raw) || !Array.isArray(raw['alternatives'])) return match;
  const alternatives = raw['alternatives']
    .map(parseEnrichFields)
    .filter((m): m is EnrichMatch => !!m)
    .slice(0, MAX_ENRICH_ALTERNATIVES);
  if (alternatives.length) match.alternatives = alternatives;
  return match;
}

function parseEnrichFields(raw: unknown): EnrichMatch | null {
  if (!isObj(raw)) return null;
  const title = str(raw['title']);
  const artist = str(raw['artist']);
  const confidence = num(raw['confidence']);
  if (!title || !artist || confidence === undefined) return null;
  const sources = Array.isArray(raw['sources'])
    ? raw['sources'].filter((s): s is EnrichSource => (ENRICH_SOURCES as readonly unknown[]).includes(s))
    : [];
  const match: EnrichMatch = { title, artist, confidence, sources };
  const album = str(raw['album']);
  if (album) match.album = album;
  const year = num(raw['year']);
  if (year && year > 0) match.year = Math.trunc(year);
  const genre = str(raw['genre']);
  if (genre) match.genre = genre;
  const art = httpUrl(raw['artUrl']);
  if (art) match.artUrl = art;
  const duration = num(raw['durationSec']);
  if (duration && duration > 0) match.durationSec = duration;
  return match;
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
    return {
      supabaseUrl: str(data['supabaseUrl']) ?? null,
      supabaseAnonKey: str(data['supabaseAnonKey']) ?? null,
      guestStreaming: data['guestStreaming'] === true,
    };
  }

  /** `GET /search?q=&source=`. */
  async search(query: string, source: DownloadSite = 'youtube', signal?: AbortSignal): Promise<RemoteSearchResult[]> {
    const q = query.trim();
    if (!q) return [];
    const params = new URLSearchParams({ q, source });
    const data = await this.call({ method: 'GET', path: `/search?${params}`, signal, guest: true });
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

  /** `POST /playlist {url}`: a public YouTube / YT Music playlist's entries, or one song (metadata only). */
  async playlist(url: string, signal?: AbortSignal): Promise<RemotePlaylist> {
    return parsePlaylist(await this.call({ method: 'POST', path: '/playlist', body: { url: url.trim() }, signal, timeoutMs: 90_000 }));
  }

  /**
   * `POST /meta/enrich {items}`: catalogue matches, one per item (null when
   * none); a weak match may carry `alternatives`. A background call, so a 401 does not prompt sign-in.
   */
  async enrich(items: EnrichQuery[], signal?: AbortSignal): Promise<(EnrichMatch | null)[]> {
    if (!items.length) return [];
    if (items.length > MAX_ENRICH_BATCH) throw new RangeError(`at most ${MAX_ENRICH_BATCH} items per call`);
    const data = await this.call({ method: 'POST', path: '/meta/enrich', body: { items }, signal, timeoutMs: 120_000, prompt: false });
    if (!isObj(data) || !Array.isArray(data['results'])) throw new ProtocolError('Unexpected enrich response from the server.');
    const results = data['results'];
    return items.map((_, i) => parseEnrichMatch(results[i]));
  }

  /** `POST /resolve {url}`: info for a pasted link. */
  async resolve(url: string, signal?: AbortSignal): Promise<RemoteSearchResult> {
    const result = parseSearchResult(
      await this.call({ method: 'POST', path: '/resolve', body: { url: url.trim() }, signal, guest: true }),
    );
    if (!result) throw new ProtocolError('Unexpected resolve response from the server.');
    return result;
  }

  /**
   * `POST /stream {url, quality?}`: a direct audio link for a page. Nothing is
   * proxied; the bytes come from the source. `quality` is omitted when
   * undefined (the server then picks the highest). Rejects with
   * {@link RemoteBusyError} on 503 or 429. `guest` is true only for playback
   * (a signed-out listener may stream); a download is a library action.
   */
  async streamUrl(pageUrl: string, signal?: AbortSignal, quality?: AudioQuality, guest = false): Promise<RemoteStream> {
    const body: { url: string; quality?: AudioQuality } = { url: pageUrl.trim() };
    if (quality) body.quality = quality;
    return parseStream(await this.call({ method: 'POST', path: '/stream', body, signal, timeoutMs: 60_000, guest }));
  }

  /** `GET /health` (no auth). Resolves when the server answers `{status:'ok'}`. */
  async health(signal?: AbortSignal): Promise<void> {
    const data = await this.call({ method: 'GET', path: '/health', auth: false, signal, timeoutMs: 10_000 });
    if (!isObj(data) || data['status'] !== 'ok') throw new ProtocolError('That URL did not answer like an Open Record server.');
  }

  /**
   * Signed-out pairing probe: `GET /health` and `GET /app-config`, both
   * unauthenticated. Resolves when the address answers like an Open Record
   * server; never sends a bearer token.
   */
  async probeServer(signal?: AbortSignal): Promise<void> {
    await this.health(signal);
    await this.appConfig(signal);
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
    /**
     * A guest-capable route (`/search`, `/resolve`, `/stream`): a signed-out
     * caller may use it when the server allows guests. Every other route is
     * never a guest route.
     */
    guest?: boolean;
    signal?: AbortSignal;
    timeoutMs?: number;
  }): Promise<unknown> {
    const authed = opts.auth !== false;
    const headers: Record<string, string> = { Accept: 'application/json', ...(authed ? await this.authHeaders() : {}) };
    // A guest call carries no bearer; the server's guest allowance covers it.
    // Only a caller with no known session is a guest: a signed-in user whose
    // token could not be obtained must see the sign-in prompt instead.
    const guest =
      opts.guest === true &&
      authed &&
      !headers['Authorization'] &&
      this.auth.signedIn?.() !== true &&
      this.auth.guestStreaming?.() === true;
    const res = await this.transport.request({
      method: opts.method,
      url: this.baseUrl + opts.path,
      headers,
      body: opts.body,
      signal: opts.signal,
      timeoutMs: opts.timeoutMs,
    });
    // A guest asking for a host the server does not allow: a plain refusal,
    // not a session problem (no prompt, and the guest flag is not stale).
    if (res.status === 403 && hasCode(res.data, GUEST_HOST_CODE)) throw new GuestHostError();
    if (res.status === 401 || res.status === 403) {
      // Only a guest 401 means the server may have turned guests off.
      if (guest) {
        if (res.status === 401) this.auth.onGuestRejected?.();
      } else if (authed && opts.prompt !== false) this.auth.onUnauthorized?.();
      throw new AuthError(res.status);
    }
    if (res.status === 429 && hasCode(res.data, GUEST_LIMIT_CODE)) throw new GuestLimitError(retryAfterSec(res.headers['retry-after']));
    // 503: resolve queue full or guest share full; 429: rate limited. Both carry Retry-After.
    if (res.status === 503 || res.status === 429) {
      throw new RemoteBusyError(retryAfterSec(res.headers['retry-after']), hasCode(res.data, GUEST_BUSY_CODE) ? GUEST_BUSY_CODE : undefined);
    }
    if (res.status < 200 || res.status >= 300) throw new HttpError(res.status, serverMessage(res.data, res.status));
    return res.data;
  }
}

const GUEST_LIMIT_CODE = 'guest_limit';
const GUEST_BUSY_CODE = 'guest_busy';
const GUEST_HOST_CODE = 'guest_host_not_allowed';

/** True when the body names `code` as its error (`error` or `code` field). */
function hasCode(data: unknown, code: string): boolean {
  return isObj(data) && (data['error'] === code || data['code'] === code);
}

/** Longest Retry-After wait trusted from the server; a bogus huge value must not stall the UI. */
const MAX_RETRY_AFTER_SEC = 300;

function retryAfterSec(raw: string | undefined): number | undefined {
  const sec = Number(raw);
  return Number.isFinite(sec) && sec >= 0 ? Math.min(sec, MAX_RETRY_AFTER_SEC) : undefined;
}

