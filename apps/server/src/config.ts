export interface ServerConfig {
  /** TCP port to listen on. */
  port: number;
  /** Interface to bind. */
  host: string;
  /** Shared bearer token every request (except GET /health) must present. */
  token: string;
  /** Allowed CORS origins; `true` reflects any origin (safe: no cookies, token auth). */
  corsOrigin: true | string[];
  /** Requests per minute per client IP. */
  rateLimitMax: number;
  /** Trust X-Forwarded-For from a reverse proxy / tunnel. */
  trustProxy: boolean;
  /** Max yt-dlp processes running at once (search, resolve, stream). */
  maxConcurrentResolves: number;
  /** Seconds a resolved stream link is cached (capped by its own expiry). 0 disables. */
  streamCacheTtl: number;
  /** Requests per minute per token for the yt-dlp routes (/search, /stream). */
  resolveRateLimitMax: number;
  /**
   * Optional Supabase Auth: when set, a Supabase access token (JWT) is accepted
   * as a bearer credential next to the static token. Null = static token only.
   */
  supabase: SupabaseAuthConfig | null;
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
    corsOrigin: origins.length ? origins : true,
    rateLimitMax: int(env, 'RATE_LIMIT_MAX', 120, 1, 100_000),
    trustProxy: env['TRUST_PROXY'] === 'true' || env['TRUST_PROXY'] === '1',
    maxConcurrentResolves: int(env, 'MAX_CONCURRENT_RESOLVES', 2, 1, 16),
    streamCacheTtl: int(env, 'STREAM_CACHE_TTL', 1800, 0, 86_400),
    resolveRateLimitMax: int(env, 'RESOLVE_RATE_LIMIT_MAX', 30, 1, 100_000),
    supabase: supabaseConfig(env),
  };
}

function supabaseConfig(env: Env): SupabaseAuthConfig | null {
  const jwtSecret = env['SUPABASE_JWT_SECRET']?.trim() || undefined;
  const rawUrl = env['SUPABASE_URL']?.trim().replace(/\/+$/, '') || undefined;
  if (jwtSecret && jwtSecret.length < MIN_JWT_SECRET_LENGTH) {
    throw new ConfigError(`SUPABASE_JWT_SECRET must be at least ${MIN_JWT_SECRET_LENGTH} characters`);
  }
  if (rawUrl && !/^https?:\/\/[^/]+/i.test(rawUrl)) {
    throw new ConfigError('SUPABASE_URL must be an http(s) URL');
  }
  if (!jwtSecret && !rawUrl) return null;
  return {
    jwtSecret,
    jwksUrl: rawUrl ? `${rawUrl}/auth/v1/.well-known/jwks.json` : undefined,
  };
}
