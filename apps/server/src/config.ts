import { homedir } from 'node:os';
import { join } from 'node:path';

export interface ServerConfig {
  /** TCP port to listen on. */
  port: number;
  /** Interface to bind. */
  host: string;
  /** Shared bearer token every request (except GET /health) must present. */
  token: string;
  /**
   * Skip the startup banner (URL, token, pairing link, QR). The desktop app
   * owns the token and passes it in the environment; printing it again would
   * leak it into child-process logs.
   */
  quietStartup: boolean;
  /** Data directory: token, cast secret and upload cache all live here. */
  dataDir: string;
  /** Allowed CORS origins; `true` reflects any origin (safe: no cookies, token auth). */
  corsOrigin: true | string[];
  /** Requests per minute per client (T1.6 keys it by user/token/IP). */
  rateLimitMax: number;
  /**
   * Trust X-Forwarded-For from a reverse proxy / tunnel: `true` trusts every
   * hop, a string limits it to those proxy IPs / CIDRs (comma list).
   */
  trustProxy: boolean | string;
  /**
   * Opt-in: honour `CF-Connecting-IP` when the TCP peer is loopback and the
   * header is a valid IP. Only safe when cloudflared is the sole path to the
   * origin: a same-host proxy that forwards unknown headers would let any client
   * pick its own rate-limit bucket. Default false.
   */
  trustCfConnectingIp: boolean;
  /** Max yt-dlp processes running at once (search, resolve, stream). */
  maxConcurrentResolves: number;
  /** Seconds a resolved stream link is cached (capped by its own expiry). 0 disables. */
  streamCacheTtl: number;
  /** Requests per minute per token for the yt-dlp routes (/search, /stream). */
  resolveRateLimitMax: number;
  /**
   * Opt-in (GUEST_STREAMING): unauthenticated callers may use /search, /resolve
   * and /stream, each client IP under the two guest limits below. Default false:
   * those routes answer 401 without a token.
   */
  guestStreaming: boolean;
  /** Guest requests per minute per client IP (burst limit). */
  guestStreamPerMinute: number;
  /** Guest requests per day per client IP (daily cap). */
  guestStreamPerDay: number;
  /** Guest requests per minute across all clients (global cap). */
  guestGlobalPerMinute: number;
  /** yt-dlp processes guests may run at once; never the last slot (see configureResolveLimits). */
  guestMaxConcurrent: number;
  /**
   * Hosts a guest may send to /resolve and /stream (lowercase, subdomains
   * included). Any other host gets 403 before the server fetches anything.
   */
  guestAllowedHosts: string[];
  /** Cast discovery and control. False = no mDNS sockets are opened. */
  castEnabled: boolean;
  /**
   * Base URL the cast speaker uses to reach this server. Null in `loadConfig`
   * when unset; `main.ts` fills in the detected LAN URL and clears it again
   * when it is a loopback address (a speaker cannot use that).
   */
  castMediaBaseUrl: string | null;
  /**
   * Port of a separate listener that serves ONLY `GET /cast/relay/:token`
   * (CAST_RELAY_PORT). Set it so speakers can reach the relay on the LAN while
   * the main API stays on loopback behind the tunnel. Null = the relay is served
   * by the main listener only (the pre-split behaviour).
   */
  castRelayPort: number | null;
  /** Interface the cast relay listener binds (CAST_RELAY_HOST). Default 0.0.0.0. */
  castRelayHost: string;
  /** Relay token TTL in seconds; slid while the cast session is active. */
  castRelayTtlSec: number;
  /** Per-user upload cache cap in MB. 0 disables uploads. */
  castCacheMb: number;
  /** Largest accepted upload in MB. */
  castUploadMaxMb: number;
  /** Session routes (REST + websocket). False = they are not registered. */
  sessionEnabled: boolean;
  /** Drop an idle session room after this many minutes. */
  sessionIdleTimeoutMin: number;
  /** Pause/clear a target after this many minutes without contact. */
  sessionTargetStaleMin: number;
  /** Transcode fallback binary (name on PATH or absolute path). */
  ffmpegPath: string;
  /** Optional Netscape cookies.txt handed to yt-dlp (age-restricted videos, bot checks). */
  ytdlpCookiesFile: string | null;
  /**
   * Optional Supabase Auth: when set, a Supabase access token (JWT) is accepted
   * as a bearer credential next to the static token. Null = static token only.
   */
  supabase: SupabaseAuthConfig | null;
  /** Built web app to serve at `/` (public, SPA fallback). Null = API only. */
  webDir: string | null;
  /**
   * Public client config served by GET /app-config (no token). Both null unless
   * SUPABASE_URL and SUPABASE_ANON_KEY are set. Never holds the JWT secret.
   */
  appConfig: AppConfig;
  /** Supabase project URL (no trailing slash); null when SUPABASE_URL is unset. */
  supabaseUrl: string | null;
  /**
   * Admin approval gate (public mode). When true, a Supabase user may use the
   * API only with an `approved` row in `public.access_requests` or as
   * `adminUserId`. Default false: self-hosters are unaffected.
   */
  requireApproval: boolean;
  /**
   * Service-role key, used only server-side to read `access_requests`. Never
   * sent to clients, never logged. Required when `requireApproval` is true.
   */
  supabaseServiceRoleKey: string | null;
  /** Supabase user id (UUID, lowercase) that bypasses the approval gate. */
  adminUserId: string | null;
}

