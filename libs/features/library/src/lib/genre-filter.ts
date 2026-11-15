import type { Track } from '@open-record/models';
import { genreMatchKey } from '@open-record/state';

/** Normalised genre key: trimmed, lower-cased. Untagged tracks key to ''. */
export function genreKey(track: Track): string {
  return genreMatchKey(track.genre);
}

/** One genre option. `value` is the normalised key ('' = no genre). */
export interface GenreChip {
  value: string;
  label: string;
  count: number;
}

/** How many genres the control suggests while nothing is selected. */
export const GENRE_SUGGESTION_COUNT = 3;

/**
 * Library tracks with saved and imported records merged once each, so a
 * record that is both saved and imported is counted a single time.
 */
export function uniqueTracks(...lists: readonly (readonly Track[])[]): Track[] {
  const seen = new Set<string>();
  const out: Track[] = [];
  for (const list of lists) {
    for (const t of list) {
      if (seen.has(t.id)) continue;
      seen.add(t.id);
      out.push(t);
    }
  }
  return out;
}

/**
 * Genre options: each distinct genre by track count (desc, then name), then
 * "No genre" last when some tracks lack one. Matching ignores case and
 * surrounding spaces; the first spelling seen labels the option.
 */
export function genreChips(tracks: readonly Track[]): GenreChip[] {
  const byKey = new Map<string, { label: string; count: number }>();
  let untagged = 0;
  for (const t of tracks) {
    const key = genreKey(t);
    if (!key) {
      untagged++;
      continue;
    }
    const hit = byKey.get(key);
    if (hit) hit.count++;
    else byKey.set(key, { label: (t.genre ?? '').trim(), count: 1 });
  }
  const chips: GenreChip[] = [...byKey].map(([value, { label, count }]) => ({
    value,
    label,
    count,
  }));
  chips.sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  if (untagged) chips.push({ value: '', label: 'No genre', count: untagged });
  return chips;
}

/**
 * The top `limit` genres by track count, shown as suggestions. "No genre"
 * appears only when it is among the top by count.
 */
export function genreSuggestions(
  chips: readonly GenreChip[],
  limit: number = GENRE_SUGGESTION_COUNT,
): GenreChip[] {
  return [...chips].sort((a, b) => b.count - a.count).slice(0, limit);
}

/** Options whose label contains `query` (case-insensitive); all when blank. */
export function matchGenreChips(
  chips: readonly GenreChip[],
  query: string,
): readonly GenreChip[] {
  const q = query.trim().toLowerCase();
  return q ? chips.filter((c) => c.label.toLowerCase().includes(q)) : chips;
}

/** `selected` with `key` added when absent, removed when present. */
export function toggleGenreKey(
  selected: readonly string[],
  key: string,
): string[] {
  return selected.includes(key)
    ? selected.filter((k) => k !== key)
    : [...selected, key];
}

/**
 * Whether the genre control shows: some record is tagged, or a genre is
 * selected (so an active filter can always be cleared).
 */
export function genreControlVisible(
  chips: readonly GenreChip[],
  selected: readonly string[],
): boolean {
  return selected.length > 0 || chips.some((c) => c.value !== '');
}

/** `index` clamped into `[0, count - 1]`; 0 when there is nothing to index. */
export function clampActiveIndex(index: number, count: number): number {
  if (count <= 0) return 0;
  return Math.min(Math.max(index, 0), count - 1);
}

/**
 * The selection to keep given the options now offered: keys no option offers
 * any more (their tracks were removed, or the genre was untagged) are dropped,
 * so an all-stale selection becomes empty (no filter) and the list is never
 * stuck empty. Returns the same array when nothing was dropped.
 */
export function resolveGenreFilter(
  selected: readonly string[],
  chips: readonly GenreChip[],
): readonly string[] {
  const offered = new Set(chips.map((c) => c.value));
  const kept = selected.filter((k) => offered.has(k));
  return kept.length === selected.length ? selected : kept;
}

/**
 * Tracks in any of `selected` (OR). An empty selection is no filter, so the
 * input comes back as is. A '' key matches tracks without a genre.
 */
export function filterByGenre<T extends Track>(
  tracks: readonly T[],
  selected: readonly string[],
): readonly T[] {
  if (selected.length === 0) return tracks;
  const keys = new Set(selected);
  return tracks.filter((t) => keys.has(genreKey(t)));
}

/**
 * Selected genres as a phrase for status and empty copy: "Jazz or Blues".
 * Untagged is "no genre" so it reads inside a sentence.
 */
export function describeGenres(
  selected: readonly string[],
  chips: readonly GenreChip[],
): string {
  const names = selected.map(
    (k) =>
      (k === '' ? 'no genre' : chips.find((c) => c.value === k)?.label) ??
      'this genre',
  );
  return new Intl.ListFormat('en', { style: 'long', type: 'disjunction' }).format(
    names,
  );
}
