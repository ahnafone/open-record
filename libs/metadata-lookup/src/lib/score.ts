import { artistSimilarity, normalizeArtist, normalizeTitle, splitArtistTitle, titleSimilarity } from './normalize';
import type { MetadataMatch, MetadataQuery } from './types';

/** Minimum combined score for a candidate to be accepted. */
export const MATCH_THRESHOLD = 0.72;
const MIN_TITLE = 0.6;
const MIN_ARTIST = 0.5;
/** Durations further apart than this are a different recording/edit. */
const MAX_DURATION_DIFF_SEC = 20;

/** 1 within 3s, falling linearly to 0 at 15s. */
function durationScore(diff: number): number {
  if (diff <= 3) return 1;
  if (diff >= 15) return 0;
  return 1 - (diff - 3) / 12;
}

export interface PreparedQuery {
  title: string;
  artist?: string;
  durationSec?: number;
}

/** Normalises the query, splitting "Artist - Title" upload titles when helpful. */
export function prepareQuery(q: MetadataQuery): PreparedQuery {
  const split = splitArtistTitle(q.title, q.artist);
  return {
    title: normalizeTitle(split.title),
    artist: split.artist ? normalizeArtist(split.artist) || undefined : undefined,
    durationSec: q.durationSec,
  };
}

/** Scores one candidate against the query (0..1), or -1 if a hard rule rejects it. */
export function scoreCandidate(q: PreparedQuery, c: MetadataMatch): number {
  const t = titleSimilarity(q.title, normalizeTitle(c.title));
  if (t < MIN_TITLE) return -1;

  const hasArtist = !!q.artist;
  const a = hasArtist ? artistSimilarity(q.artist as string, normalizeArtist(c.artist)) : 0;
  if (hasArtist && a < MIN_ARTIST) return -1;

  const hasDuration = q.durationSec !== undefined && c.durationSec !== undefined && q.durationSec > 0;
  let d = 0;
  if (hasDuration) {
    const diff = Math.abs((q.durationSec as number) - (c.durationSec as number));
    if (diff > MAX_DURATION_DIFF_SEC) return -1;
    d = durationScore(diff);
  }

  // Weights rebalance when the query lacks an artist or duration.
  const parts: [number, number][] = [[t, 0.55]];
  if (hasArtist) parts.push([a, 0.3]);
  if (hasDuration) parts.push([d, 0.15]);
  const total = parts.reduce((s, [, w]) => s + w, 0);
  let score = parts.reduce((s, [v, w]) => s + v * w, 0) / total;
  // Without an artist the title alone is weak evidence; demand more.
  if (!hasArtist) score -= 0.1;
  return score;
}

/**
 * Picks the best-scoring candidate above `MATCH_THRESHOLD`, or null. Missing
 * album/year/genre/art is filled in from another accepted candidate of the
 * same song (e.g. Deezer art plus iTunes year and genre).
 */
export function pickBest(query: MetadataQuery, candidates: MetadataMatch[]): MetadataMatch | null {
  const q = prepareQuery(query);
  if (!q.title) return null;
  const accepted = candidates
    .map((c) => ({ c, s: scoreCandidate(q, c) }))
    .filter((x) => x.s >= MATCH_THRESHOLD)
    .sort((x, y) => y.s - x.s);
  if (!accepted.length) return null;

  const best = { ...accepted[0].c };
  const bestTitle = normalizeTitle(best.title);
  const bestArtist = normalizeArtist(best.artist);
  for (const { c } of accepted.slice(1)) {
    if (normalizeTitle(c.title) !== bestTitle || artistSimilarity(normalizeArtist(c.artist), bestArtist) < 0.9) {
      continue;
    }
    best.album ??= c.album;
    best.year ??= c.year;
    best.genre ??= c.genre;
    best.artworkUrl ??= c.artworkUrl;
  }
  return best;
}
