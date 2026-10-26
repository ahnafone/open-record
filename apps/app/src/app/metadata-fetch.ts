import { Capacitor, CapacitorHttp } from '@capacitor/core';
import {
  lookupMetadata,
  normalizeTitle,
  splitArtistTitle,
  titleSimilarity,
  type MetadataFetch,
} from '@open-record/metadata-lookup';
import type { ArtistLookup } from '@open-record/providers/remote';

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

/** Minimum normalised title similarity for an artist fallback match. */
const ARTIST_TITLE_MIN = 0.85;
/** Maximum duration gap (when both are known) for an artist fallback match. */
const ARTIST_DURATION_MAX_SEC = 5;

/**
 * Artist for a remote result the server returned without one: searches iTunes
 * and Deezer by the cleaned title and accepts only a confident match.
 */
export const lookupRemoteArtist: ArtistLookup = async ({ title, durationSec }) => {
  const { match } = await lookupMetadata({ title, durationSec }, metadataFetch);
  if (!match?.artist) return undefined;
  const wanted = normalizeTitle(splitArtistTitle(title).title);
  if (titleSimilarity(wanted, normalizeTitle(match.title)) < ARTIST_TITLE_MIN) return undefined;
  if (durationSec && match.durationSec && Math.abs(durationSec - match.durationSec) > ARTIST_DURATION_MAX_SEC) {
    return undefined;
  }
  return match.artist;
};