/** Body of GET /app-config: what the web app needs to sign in with Supabase. */
export interface AppConfig {
  supabaseUrl: string | null;
  supabaseAnonKey: string | null;
  /** Public Cloudflare Turnstile site key; null when TURNSTILE_SITE_KEY is unset. */
  turnstileSiteKey: string | null;
}

/** Public part of GET /app-config: the config above plus the guest-streaming switch. */
export interface PublicAppConfig extends AppConfig {
  /** True when GUEST_STREAMING is on: signed-out callers may use /search, /resolve, /stream. */
  guestStreaming: boolean;
}

export interface SupabaseAuthConfig {
  /** Legacy shared JWT secret (HS256). */
  jwtSecret?: string;
  /** JWKS endpoint for asymmetric signing keys (ES256/RS256), from SUPABASE_URL. */
  jwksUrl?: string;
}

/** Supabase JWT secrets are at least 32 characters. */
export const MIN_JWT_SECRET_LENGTH = 32;

export const MIN_TOKEN_LENGTH = 16;

export class ConfigError extends Error {}

type Env = Record<string, string | undefined>;

function int(env: Env, key: string, fallback: number, min: number, max: number): number {
  const raw = env[key]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new ConfigError(`${key} must be an integer between ${min} and ${max}`);
  }
  return n;
}

/** Strict boolean: `true`/`1` and `false`/`0`, case-insensitive. */
function bool(env: Env, key: string, fallback: boolean): boolean {
  const raw = env[key]?.trim();
  if (!raw) return fallback;
  const value = raw.toLowerCase();
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  throw new ConfigError(`${key} must be true, false, 1 or 0`);
}

/** `true`/`1` and `false`/`0`/blank as booleans; anything else is a trusted proxy IP / CIDR list. */
function trustProxy(raw: string | undefined): boolean | string {
  const value = raw?.trim() ?? '';
  const lower = value.toLowerCase();
  if (lower === 'true' || lower === '1') return true;
  if (!value || lower === 'false' || lower === '0') return false;
  return value;
}

/** Media sites guests may use by default: the supported sources, nothing else. */
export const DEFAULT_GUEST_HOSTS = [
  'youtube.com',
  'youtu.be',
  'music.youtube.com',
  'soundcloud.com',
  'bandcamp.com',
];

const HOSTNAME = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;

/**
 * GUEST_ALLOWED_HOSTS: comma list of hostnames (subdomains included). Blank or
 * unset keeps the defaults. Entries must be plain hostnames (no scheme, path,
 * port or wildcard); anything else is a config error.
 */
