import { Capacitor } from '@capacitor/core';
import type { SettingsStore } from '@open-record/state';

const HEALTH_TIMEOUT_MS = 3000;

/**
 * Web build served by the download server itself: with no server saved, the
 * page's own origin is used when it answers `GET /health` like the server
 * does. No token is involved; users sign in with their account. Native apps
 * and dev servers are left alone. Never throws.
 */
export async function autoPairWeb(settings: SettingsStore): Promise<void> {
  if (Capacitor.isNativePlatform() || typeof location === 'undefined') return;
  if (!/^https?:$/.test(location.protocol)) return;
  try {
    await settings.ready();
    if (settings.downloadServerUrl()) return;
    if (await isDownloadServer(location.origin))
      await settings.setDownloadServer({ url: location.origin });
  } catch {
    // Entering the address in Settings still works.
  }
}

async function isDownloadServer(origin: string): Promise<boolean> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), HEALTH_TIMEOUT_MS);
  try {
    const res = await fetch(`${origin}/health`, {
      signal: abort.signal,
      headers: { accept: 'application/json' },
    });
    if (!res.ok) return false;
    const body: unknown = await res.json();
    return (body as { status?: unknown } | null)?.status === 'ok';
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
