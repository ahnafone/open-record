import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import type { Track } from '@open-record/models';
import { MusicSourceRegistry } from '@open-record/music-source';
import { StoragePort, createInMemoryStorage } from '@open-record/storage';
import {
  artistCredit,
  creditFromNames,
  type CreditLink,
} from './artist-credit';
import { ArtistsStore } from './artists.store';
import { LibraryStore } from './library.store';

const track: Track = {
  id: 'fake:a',
  providerId: 'fake',
  title: 'Hit',
  artist: 'Dj (Snake) feat. Bee',
  album: 'Album (Deluxe)',
};

/** Credits that must survive the router round-trip (slashes, %, accents, CJK). */
const tracks: Track[] = [
  track,
  {
    id: 'fake:acdc',
    providerId: 'fake',
    title: 'TNT',
    artist: 'AC/DC',
    album: 'T.N.T.',
  },
  {
    id: 'fake:pure',
    providerId: 'fake',
    title: 'Mix',
    artist: '100% Pure; Ü',
    album: 'Pure',
  },
  {
    id: 'fake:cjk',
    providerId: 'fake',
    title: '夜',
    artist: 'くるり, 中島みゆき',
    album: '夜',
  },
];

describe('artistCredit links', () => {
  it('resolve through ArtistsStore after the router round-trip', async () => {
    const registry = new MusicSourceRegistry();
    registry.register({
      id: 'fake',
      capabilities: { search: true, download: false },
      list: async () => tracks,
      search: async () => tracks,
      resolve: async (id) => ({ url: id, kind: 'bundled' }),
    });
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        { provide: StoragePort, useValue: createInMemoryStorage() },
        { provide: MusicSourceRegistry, useValue: registry },
      ],
    });
    const library = TestBed.inject(LibraryStore);
    const artists = TestBed.inject(ArtistsStore);
    const router = TestBed.inject(Router);
    await library.ready();
    for (const t of tracks) await library.toggleSaved(t.id);

    const keyOf = (link: CreditLink): string => {
      const url = router.serializeUrl(
        router.createUrlTree(link.commands ?? []),
      );
      return router.parseUrl(url).root.children['primary'].segments[1].path;
    };

    const credit = artistCredit(track.artist, track.album);
    expect(credit.artists.map((a) => a.name)).toEqual(['Dj (Snake)', 'Bee']);
    for (const link of credit.artists) {
      expect(artists.artist(keyOf(link))?.name).toBe(link.name);
    }
    expect(credit.album).not.toBeNull();
    expect(credit.album && artists.album(keyOf(credit.album))?.title).toBe(
      'Album (Deluxe)',
    );

    for (const t of tracks.slice(1)) {
      const c = artistCredit(t.artist, t.album);
      expect(c.artists.every((a) => a.commands !== null)).toBe(true);
      for (const link of c.artists) {
        expect(artists.artist(keyOf(link))?.name).toBe(link.name);
      }
      expect(c.album && artists.album(keyOf(c.album))?.title).toBe(t.album);
    }
  });

  it('plain text for an empty artist key, and creditFromNames matches artistCredit', () => {
    const plain = creditFromNames(['́'], 'Solo');
    expect(plain.artists).toEqual([{ name: '́', commands: null }]);
    expect(plain.album).toEqual({ name: 'Solo', commands: null });

    const fromTrack = artistCredit('Dj (Snake) feat. Bee', 'Album (Deluxe)');
    expect(creditFromNames(['Dj (Snake)', 'Bee'], 'Album (Deluxe)')).toEqual(
      fromTrack,
    );
  });
});
