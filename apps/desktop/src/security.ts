import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { session, type Session } from 'electron';
import type { DesktopConfig } from './config';
import { SERVER_ORIGIN, SERVER_PORT, SERVER_HOST } from './server';

/**
 * Hosts the Angular app calls directly from the renderer for optional
 * iTunes/Deezer artist enrichment. Everything else the UI needs (search,
 * streams, metadata proxying, app-config) is same-origin through Fastify.
 * Keeping these explicit is stricter than `connect-src https:`.
 */
const METADATA_ORIGINS = ['https://itunes.apple.com', 'https://api.deezer.com'];

/** Computes a CSP builder once per launch (inline script hashes are static). */
export function createCspBuilder(
  getConfig: () => DesktopConfig,
  getLanUrl: () => string | null,
  webDir: string,
): () => string {
  const hashes = inlineScriptHashes(webDir);
  return () => buildContentSecurityPolicy(getConfig(), getLanUrl(), hashes);
}

/** Strict CSP for the Angular build, with only the hosts the app actually uses. */
export function buildContentSecurityPolicy(
  config: DesktopConfig,
  lanUrl: string | null,
  scriptHashes: readonly string[] = [],
): string {
  const connect = new Set<string>([
    "'self'",
    `http://${SERVER_HOST}:${SERVER_PORT}`,
    `ws://${SERVER_HOST}:${SERVER_PORT}`,
    `http://localhost:${SERVER_PORT}`,
    `ws://localhost:${SERVER_PORT}`,
    ...METADATA_ORIGINS,
  ]);

  if (config.lanEnabled && lanUrl) {
    connect.add(lanUrl);
    connect.add(`ws://${new URL(lanUrl).host}`);
  }

  const supabase = supabaseOrigin(config);
  if (supabase) {
    connect.add(supabase);
    // Supabase Realtime is not used today, but a future feature should not
    // require loosening the whole CSP.
    if (supabase.startsWith('https://')) connect.add(`wss://${supabase.slice('https://'.length)}`);
    else if (supabase.startsWith('http://')) connect.add(`ws://${supabase.slice('http://'.length)}`);
  }

  const script = ["'self'", ...scriptHashes.map((hash) => `'sha256-${hash}'`)];
  const directives = [
    "default-src 'self'",
    `script-src ${script.join(' ')}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' blob: data: https:",
    "font-src 'self' data:",
    "media-src 'self' blob: https:",
    `connect-src ${[...connect].join(' ')}`,
    "worker-src 'self' blob:",
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "manifest-src 'self'",
  ];
  return directives.join('; ');
}

/** Applies the (possibly changing) CSP to every response in the default session. */
export function installContentSecurityPolicy(csp: () => string): void {
  const { defaultSession } = session;
  defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const headers: Record<string, string[]> = { ...(details.responseHeaders ?? {}) };
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() === 'content-security-policy') delete headers[key];
    }
    headers['Content-Security-Policy'] = [csp()];
    callback({ responseHeaders: headers });
  });
}

/** Deny every permission request; the QR is displayed, never scanned. */
export function lockPermissions(target: Session): void {
  target.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  target.setPermissionCheckHandler(() => false);
}

/** True only for the exact fixed loopback origin. */
export function isLocalOrigin(url: string): boolean {
  try {
    return new URL(url).origin === SERVER_ORIGIN;
  } catch {
    return false;
  }
}

/** External navigation is allowed only through shell.openExternal and only https. */
export function isHttpsUrl(url: string): boolean {
  try {
    return new URL(url).protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Hash every inline `<script>` in the built index.html so Angular's Beasties
 * media shuffle (and any future bootstrap snippet) can run without enabling
 * `'unsafe-inline'` for scripts.
 */
function inlineScriptHashes(webDir: string): string[] {
  let html: string;
  try {
    html = readFileSync(join(webDir, 'index.html'), 'utf8');
  } catch {
    return [];
  }

  const hashes: string[] = [];
  const pattern = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(html)) !== null) {
    const attributes = match[1] ?? '';
    if (/\bsrc\s*=/i.test(attributes)) continue;
    const body = match[2] ?? '';
    if (!body) continue;
    hashes.push(createHash('sha256').update(body, 'utf8').digest('base64'));
  }
  return hashes;
}

function supabaseOrigin(config: DesktopConfig): string | null {
  if (!config.supabaseUrl) return null;
  try {
    return new URL(config.supabaseUrl).origin;
  } catch {
    return null;
  }
}
