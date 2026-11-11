import type { SettingsStore } from '@open-record/state';

/** How the bundled local server is doing. */
export type DesktopServerState = 'starting' | 'ready' | 'error';

/** What the Electron main process reports about the bundled server. */
export interface DesktopStatus {
  server: DesktopServerState;
  localUrl: string;
  lanEnabled: boolean;
  lanUrl: string | null;
  supabaseConfigured: boolean;
  supabaseHost: string | null;
  dataDir: string;
  version: string;
  /**
   * Whether this build can download and install updates itself. Optional:
   * builds before auto-update did not send it.
   */
  canSelfUpdate?: boolean;
  error: string | null;
}

/** Electron auto-update bridge (`window.openRecordDesktop.updates`). */
export interface DesktopUpdatesApi {
  supported(): Promise<boolean>;
  download(): Promise<void>;
  install(): Promise<void>;
  /** Download progress 0..1. Returns an unsubscribe function. */
  onProgress(listener: (fraction: number) => void): () => void;
  /** Fired once the update is fully downloaded. Returns an unsubscribe function. */
  onDownloaded(listener: () => void): () => void;
  /** Why the previous install did not take effect, or null. Reported once per failure. */
  installError(): Promise<string | null>;
}

/** The local server's address and the static token every request must carry. */
export interface DesktopConnection {
  url: string;
  token: string;
}

/** Supabase project fields the main process saves (never echoed back). */
export interface SupabaseConfigInput {
  url: string;
  anonKey: string;
  /** Only for legacy HS256 projects; omit for current projects. */
  jwtSecret?: string;
}

/** Outcome of a desktop action; status is the fresh server state on success. */
export type ActionResult =
  | { ok: true; status: DesktopStatus }
  | { ok: false; error: string };

/** The API the Electron preload exposes at `window.openRecordDesktop`. */
export interface OpenRecordDesktopApi {
  getStatus(): Promise<DesktopStatus>;
  getConnection(): Promise<DesktopConnection>;
  saveSupabaseConfig(config: SupabaseConfigInput): Promise<ActionResult>;
  setLanEnabled(enabled: boolean): Promise<ActionResult>;
  restartServer(): Promise<ActionResult>;
  getPairing(): Promise<{ lanUrl: string | null }>;
  openGuide(): Promise<void>;
  openDataFolder(): Promise<void>;
  /** Electron auto-update. Optional so older desktop builds still load. */
  updates?: DesktopUpdatesApi;
}

declare global {
  interface Window {
    /**
     * Present only in the Electron desktop app. Optional so the web build and
     * tests never assume the bridge exists.
     */
    openRecordDesktop?: OpenRecordDesktopApi;
  }
}

/** The desktop bridge when running inside Electron; `null` on the web. */
export function getDesktopBridge(): OpenRecordDesktopApi | null {
  if (typeof window === 'undefined') return null;
  return window.openRecordDesktop ?? null;
}

/** True only when the Electron preload bridge is present. */
export function isDesktop(): boolean {
  return getDesktopBridge() !== null;
}

/** Compare saved and reported server addresses, keeping a path prefix. */
export function isSameServerUrl(a: string, b: string): boolean {
  return normalizeServerUrl(a) === normalizeServerUrl(b);
}

function normalizeServerUrl(raw: string): string | null {
  try {
    const url = new URL(raw.trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return `${url.origin}${url.pathname}`.replace(/\/+$/, '');
  } catch {
    return null;
  }
}

/** How long start-up will wait for the bridge before continuing without it. */
const CONNECTION_TIMEOUT_MS = 5000;

/**
 * Desktop bootstrap: save the bundled local server's URL + static token so
 * anonymous search and streaming work. A deliberate non-local server (e.g. a
 * self-hosted address the user entered) is never overwritten. Never throws and
 * never blocks start-up for longer than {@link CONNECTION_TIMEOUT_MS}.
 */
export async function connectDesktop(
  settings: SettingsStore,
  bridge: OpenRecordDesktopApi | null = getDesktopBridge(),
): Promise<void> {
  if (!bridge) return;
  try {
    await settings.ready();
    const connection = await withTimeout(
      bridge.getConnection(),
      CONNECTION_TIMEOUT_MS,
    );
    const url = connection.url.trim();
    if (!url) return;
    // Compare with the own server, not the effective one: in public mode the
    // effective server is the public URL, and the bundled server must still be
    // saved as the own server so switching back works.
    const saved = settings.ownServerUrl().trim();
    if (saved && !isSameServerUrl(saved, url)) return;
    const token = connection.token.trim();
    // In public mode setDownloadServer only saves the own server (no apply).
    await settings.setDownloadServer(token ? { url, token } : { url });
  } catch {
    // A missing, broken or slow bridge must never block the app from starting.
  }
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Desktop bridge timed out.')),
          ms,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
