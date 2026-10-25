import { resolve } from 'node:path';

export interface ServerConfig {
  /** TCP port to listen on. */
  port: number;
  /** Interface to bind. */
  host: string;
  /** Shared bearer token every request (except GET /health) must present. */
  token: string;
  /** Absolute path where downloads and job state are kept. */
  dataDir: string;
  /** Allowed CORS origins; `true` reflects any origin (safe: no cookies, token auth). */
  corsOrigin: true | string[];
  /** Requests per minute per client IP. */
  rateLimitMax: number;
  /** Trust X-Forwarded-For from a reverse proxy / tunnel. */
  trustProxy: boolean;
}

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
    dataDir: resolve(env['DATA_DIR']?.trim() || './data'),
    corsOrigin: origins.length ? origins : true,
    rateLimitMax: int(env, 'RATE_LIMIT_MAX', 120, 1, 100_000),
    trustProxy: env['TRUST_PROXY'] === 'true' || env['TRUST_PROXY'] === '1',
  };
}
