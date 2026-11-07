import { TtlLru } from './cache';
import { fold } from './normalize';
import { searchDeezer, searchItunes, type MetadataFetch } from './providers';
import { pickBest, prepareQuery } from './score';
import type { MetadataMatch, MetadataQuery } from './types';

const HIT_TTL_MS = 24 * 60 * 60 * 1000;
const MISS_TTL_MS = 60 * 60 * 1000;
/** Any answer given while a provider failed: retry soon instead of remembering it for hours. */
const PARTIAL_TTL_MS = 60 * 1000;
const cache = new TtlLru<MetadataMatch | null>(500);
const inflight = new Map<string, Promise<MetadataMatch | null>>();

export interface MetadataLookupResult {
  match: MetadataMatch | null;
}

function cacheKey(q: MetadataQuery): string {
  const d = q.durationSec !== undefined ? Math.round(q.durationSec) : '';
  return `${fold(q.title)}|${fold(q.artist ?? '')}|${d}`;
}

/**
 * Looks a track up on iTunes and Deezer in parallel with the injected `fetchFn`
 * and returns the best confident match as `{ match }` (match is null when
 * nothing clears the threshold). One provider failing is tolerated; if both
 * fail the call rejects and nothing is cached.
 */
export async function lookupMetadata(q: MetadataQuery, fetchFn: MetadataFetch): Promise<MetadataLookupResult> {
  const query: MetadataQuery = {
    title: q.title.trim().slice(0, 300),
    artist: q.artist?.trim().slice(0, 300) || undefined,
    durationSec: q.durationSec,
  };
  if (!query.title) return { match: null };

  const key = cacheKey(query);
  const cached = cache.get(key);
  if (cached !== undefined) return { match: cached };
  const pending = inflight.get(key);
  if (pending) return { match: await pending };

  const run = (async () => {
    // Search with the cleaned title/artist ("M83VEVO" + "M83 - X (Official Video)" -> "m83" + "x").
    const cleaned = prepareQuery(query);
    const term: MetadataQuery = { title: cleaned.title || query.title, artist: cleaned.artist };
    const results = await Promise.allSettled([searchItunes(term, fetchFn), searchDeezer(term, fetchFn)]);
    const candidates: MetadataMatch[] = [];
    for (const r of results) {
      if (r.status === 'fulfilled') candidates.push(...r.value);
    }
    if (results.every((r) => r.status === 'rejected')) {
      throw new Error('metadata providers unavailable');
    }
    const match = pickBest(query, candidates);
    // A provider failed (429, timeout), so this answer may be incomplete (a
    // missing match, or a match that the failed provider would have beaten):
    // keep it only briefly and let the next lookup retry.
    const partial = results.some((r) => r.status === 'rejected');
    cache.set(key, match, partial ? PARTIAL_TTL_MS : match ? HIT_TTL_MS : MISS_TTL_MS);
    return match;
  })();

  inflight.set(key, run);
  try {
    return { match: await run };
  } finally {
    inflight.delete(key);
  }
}
