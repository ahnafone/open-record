import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';
import type { SupabaseConfigInput } from './types';

/**
 * Persisted desktop configuration. Only public/browser-side Supabase values
 * are stored here: the anon key is public by design and the JWT secret is an
 * optional legacy verifier. The `service_role` key must never be saved.
 */
export interface DesktopConfig {
  supabaseUrl?: string;
  supabaseAnonKey?: string;
  jwtSecret?: string;
  lanEnabled: boolean;
}

/** A validated Supabase block ready to persist and pass to the server child. */
export interface ValidatedSupabaseConfig {
  supabaseUrl: string;
  supabaseAnonKey: string;
  jwtSecret?: string;
}

/** Bad user input for the setup page. Messages are safe to show in the UI. */
export class ConfigValidationError extends Error {}

const CONFIG_FILE = 'config.json';
const MAX_URL_LENGTH = 2048;
const MAX_KEY_LENGTH = 8192;
const MAX_JWT_SECRET_LENGTH = 4096;

/** Defaults used when config.json is missing or unreadable. */
export function defaultDesktopConfig(): DesktopConfig {
  return { lanEnabled: false };
}

/** Absolute path of the desktop config file. */
export function desktopConfigPath(userData: string): string {
  return join(userData, CONFIG_FILE);
}

/**
 * Reads config.json, dropping any field that fails validation rather than
 * handing a bad key (for example `service_role`) to the server child.
 * A corrupt file falls back to defaults; the next save repairs it atomically.
 */
export function loadDesktopConfig(userData: string): DesktopConfig {
  const path = desktopConfigPath(userData);
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error(`[desktop] could not read ${path}: ${errorText(err)}`);
    }
    return defaultDesktopConfig();
  }

  // An old install or a manual edit may have left the file group/world readable.
  try {
    chmodSync(path, 0o600);
  } catch {
    // Windows ignores POSIX modes; not fatal.
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.error('[desktop] config.json is not valid JSON; using defaults');
    return defaultDesktopConfig();
  }
  if (!isRecord(parsed)) {
    console.error('[desktop] config.json is not an object; using defaults');
    return defaultDesktopConfig();
  }

  const config = defaultDesktopConfig();
  config.lanEnabled = parsed['lanEnabled'] === true;

  const url = parsed['supabaseUrl'];
  const anonKey = parsed['supabaseAnonKey'];
  if (typeof url === 'string' && typeof anonKey === 'string') {
    try {
      const validated = validateSupabaseConfig({ url, anonKey });
      config.supabaseUrl = validated.supabaseUrl;
      config.supabaseAnonKey = validated.supabaseAnonKey;
      try {
        config.jwtSecret = validateJwtSecret(parsed['jwtSecret']);
      } catch (err) {
        // A bad optional legacy secret must not disable a usable project.
        console.error(`[desktop] ignoring invalid JWT secret: ${errorText(err)}`);
      }
    } catch (err) {
      console.error(`[desktop] ignoring invalid Supabase config: ${errorText(err)}`);
    }
  }

  return config;
}

/**
 * Writes config.json mode 0600 via a temp file in the same directory plus
 * rename, so a crash cannot leave a truncated config behind.
 */
export function saveDesktopConfig(userData: string, config: DesktopConfig): void {
  const path = desktopConfigPath(userData);
  mkdirSync(userData, { recursive: true, mode: 0o700 });
  const tmp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  const body = `${JSON.stringify(config, null, 2)}\n`;

  try {
    const fd = openSync(tmp, 'wx', 0o600);
    try {
      writeSync(fd, body, null, 'utf8');
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    chmodSync(tmp, 0o600);
    renameSync(tmp, path);
  } catch (err) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      // Best effort cleanup.
    }
    throw new Error(`could not save desktop config: ${errorText(err)}`, { cause: err });
  }

  // fsync the directory so the rename survives a crash on POSIX systems.
  try {
    const dir = openSync(userData, 'r');
    try {
      fsyncSync(dir);
    } finally {
      closeSync(dir);
    }
  } catch {
    // Not supported on Windows; the rename is still atomic.
  }
}

/**
 * Validates a saveSupabaseConfig payload and returns the normalised values.
 * `url` and `anonKey` are required; `jwtSecret` is optional and may be omitted
 * or blank to clear a previously stored legacy secret.
 */
