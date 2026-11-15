import type { Track } from '@open-record/models';
import {
  clampActiveIndex,
  describeGenres,
  filterByGenre,
  genreChips,
  genreControlVisible,
  genreSuggestions,
  matchGenreChips,
  resolveGenreFilter,
  toggleGenreKey,
} from './genre-filter';

const t = (id: string, genre?: string) => ({ id, title: id, genre }) as Track;

describe('genre filter', () => {
  it('counts genres case-insensitively, ranks by count, and puts "No genre" last', () => {
    const tracks = [
      t('a', 'Jazz'),
      t('b', ' jazz '),
      t('c', 'Blues'),
      t('d'),
      t('e', ''),
    ];
    expect(genreChips(tracks)).toEqual([
      { value: 'jazz', label: 'Jazz', count: 2 },
      { value: 'blues', label: 'Blues', count: 1 },
      { value: '', label: 'No genre', count: 2 },
    ]);
    expect(filterByGenre(tracks, ['jazz']).map((x) => x.id)).toEqual(['a', 'b']);
    expect(filterByGenre(tracks, ['']).map((x) => x.id)).toEqual(['d', 'e']);
    expect(filterByGenre(tracks, [])).toBe(tracks);
  });

  it('matches any selected genre (OR), including "No genre"', () => {
    const tracks = [t('a', 'Jazz'), t('b', 'Blues'), t('c', 'Funk'), t('d')];
    expect(filterByGenre(tracks, ['jazz', 'blues']).map((x) => x.id)).toEqual([
      'a',
      'b',
    ]);
    expect(filterByGenre(tracks, ['funk', '']).map((x) => x.id)).toEqual([
      'c',
      'd',
    ]);
  });

  it('suggests the top genres by count, with "No genre" only when it ranks', () => {
    const tracks = [
      t('a', 'Jazz'),
      t('b', 'Jazz'),
      t('c', 'Blues'),
      t('d'),
      t('e'),
      t('f'),
    ];
    expect(genreSuggestions(genreChips(tracks), 2).map((c) => c.value)).toEqual([
      '',
      'jazz',
    ]);
    const many = genreChips([
      t('a', 'Jazz'),
      t('b', 'Jazz'),
      t('c', 'Blues'),
      t('d', 'Funk'),
      t('e', 'Soul'),
    ]);
    expect(genreSuggestions(many).map((c) => c.value)).toEqual(['jazz', 'blues', 'funk']);
  });

  it('filters options by case-insensitive substring of the label', () => {
    const chips = genreChips([t('a', 'Jazz'), t('b', 'Acid Jazz'), t('c')]);
    expect(matchGenreChips(chips, ' JAZ').map((c) => c.value)).toEqual([
      'acid jazz',
      'jazz',
    ]);
    expect(matchGenreChips(chips, '')).toBe(chips);
  });

  it('toggles a key in and out of the selection', () => {
    expect(toggleGenreKey([], 'jazz')).toEqual(['jazz']);
    expect(toggleGenreKey(['jazz', 'funk'], 'jazz')).toEqual(['funk']);
  });

  it('drops stale keys and falls back to no filter rather than an empty list', () => {
    const chips = genreChips([t('a', 'Jazz'), t('b', 'Jazz'), t('c')]);
    const selected = ['jazz'];
    expect(resolveGenreFilter(selected, chips)).toBe(selected); // unchanged: same reference
    expect(resolveGenreFilter(['jazz', 'blues'], chips)).toEqual(['jazz']);
    expect(resolveGenreFilter(['blues'], chips)).toEqual([]);
    expect(resolveGenreFilter([''], genreChips([t('a', 'Jazz')]))).toEqual([]); // no "No genre" left
    expect(resolveGenreFilter(['jazz'], [])).toEqual([]);
  });

  it('shows the control while any record is tagged or a genre is selected', () => {
    const untagged = genreChips([t('a')]);
    const tagged = genreChips([t('a', 'Jazz'), t('b')]);
    expect(genreControlVisible(untagged, [])).toBe(false);
    expect(genreControlVisible(untagged, ['jazz'])).toBe(true);
    expect(genreControlVisible(tagged, [])).toBe(true);
  });

  it('clamps the active index into the option range', () => {
    expect(clampActiveIndex(5, 3)).toBe(2);
    expect(clampActiveIndex(-1, 3)).toBe(0);
    expect(clampActiveIndex(1, 3)).toBe(1);
    expect(clampActiveIndex(4, 0)).toBe(0);
  });

  it('describes the selection as a phrase', () => {
    const chips = genreChips([t('a', 'Jazz'), t('b', 'Blues'), t('c')]);
    expect(describeGenres(['jazz'], chips)).toBe('Jazz');
    expect(describeGenres(['jazz', 'blues', ''], chips)).toBe(
      'Jazz, Blues, or no genre',
    );
  });
});
