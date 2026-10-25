import { lookupMetadata } from './lookup';
import { normalizeArtist, normalizeTitle } from './normalize';
import { pickBest } from './score';
import type { MetadataFetch } from './providers';
import type { MetadataMatch } from './types';

const song = (over: Partial<MetadataMatch>): MetadataMatch => ({
  title: 'Midnight City',
  artist: 'M83',
  source: 'itunes',
  ...over,
});

describe('metadata matching', () => {
  it('strips upload noise from titles and artists', () => {
    expect(normalizeTitle('Midnight City (Official Video) [HD]')).toBe('midnight city');
    expect(normalizeTitle('Señorita (feat. Someone) [Lyrics]')).toBe('senorita');
    expect(normalizeTitle('Get Lucky ft. Pharrell Williams')).toBe('get lucky');
    expect(normalizeArtist('M83 - Topic')).toBe('m83');
    expect(normalizeArtist('M83VEVO')).toBe('m83');
  });

  it('picks the right candidate from a messy upload title', () => {
    const candidates = [
      song({ title: 'Midnight City (Live)', durationSec: 300, album: 'Live' }),
      song({ title: 'Midnight City', artist: 'Some Cover Band', durationSec: 244 }),
      song({ title: 'Midnight City', durationSec: 244, album: 'Hurry Up, We\'re Dreaming', year: 2011 }),
      song({ title: 'Midnight City', durationSec: 243, source: 'deezer', artworkUrl: 'https://e-cdns-images.dzcdn.net/x/1000x1000.jpg' }),
    ];
    const best = pickBest({ title: 'M83 - Midnight City (Official Video)', artist: 'M83VEVO', durationSec: 245 }, candidates);
    expect(best?.album).toBe("Hurry Up, We're Dreaming");
    expect(best?.year).toBe(2011);
    expect(best?.artworkUrl).toContain('dzcdn.net');
  });

  it('rejects poor matches', () => {
    const candidates = [
      song({ title: 'Midnight Train', artist: 'Someone Else', durationSec: 200 }),
      song({ title: 'Midnight City', artist: 'M83', durationSec: 400 }),
    ];
    expect(pickBest({ title: 'Midnight City', artist: 'M83', durationSec: 244 }, candidates)).toBeNull();
    expect(pickBest({ title: 'Totally Different Song', artist: 'M83' }, [song({})])).toBeNull();
  });
});

describe('lookupMetadata', () => {
  it('uses the injected fetch, tolerates one failing provider and upsizes iTunes art', async () => {
    const urls: string[] = [];
    const fetchFn: MetadataFetch = async (url) => {
      urls.push(url);
      if (url.startsWith('https://itunes.apple.com/')) {
        const body = {
          results: [
            {
              trackName: 'Lookup Test Song',
              artistName: 'Test Artist',
              collectionName: 'Test Album',
              releaseDate: '2001-01-01T00:00:00Z',
              primaryGenreName: 'Rock',
              trackTimeMillis: 200000,
              artworkUrl100: 'https://is1-ssl.mzstatic.com/image/thumb/a/100x100bb.jpg',
            },
          ],
        };
        return { ok: true, status: 200, text: async () => JSON.stringify(body) };
      }
      return { ok: false, status: 500, text: async () => '' };
    };

    const { match } = await lookupMetadata({ title: 'Lookup Test Song', artist: 'Test Artist', durationSec: 200 }, fetchFn);
    expect(urls).toHaveLength(2);
    expect(match).toMatchObject({
      title: 'Lookup Test Song',
      artist: 'Test Artist',
      album: 'Test Album',
      year: 2001,
      genre: 'Rock',
      artworkUrl: 'https://is1-ssl.mzstatic.com/image/thumb/a/1000x1000bb.jpg',
      source: 'itunes',
    });
  });

  it('rejects when both providers fail', async () => {
    const fetchFn: MetadataFetch = async () => ({ ok: false, status: 503, text: async () => '' });
    await expect(lookupMetadata({ title: 'Down Song' }, fetchFn)).rejects.toThrow('metadata providers unavailable');
  });
});
