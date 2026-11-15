import type { Track } from '@open-record/models';
import { groupByGenre } from './genre-groups';

const t = (id: string, genre?: string): Track => ({
  id,
  providerId: 'fake',
  title: id,
  artist: 'A',
  ...(genre === undefined ? {} : { genre }),
});

describe('groupByGenre', () => {
  it('skips missing genres, drops groups under the minimum, and sorts by size then name', () => {
    const tracks = [
      t('a', 'Rock'),
      t('b', '  Rock '),
      t('c', 'Jazz'),
      t('d', ''),
      t('e'),
      t('f', 'Rock'),
      t('g', 'Jazz'),
      t('h', 'Jazz'),
      t('i', 'Pop'),
      t('j', 'Pop'),
      t('k', 'Pop'),
    ];
    // Jazz, Pop and Rock all have 3 tracks (Rock counts the trimmed " Rock ").
    expect(groupByGenre(tracks)).toEqual([
      { genre: 'Jazz', trackIds: ['c', 'g', 'h'] },
      { genre: 'Pop', trackIds: ['i', 'j', 'k'] },
      { genre: 'Rock', trackIds: ['a', 'b', 'f'] },
    ]);
    // Larger groups come first, regardless of name.
    const more = [...tracks, t('l', 'Pop')];
    expect(groupByGenre(more).map((g) => g.genre)).toEqual(['Pop', 'Jazz', 'Rock']);
  });

  it('groups genres ignoring case, labelled with the first spelling seen', () => {
    const tracks = [t('a', 'Rock'), t('b', 'rock'), t('c', ' ROCK '), t('d', 'rock')];
    expect(groupByGenre(tracks)).toEqual([{ genre: 'Rock', trackIds: ['a', 'b', 'c', 'd'] }]);

    const lower = [t('a', 'rock'), t('b', 'Rock'), t('c', 'Rock')];
    expect(groupByGenre(lower)).toEqual([{ genre: 'rock', trackIds: ['a', 'b', 'c'] }]);
  });

  it('keeps input order, never repeats a track, and honours minCount', () => {
    const tracks = [t('x', 'Folk'), t('y', 'Folk'), t('x', 'Folk'), t('z', 'Folk')];
    expect(groupByGenre(tracks)).toEqual([{ genre: 'Folk', trackIds: ['x', 'y', 'z'] }]);
    expect(groupByGenre(tracks, 4)).toEqual([]);
    expect(groupByGenre(tracks.slice(0, 2), 2)).toEqual([{ genre: 'Folk', trackIds: ['x', 'y'] }]);
  });
});