export function validateSupabaseConfig(input: unknown): ValidatedSupabaseConfig {
  if (!isRecord(input)) {
    throw new ConfigValidationError('Supabase settings must be an object.');
  }
  const url = normalizeSupabaseUrl(input['url']);
  const anonKey = validateAnonKey(input['anonKey']);
  const jwtSecret = validateJwtSecret(input['jwtSecret']);
  return jwtSecret === undefined
    ? { supabaseUrl: url, supabaseAnonKey: anonKey }
    : { supabaseUrl: url, supabaseAnonKey: anonKey, jwtSecret };
}

/** Strict http(s) URL, trailing slash removed, credentials/query/hash rejected. */
export function normalizeSupabaseUrl(raw: unknown): string {
  if (typeof raw !== 'string') {
    throw new ConfigValidationError('Supabase Project URL is required.');
  }
  const value = raw.trim();
  if (!value) throw new ConfigValidationError('Supabase Project URL is required.');
  if (value.length > MAX_URL_LENGTH) {
    throw new ConfigValidationError('Supabase Project URL is too long.');
  }
  if (/\s/.test(value)) {
    throw new ConfigValidationError('Supabase Project URL must not contain spaces.');
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new ConfigValidationError('Enter the full Supabase Project URL, for example https://abc.supabase.co.');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ConfigValidationError('Supabase Project URL must start with http:// or https://.');
  }
  if (!parsed.hostname) {
    throw new ConfigValidationError('Supabase Project URL must include a host.');
  }
  if (parsed.username || parsed.password) {
    throw new ConfigValidationError('Supabase Project URL must not contain credentials.');
  }
  if (parsed.search || parsed.hash) {
    throw new ConfigValidationError('Supabase Project URL must not contain a query string or fragment.');
  }

  const path = parsed.pathname.replace(/\/+$/, '');
  return `${parsed.origin}${path}`;
}

/**
 * Rejects the server-only Supabase credentials. Both the new `sb_secret_`
 * prefix and the legacy JWT `service_role` claim are checked, including the
 * base64url-encoded JWT payload (a plain substring scan would miss it).
 */
export function validateAnonKey(raw: unknown): string {
  if (typeof raw !== 'string') {
    throw new ConfigValidationError('Supabase anon key is required.');
  }
  const value = raw.trim();
  if (!value) throw new ConfigValidationError('Supabase anon key is required.');
  if (value.length > MAX_KEY_LENGTH) {
    throw new ConfigValidationError('Supabase anon key is too long.');
  }
  if (/\s/.test(value)) {
    throw new ConfigValidationError('Supabase anon key must not contain spaces or newlines.');
  }

  const lower = value.toLowerCase();
  if (lower.includes('service_role') || lower.startsWith('sb_secret_')) {
    throw new ConfigValidationError(
      'That is a secret/server key. Use the public anon (or publishable) key; service_role keys are never stored.',
    );
  }

  const payload = decodeJwtPayload(value);
  if (payload?.['role'] === 'service_role') {
    throw new ConfigValidationError(
      'That key grants service_role access. Use the public anon (or publishable) key instead.',
    );
  }

  return value;
}

/** Optional legacy HS256 secret: at least 32 printable characters. */
export function validateJwtSecret(raw: unknown): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'string') {
    throw new ConfigValidationError('JWT secret must be a string.');
  }
  const value = raw.trim();
  if (!value) return undefined;
  if (value.length < 32) {
    throw new ConfigValidationError('JWT secret must be at least 32 characters.');
  }
  if (value.length > MAX_JWT_SECRET_LENGTH) {
    throw new ConfigValidationError('JWT secret is too long.');
  }
  if (hasControlCharacters(value)) {
    throw new ConfigValidationError('JWT secret must not contain control characters.');
  }
  return value;
}

/** Host shown to the setup page (`abc.supabase.co`), never the URL's path. */
export function supabaseHost(config: DesktopConfig): string | null {
  if (!config.supabaseUrl) return null;
  try {
    return new URL(config.supabaseUrl).host;
  } catch {
    return null;
  }
}

function decodeJwtPayload(key: string): Record<string, unknown> | null {
  const parts = key.split('.');
  if (parts.length !== 3) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(parts[1] ?? '', 'base64url').toString('utf8'));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Re-exported for callers that build the save payload from typed input. */
export type { SupabaseConfigInput };
