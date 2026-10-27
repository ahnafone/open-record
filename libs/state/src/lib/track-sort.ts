/** Sortable record-table columns (Playlist and Library desktop tables). */
export type TrackSortKey = 'title' | 'album' | 'source' | 'added' | 'duration';

export interface TrackSort<K extends string = TrackSortKey> {
  key: K;
  dir: 'asc' | 'desc';
}

const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });

/**
 * Header click: ascending, then descending, then back to the list's own
 * order (`null`).
 */
export function nextSort<K extends string>(
  current: TrackSort<K> | null,
  key: K,
): TrackSort<K> | null {
  if (current?.key !== key) return { key, dir: 'asc' };
  return current.dir === 'asc' ? { key, dir: 'desc' } : null;
}

/** `aria-sort` for a column header; `null` when it is not the sorted one. */
export function ariaSortFor<K extends string>(
  current: TrackSort<K> | null,
  key: K,
): 'ascending' | 'descending' | null {
  if (current?.key !== key) return null;
  return current.dir === 'asc' ? 'ascending' : 'descending';
}

/** Visual arrow for a column header (`''` when unsorted). */
export function sortArrowFor<K extends string>(
  current: TrackSort<K> | null,
  key: K,
): string {
  if (current?.key !== key) return '';
  return current.dir === 'asc' ? '↑' : '↓';
}

/**
 * Sorted copy of `items` (the input when `sort` is null). Stable: ties keep
 * list order; unknown (`undefined`) values always sink, in either direction.
 */
export function sortByColumn<T, K extends string>(
  items: readonly T[],
  sort: TrackSort<K> | null,
  value: (item: T, key: K) => string | number | undefined,
): readonly T[] {
  if (!sort) return items;
  const dir = sort.dir === 'asc' ? 1 : -1;
  return [...items].sort((a, b) => {
    const av = value(a, sort.key);
    const bv = value(b, sort.key);
    if (av === undefined || bv === undefined) {
      return av === bv ? 0 : av === undefined ? 1 : -1;
    }
    const c =
      typeof av === 'number' && typeof bv === 'number'
        ? av - bv
        : collator.compare(String(av), String(bv));
    return c * dir;
  });
}
