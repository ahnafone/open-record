import type { Track } from '@open-record/models';

export interface GenreGroup {
  genre: string;
  trackIds: string[];
}

/**
 * Case-insensitive genre key: trimmed, lower-cased. Same key as the library
 * genre chips (`genreKey` in libs/features/library), so both agree on what
 * counts as one genre.
 */
export function genreMatchKey(genre: string | undefined): string {
  return (genre ?? '').trim().toLowerCase();
}

/**
 * Group tracks by their genre, ignoring case and surrounding spaces ("Rock",
 * " rock " are one group). Each group is labelled with the first spelling
 * seen. Tracks without a genre are skipped, groups with fewer than `minCount`
 * tracks are dropped, and the result is sorted by track count (desc) then
 * name. Track ids keep input order and appear once per group.
 */
export function groupByGenre(
  tracks: readonly Track[],
  minCount = 3,
): GenreGroup[] {
  const groups = new Map<string, { genre: string; ids: string[]; have: Set<string> }>();
  for (const track of tracks) {
    const label = track.genre?.trim();
    if (!label) continue;
    const key = genreMatchKey(label);
    let group = groups.get(key);
    if (!group) {
      group = { genre: label, ids: [], have: new Set() };
      groups.set(key, group);
    }
    if (group.have.has(track.id)) continue;
    group.have.add(track.id);
    group.ids.push(track.id);
  }
  return [...groups.values()]
    .filter((g) => g.ids.length >= minCount)
    .map((g) => ({ genre: g.genre, trackIds: g.ids }))
    .sort(
      (a, b) =>
        b.trackIds.length - a.trackIds.length || a.genre.localeCompare(b.genre),
    );
}
