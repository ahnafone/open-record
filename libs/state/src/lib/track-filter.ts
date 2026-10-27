import type { Track } from '@open-record/models';

/** Lower-case and strip diacritics ("Beyoncé" -> "beyonce"). */
export function normalizeSearchText(text: string): string {
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

/** Normalized "title artist album" per track object (tracks are immutable). */
const haystacks = new WeakMap<Track, string>();

function haystack(track: Track): string {
  let h = haystacks.get(track);
  if (h === undefined) {
    h = normalizeSearchText(
      `${track.title}\n${track.artist}\n${track.album ?? ''}`,
    );
    haystacks.set(track, h);
  }
  return h;
}

/** Normalized words of a filter query; empty when there is nothing to filter. */
export function filterWords(query: string): string[] {
  return normalizeSearchText(query).split(/\s+/).filter(Boolean);
}

/** Does every query word appear in the track's title, artist or album? */
export function trackMatches(track: Track, words: readonly string[]): boolean {
  if (!words.length) return true;
  const h = haystack(track);
  return words.every((w) => h.includes(w));
}

/**
 * Tracks whose title, artist or album contain every word of `query`
 * (case- and diacritics-insensitive). Returns `tracks` itself when the
 * query is blank, so memoized consumers keep their identity.
 */
export function filterTracks<T extends Track>(
  tracks: readonly T[],
  query: string,
): readonly T[] {
  const words = filterWords(query);
  return words.length ? tracks.filter((t) => trackMatches(t, words)) : tracks;
}
