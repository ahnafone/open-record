import type { Track } from '@open-record/models';

/** Longest query we send to providers; longer input is flagged invalid. */
export const MAX_QUERY_LENGTH = 80;

/** Delay between the last keystroke and the search request. */
export const SEARCH_DEBOUNCE_MS = 250;

/**
 * Turn what the user typed into a provider query. Providers match title,
 * artist, year or genre by substring, so a decade such as "1920s" (or "1920's")
 * becomes its three-digit prefix "192", which matches every year in it.
 */
export function toProviderQuery(input: string): string {
  const q = input.trim();
  const decade = /^(\d{3})0'?s$/i.exec(q);
  return decade ? decade[1] : q;
}

/**
 * Suggestion chips drawn from the shop's own records: the most common genres
 * (up to `maxGenres`) followed by the most common decades (up to `maxDecades`).
 * Ties keep catalogue order.
 */
export function suggestionChips(
  tracks: readonly Track[],
  maxGenres = 3,
  maxDecades = 1,
): string[] {
  const genres = topByCount(tracks.map((t) => t.genre?.trim()));
  const decades = topByCount(
    tracks.map((t) =>
      t.year ? `${Math.floor(t.year / 10) * 10}s` : undefined,
    ),
  );
  return [...genres.slice(0, maxGenres), ...decades.slice(0, maxDecades)];
}

function topByCount(values: readonly (string | undefined)[]): string[] {
  const counts = new Map<string, number>();
  for (const v of values) if (v) counts.set(v, (counts.get(v) ?? 0) + 1);
  // Map keeps insertion order and Array.sort is stable, so ties keep catalogue order.
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([v]) => v);
}
