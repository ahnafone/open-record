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

  it('probes /health and /app-config without a bearer token', async () => {
    const requests: { url: string; authorization: string | undefined }[] = [];
    const transport: HttpTransport = {
      async request(req) {
        requests.push({ url: req.url, authorization: req.headers['Authorization'] });
        return req.url.endsWith('/health')
          ? { status: 200, headers: { 'content-type': 'application/json' }, data: { status: 'ok' } }
          : { status: 200, headers: { 'content-type': 'application/json' }, data: { supabaseUrl: null, supabaseAnonKey: null } };
      },
    };
    const provider = new RemoteProvider({
      config: { baseUrl: 'http://192.168.1.20:47900', token: 'legacy-static-token' },
      transport,
      accessToken: async () => 'user-token',
    });

    await provider.probeServer();

    expect(requests.map((r) => r.url)).toEqual([
      'http://192.168.1.20:47900/health',
      'http://192.168.1.20:47900/app-config',
    ]);
    expect(requests.every((r) => r.authorization === undefined)).toBe(true);
  });
});
