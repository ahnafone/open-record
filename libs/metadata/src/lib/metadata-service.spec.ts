import { MetadataHttp } from './http';
import { MetadataService } from './metadata-service';
import { RateLimiter } from './rate-limiter';

const recording = (id: string, title: string, length: number, score: number) => ({
  id,
  title,
  length,
  score,
  'first-release-date': '1976-10-31',
  'artist-credit': [{ name: 'Queen', joinphrase: '', artist: { id: 'a-queen', name: 'Queen' } }],
  releases: [
    { id: 'rel-live', title: 'Live Killers', status: 'Official', 'release-group': { id: 'rg-live' } },
    { id: 'rel-anato', title: 'A Night at the Opera', status: 'Official', date: '1975-11-21', 'release-group': { id: 'rg-anato', 'primary-type': 'Album' } },
  ],
  tags: [{ name: 'Rock', count: 3 }, { name: 'progressive rock', count: 5 }],
});

class FakeHttp implements MetadataHttp {
  readonly available = true;
  urls: string[] = [];
  async getJson(url: string) {
    this.urls.push(url);
    if (url.includes('/recording?')) {
      return {
        status: 200,
        data: {
          recordings: [
            recording('rec-live', 'Bohemian Rhapsody (live)', 420000, 100),
            recording('rec-studio', 'Bohemian Rhapsody', 354000, 95),
            { bogus: true },
          ],
        },
      };
    }
    throw new Error('offline');
  }
  async getBytes(url: string) {
    this.urls.push(url);
    return { status: 200, data: new Uint8Array([1, 2, 3]).buffer, contentType: 'image/jpeg' };
  }
}

describe('MetadataService', () => {
  it('parses results, scores by duration and fetches cover art', async () => {
    const http = new FakeHttp();
    const service = new MetadataService(http, { limiter: new RateLimiter(0) });

    const results = await service.searchRecordings('bohemian');
    expect(results.map((r) => r.recordingMbid)).toEqual(['rec-live', 'rec-studio']);
    expect(results[1]).toMatchObject({ artist: 'Queen', artistMbids: ['a-queen'], year: 1976, genres: ['progressive rock', 'rock'] });

    const match = await service.enrich({ title: 'Bohemian Rhapsody', artist: 'Queen', album: 'A Night at the Opera', durationMs: 355000 });
    expect(match).toMatchObject({ recordingMbid: 'rec-studio', releaseMbid: 'rel-anato', album: 'A Night at the Opera' });
    expect(match?.coverArt?.bytes.byteLength).toBe(3);
    expect(http.urls.at(-1)).toBe('https://coverartarchive.org/release/rel-anato/front-500');

    expect(await service.enrich({ title: 'Something Else', artist: 'Nobody' })).toBeNull();
    const offline = Object.assign(Object.create(http) as MetadataHttp, { available: false });
    expect(await new MetadataService(offline).searchRecordings('x')).toEqual([]);
  });

  it('spaces queued requests by the interval, even after failures', async () => {
    let t = 0;
    const starts: number[] = [];
    const limiter = new RateLimiter(1000, { now: () => t, sleep: async (ms) => void (t += ms) });
    const tasks = [0, 1, 2].map((i) =>
      limiter.schedule(async () => {
        starts.push(t);
        if (i === 0) throw new Error('boom');
      }),
    );
    await Promise.allSettled(tasks);
    expect(starts).toEqual([0, 1000, 2000]);
  });
});
