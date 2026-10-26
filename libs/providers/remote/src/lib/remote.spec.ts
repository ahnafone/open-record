import { AuthError, RemoteClient, RemoteProvider, type HttpTransport } from '../index';

function fakeTransport(status: number, data: unknown): HttpTransport & { urls: string[]; auth: (string | undefined)[] } {
  const urls: string[] = [];
  const auth: (string | undefined)[] = [];
  return {
    urls,
    auth,
    async request(req) {
      urls.push(req.url);
      auth.push(req.headers['Authorization']);
      return { status, headers: { 'content-type': 'application/json' }, data };
    },
  };
}

describe('remote provider', () => {
  it('maps /search results to Tracks and sends the bearer token', async () => {
    const transport = fakeTransport(200, {
      results: [
        { id: 'abc', title: 'Feeling Good', artist: 'Nina Simone', durationSec: 177.6, thumbnailUrl: 'https://i.example/abc.jpg', url: 'https://www.youtube.com/watch?v=abc', site: 'youtube' },
        { id: 'broken', artist: 'No title or url' },
      ],
    });
    const provider = new RemoteProvider({ config: { baseUrl: 'https://music.example/', token: 'secret' }, transport });

    const tracks = await provider.searchSite('nina simone', 'ytmusic');

    expect(transport.urls[0]).toBe('https://music.example/search?q=nina+simone&source=ytmusic');
    expect(transport.auth[0]).toBe('Bearer secret');
    expect(tracks).toEqual([
      {
        id: 'remote:https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3Dabc',
        providerId: 'remote',
        title: 'Feeling Good',
        artist: 'Nina Simone',
        durationSec: 178,
        artUrl: 'https://i.example/abc.jpg',
        source: { site: 'youtube', url: 'https://www.youtube.com/watch?v=abc', id: 'abc' },
      },
    ]);
  });

  it('fills a missing artist from lookupArtist, falling back to Unknown artist on failure', async () => {
    const transport = fakeTransport(200, {
      results: [
        { title: 'Feeling Good', url: 'https://www.youtube.com/watch?v=a', site: 'youtube' },
        { title: 'Mystery', url: 'https://www.youtube.com/watch?v=b', site: 'youtube' },
      ],
    });
    const lookupArtist = vi.fn(async ({ title }: { title: string }) => {
      if (title === 'Mystery') throw new Error('offline');
      return 'Nina Simone';
    });
    const provider = new RemoteProvider({ config: { baseUrl: 'https://music.example' }, transport, lookupArtist });

    const tracks = await provider.searchSite('x', 'youtube');
    await provider.searchSite('x', 'youtube');

    expect(tracks.map((t) => t.artist)).toEqual(['Nina Simone', 'Unknown artist']);
    // Hits are cached per track id; failures are retried.
    expect(lookupArtist).toHaveBeenCalledTimes(3);
  });

  it('turns 401 into a typed AuthError', async () => {
    const client = new RemoteClient({ baseUrl: 'http://192.168.1.20:8080', token: 'wrong' }, fakeTransport(401, { error: 'Unauthorized' }));
    await expect(client.search('anything')).rejects.toBeInstanceOf(AuthError);
  });
});