function guestAllowedHosts(env: Env): string[] {
  const raw = env['GUEST_ALLOWED_HOSTS']?.trim();
  if (!raw) return [...DEFAULT_GUEST_HOSTS];
  const hosts = raw
    .split(',')
    .map((h) => h.trim().toLowerCase().replace(/\.$/, ''))
    .filter(Boolean);
  for (const host of hosts) {
    if (!HOSTNAME.test(host)) {
      throw new ConfigError('GUEST_ALLOWED_HOSTS must be a comma list of hostnames, e.g. youtube.com,soundcloud.com');
    }
  }
  return [...new Set(hosts)];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Optional UUID, lowercased. Invalid values are a config error. */
function uuid(env: Env, key: string): string | null {
  const raw = env[key]?.trim();
  if (!raw) return null;
  if (!UUID.test(raw)) throw new ConfigError(`${key} must be a UUID`);
  return raw.toLowerCase();
}

/** Optional http(s) URL, trailing slashes trimmed. Invalid values are a config error. */
function httpUrl(env: Env, key: string, fallback: string | null): string | null {
  const raw = env[key]?.trim().replace(/\/+$/, '');
  if (!raw) return fallback;
  if (!/^https?:\/\/[^/]+/i.test(raw)) {
    throw new ConfigError(`${key} must be an http(s) URL`);
  }
  return raw;
}

/**
 * Default data directory: `OPEN_RECORD_DATA_DIR`, else `~/.config/open-record`.
 * Lives here (not in token-store) so `loadConfig` can resolve it without a cycle.
 */
export function defaultDataDir(env: Env): string {
  const fromEnv = env['OPEN_RECORD_DATA_DIR']?.trim();
  return fromEnv || join(homedir(), '.config', 'open-record');
}

/** Reads and validates server configuration from environment variables. */
export function loadConfig(env: Env = process.env): ServerConfig {
  const token = env['OPEN_RECORD_TOKEN']?.trim() ?? '';
  if (!token) {
    throw new ConfigError('OPEN_RECORD_TOKEN is required');
  }
  if (token.length < MIN_TOKEN_LENGTH) {
    throw new ConfigError(`OPEN_RECORD_TOKEN must be at least ${MIN_TOKEN_LENGTH} characters`);
  }

  const origins = (env['CORS_ORIGINS'] ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);

  const port = int(env, 'PORT', 8787, 1, 65535);
  const castRelayPort = env['CAST_RELAY_PORT']?.trim() ? int(env, 'CAST_RELAY_PORT', 8788, 1, 65535) : null;
  if (castRelayPort !== null && castRelayPort === port) {
    throw new ConfigError('CAST_RELAY_PORT must differ from PORT');
  }

  return {
    port,
    host: env['HOST']?.trim() || '0.0.0.0',
    token,
    quietStartup: bool(env, 'OPEN_RECORD_QUIET_STARTUP', false),
    dataDir: defaultDataDir(env),
    corsOrigin: origins.length ? origins : true,
    // 600/min: 1 s polling and two tabs from one IP must not hit the old cap.
    // T1.6 re-keys this by user/token/IP; per-route limits still apply.
    rateLimitMax: int(env, 'RATE_LIMIT_MAX', 600, 1, 100_000),
    trustProxy: trustProxy(env['TRUST_PROXY']),
    trustCfConnectingIp: bool(env, 'TRUST_CF_CONNECTING_IP', false),
    maxConcurrentResolves: int(env, 'MAX_CONCURRENT_RESOLVES', 2, 1, 16),
    streamCacheTtl: int(env, 'STREAM_CACHE_TTL', 1800, 0, 86_400),
    resolveRateLimitMax: int(env, 'RESOLVE_RATE_LIMIT_MAX', 30, 1, 100_000),
    guestStreaming: bool(env, 'GUEST_STREAMING', false),
    guestStreamPerMinute: int(env, 'GUEST_STREAM_PER_MINUTE', 10, 1, 100_000),
    guestStreamPerDay: int(env, 'GUEST_STREAM_PER_DAY', 100, 1, 1_000_000),
    guestGlobalPerMinute: int(env, 'GUEST_GLOBAL_PER_MINUTE', 60, 1, 1_000_000),
    guestMaxConcurrent: int(env, 'GUEST_MAX_CONCURRENT', 1, 1, 16),
    guestAllowedHosts: guestAllowedHosts(env),
    castEnabled: bool(env, 'CAST_ENABLED', true),
    castMediaBaseUrl: httpUrl(env, 'CAST_MEDIA_BASE_URL', null),
    castRelayPort,
    castRelayHost: env['CAST_RELAY_HOST']?.trim() || '0.0.0.0',
    castRelayTtlSec: int(env, 'CAST_RELAY_TTL_SEC', 900, 60, 86_400),
    castCacheMb: int(env, 'CAST_CACHE_MB', 2048, 0, 1_048_576),
    castUploadMaxMb: int(env, 'CAST_UPLOAD_MAX_MB', 200, 1, 4096),
    sessionEnabled: bool(env, 'SESSION_ENABLED', true),
    sessionIdleTimeoutMin: int(env, 'SESSION_IDLE_TIMEOUT_MIN', 120, 1, 1440),
    sessionTargetStaleMin: int(env, 'SESSION_TARGET_STALE_MIN', 30, 1, 1440),
    ffmpegPath: env['FFMPEG_PATH']?.trim() || 'ffmpeg',
    // Never validated here: a missing or unreadable file only disables cookies,
    // so a stale path in an old .env cannot stop the server from starting.
    ytdlpCookiesFile: env['YTDLP_COOKIES_FILE']?.trim() || null,
    supabase: supabaseConfig(env),
    webDir: env['WEB_DIR']?.trim() || null,
    appConfig: appConfig(env),
    supabaseUrl: supabaseUrl(env) ?? null,
    ...approvalConfig(env),
  };
}

/**
 * Public-mode approval gate. Every missing-value error names the variable only,
 * never its value: the service-role key must not reach logs or error output.
 */
function approvalConfig(env: Env): Pick<
  ServerConfig,
  'requireApproval' | 'supabaseServiceRoleKey' | 'adminUserId'
> {
  const requireApproval = bool(env, 'REQUIRE_APPROVAL', false);
  const supabaseServiceRoleKey = env['SUPABASE_SERVICE_ROLE_KEY']?.trim() || null;
  const adminUserId = uuid(env, 'ADMIN_USER_ID');
  if (requireApproval && (!supabaseUrl(env) || !supabaseServiceRoleKey)) {
    throw new ConfigError(
      'REQUIRE_APPROVAL=true needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY',
    );
  }
  return { requireApproval, supabaseServiceRoleKey, adminUserId };
}

const supabaseUrl = (env: Env): string | undefined => {
  const url = env['SUPABASE_URL']?.trim().replace(/\/+$/, '') || undefined;
  if (url && !/^https?:\/\/[^/]+/i.test(url)) {
    throw new ConfigError('SUPABASE_URL must be an http(s) URL');
  }
  return url;
};

/**
 * Public Supabase client config. The anon key is public by design; it only
 * makes sense with SUPABASE_URL, so a key without a URL is a config error.
 * A URL without a key is valid (JWKS verification only) and serves nulls.
 */
function appConfig(env: Env): AppConfig {
  const url = supabaseUrl(env);
  const anonKey = env['SUPABASE_ANON_KEY']?.trim() || undefined;
  if (anonKey && !url) {
    throw new ConfigError('SUPABASE_ANON_KEY needs SUPABASE_URL');
  }
  const turnstileSiteKey = env['TURNSTILE_SITE_KEY']?.trim() || null;
  return url && anonKey
    ? { supabaseUrl: url, supabaseAnonKey: anonKey, turnstileSiteKey }
    : { supabaseUrl: null, supabaseAnonKey: null, turnstileSiteKey };
}

function supabaseConfig(env: Env): SupabaseAuthConfig | null {
  const jwtSecret = env['SUPABASE_JWT_SECRET']?.trim() || undefined;
  const rawUrl = supabaseUrl(env);
  if (jwtSecret && jwtSecret.length < MIN_JWT_SECRET_LENGTH) {
    throw new ConfigError(`SUPABASE_JWT_SECRET must be at least ${MIN_JWT_SECRET_LENGTH} characters`);
  }
  if (!jwtSecret && !rawUrl) return null;
  return {
    jwtSecret,
    jwksUrl: rawUrl ? `${rawUrl}/auth/v1/.well-known/jwks.json` : undefined,
  };
}
