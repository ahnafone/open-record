import { normalizeArtist, normalizeTitle } from './normalize';
import { pickBest } from './score';
import type { MetadataMatch } from './types';
import { isAllowedArtworkUrl } from './apply';

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

  it('only allows https artwork from the iTunes/Deezer CDNs', () => {
    expect(isAllowedArtworkUrl('https://is1-ssl.mzstatic.com/image/1000x1000bb.jpg')).toBe(true);
    expect(isAllowedArtworkUrl('http://is1-ssl.mzstatic.com/image/1000x1000bb.jpg')).toBe(false);
    expect(isAllowedArtworkUrl('https://169.254.169.254/latest')).toBe(false);
    expect(isAllowedArtworkUrl('https://is1-ssl.mzstatic.com.evil.test/a.jpg')).toBe(false);
  });
});
