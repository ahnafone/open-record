import { TtlLru } from './cache';
import { fold } from './normalize';
import { searchDeezer, searchItunes, type FetchFn } from './providers';
import { pickBest, prepareQuery } from './score';
import type { MetadataMatch, MetadataQuery } from './types';

const HIT_TTL_MS = 24 * 60 * 60 * 1000;
const MISS_TTL_MS = 60 * 60 * 1000;
const cache = new TtlLru<MetadataMatch | null>(500);
const inflight = new Map<string, Promise<MetadataMatch | null>>();

export interface LookupOptions {
  fetch?: FetchFn;
  /** Called when one provider fails (the other may still answer). */
  onProviderError?: (source: string, error: unknown) => void;
}

function cacheKey(q: MetadataQuery): string {
  const d = q.durationSec !== undefined ? Math.round(q.durationSec) : '';
  return `${fold(q.title)}|${fold(q.artist ?? '')}|${d}`;
}

/**
 * Looks a track up on iTunes and Deezer in parallel and returns the best
 * confident match, or null. One provider failing is tolerated; if both fail
 * the error is thrown and nothing is cached.
 */
export async function lookupMetadata(q: MetadataQuery, opts: LookupOptions = {}): Promise<MetadataMatch | null> {
  const query: MetadataQuery = {
    title: q.title.trim().slice(0, 300),
    artist: q.artist?.trim().slice(0, 300) || undefined,
    durationSec: q.durationSec,
  };
  if (!query.title) return null;

  const key = cacheKey(query);
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  const pending = inflight.get(key);
  if (pending) return pending;

  const run = (async () => {
    // Search with the cleaned title/artist ("M83VEVO" + "M83 - X (Official Video)" -> "m83" + "x").
    const cleaned = prepareQuery(query);
    const term: MetadataQuery = { title: cleaned.title || query.title, artist: cleaned.artist };
    const results = await Promise.allSettled([searchItunes(term, opts.fetch), searchDeezer(term, opts.fetch)]);
    const candidates: MetadataMatch[] = [];
    results.forEach((r, i) => {
      if (r.status === 'fulfilled') candidates.push(...r.value);
      else opts.onProviderError?.(i === 0 ? 'itunes' : 'deezer', r.reason);
    });
    if (results.every((r) => r.status === 'rejected')) {
      throw new Error('metadata providers unavailable');
    }
    const match = pickBest(query, candidates);
    cache.set(key, match, match ? HIT_TTL_MS : MISS_TTL_MS);
    return match;
  })();

  inflight.set(key, run);
  try {
    return await run;
  } finally {
    inflight.delete(key);
  }
}

/** Test helper. */
export function clearMetadataCache(): void {
  cache.clear();
}
