import type { Track } from '@open-record/models';
import { filterTracks } from './track-filter';

describe('filterTracks', () => {
  const t = (id: string, title: string, artist: string, album?: string) =>
    ({ id, title, artist, album }) as Track;
  const tracks = [
    t('1', 'Halo', 'Beyoncé', 'I Am... Sasha Fierce'),
    t('2', 'Hello', 'Adele', '25'),
    t('3', 'Crazy in Love', 'Beyonce'),
  ];

  it('matches every word across title, artist and album, ignoring case and accents', () => {
    expect(filterTracks(tracks, '  BEYONCE ').map((x) => x.id)).toEqual(['1', '3']);
    expect(filterTracks(tracks, 'beyoncé fierce').map((x) => x.id)).toEqual(['1']);
    expect(filterTracks(tracks, 'hello 25 adele').map((x) => x.id)).toEqual(['2']);
    expect(filterTracks(tracks, 'halo adele')).toEqual([]);
    expect(filterTracks(tracks, '   ')).toBe(tracks);
  });
});
