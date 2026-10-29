import { homedir } from 'node:os';
import { join } from 'node:path';

export interface ServerConfig {
  /** TCP port to listen on. */
  port: number;
  /** Interface to bind. */
  host: string;
  /** Shared bearer token every request (except GET /health) must present. */
  token: string;
  /** Data directory: token, cast secret and upload cache all live here. */
  dataDir: string;
  /** Allowed CORS origins; `true` reflects any origin (safe: no cookies, token auth). */
  corsOrigin: true | string[];
  /** Requests per minute per client (T1.6 keys it by user/token/IP). */
  rateLimitMax: number;
  /** Trust X-Forwarded-For from a reverse proxy / tunnel. */
  trustProxy: boolean;
  /** Max yt-dlp processes running at once (search, resolve, stream). */
  maxConcurrentResolves: number;
  /** Seconds a resolved stream link is cached (capped by its own expiry). 0 disables. */
  streamCacheTtl: number;
  /** Requests per minute per token for the yt-dlp routes (/search, /stream). */
  resolveRateLimitMax: number;
  /** Cast discovery and control. False = no mDNS sockets are opened. */
  castEnabled: boolean;
  /**
   * Base URL the cast speaker uses to reach this server. Null in `loadConfig`
   * when unset; `main.ts` fills in the detected LAN URL and clears it again
   * when it is a loopback address (a speaker cannot use that).
   */
  castMediaBaseUrl: string | null;
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
}

/** Body of GET /app-config: what the web app needs to sign in with Supabase. */
export interface AppConfig {
  supabaseUrl: string | null;
  supabaseAnonKey: string | null;
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

  return {
    port: int(env, 'PORT', 8787, 1, 65535),
    host: env['HOST']?.trim() || '0.0.0.0',
    token,
    dataDir: defaultDataDir(env),
    corsOrigin: origins.length ? origins : true,
    // 600/min: 1 s polling and two tabs from one IP must not hit the old cap.
    // T1.6 re-keys this by user/token/IP; per-route limits still apply.
    rateLimitMax: int(env, 'RATE_LIMIT_MAX', 600, 1, 100_000),
    trustProxy: env['TRUST_PROXY'] === 'true' || env['TRUST_PROXY'] === '1',
    maxConcurrentResolves: int(env, 'MAX_CONCURRENT_RESOLVES', 2, 1, 16),
    streamCacheTtl: int(env, 'STREAM_CACHE_TTL', 1800, 0, 86_400),
    resolveRateLimitMax: int(env, 'RESOLVE_RATE_LIMIT_MAX', 30, 1, 100_000),
    castEnabled: bool(env, 'CAST_ENABLED', true),
    castMediaBaseUrl: httpUrl(env, 'CAST_MEDIA_BASE_URL', null),
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
  };
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
  return url && anonKey
    ? { supabaseUrl: url, supabaseAnonKey: anonKey }
    : { supabaseUrl: null, supabaseAnonKey: null };
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
