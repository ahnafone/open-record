import { Capacitor, CapacitorHttp } from '@capacitor/core';
import type { MetadataFetch } from '@open-record/metadata-lookup';

const NATIVE_TIMEOUT_MS = 6000;

/**
 * Metadata lookups (iTunes, Deezer) run from the device. On native, requests go
 * through CapacitorHttp (no CORS); on the web, through `fetch`.
 */
export const metadataFetch: MetadataFetch = async (url, init) => {
  if (init?.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  if (!Capacitor.isNativePlatform()) return fetch(url, init);
  const res = await CapacitorHttp.request({
    url,
    method: 'GET',
    headers: init?.headers ?? {},
    connectTimeout: NATIVE_TIMEOUT_MS,
    readTimeout: NATIVE_TIMEOUT_MS,
  });
  const body = typeof res.data === 'string' ? res.data : JSON.stringify(res.data ?? null);
  return {
    ok: res.status >= 200 && res.status < 300,
    status: res.status,
    text: async () => body,
  };
};
