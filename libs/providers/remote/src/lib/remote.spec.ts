import { AuthError, NetworkError, RemoteClient, RemoteProvider, createFetchTransport, toRemoteTrack, type HttpTransport } from '../index';
import { isMusicFallback } from './remote-provider';

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

/** Real-shaped 11-char YouTube video ids (the dedup key parses them). */
const ID = {
  a: 'dQw4w9WgXcQ',
  b: 'jNQXAC9IVRw',
  c: 'kJQP7kiw5Fk',
  d: 'Zi_XLOBDo_Y',
  e: 'M7lc1UVf-VE',
  f: 'aqz-KE-bpKQ',
};

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

  describe('search fallback', () => {
    const musicHit = (id: string, title: string) => ({
      id,
      title,
      artist: 'A',
      url: `https://music.youtube.com/watch?v=${id}`,
      site: 'ytmusic',
    });
    const ytHit = (id: string, title: string, durationSec?: number) => ({
      id,
      title,
      artist: 'A',
      url: `https://www.youtube.com/watch?v=${id}`,
      site: 'youtube',
      ...(durationSec === undefined ? {} : { durationSec }),
    });
    /** Transport that answers per `source`; `ytmusic`/`youtube` may be a status error. */
    const bySource = (answers: Record<string, { status: number; data: unknown }>) => {
      const sources: string[] = [];
      const transport: HttpTransport = {
        async request(req) {
          const source = new URL(req.url).searchParams.get('source') ?? '';
          sources.push(source);
          const answer = answers[source] ?? { status: 200, data: { results: [] } };
          return { status: answer.status, headers: { 'content-type': 'application/json' }, data: answer.data };
        },
      };
      return { sources, transport };
    };
    const ok = (results: unknown[]) => ({ status: 200, data: { results } });

    it('searches YT Music first, falls back to YouTube only when it is short, drops non-music hits and dedups the same video across both', async () => {
      const { sources, transport } = bySource({
        ytmusic: ok([musicHit(ID.a, 'Song 1'), musicHit(ID.b, 'Song 2')]),
        youtube: ok([
          ytHit(ID.a, 'Song 1'),
          ytHit(ID.c, 'Song 3', 200),
          ytHit(ID.d, 'Full Album 2001', 3000),
          ytHit(ID.e, 'Reaction to Song 1', 300),
          ytHit(ID.f, 'Song 4'),
        ]),
      });
      const provider = new RemoteProvider({ config: { baseUrl: 'https://music.example' }, transport });

      const tracks = await provider.search('song');

      expect(sources).toEqual(['ytmusic', 'youtube']);
      expect(tracks.map((t) => t.title)).toEqual(['Song 1', 'Song 2', 'Song 3', 'Song 4']);
    });

    it('makes no YouTube call when YT Music has enough results', async () => {
      const { sources, transport } = bySource({
        ytmusic: ok([musicHit('m1', 'Song 1'), musicHit('m2', 'Song 2'), musicHit('m3', 'Song 3')]),
      });
      const provider = new RemoteProvider({ config: { baseUrl: 'https://music.example' }, transport });

      const tracks = await provider.search('song');

      expect(sources).toEqual(['ytmusic']);
      expect(tracks).toHaveLength(3);
    });

    it('falls back to YouTube when YT Music fails with a server error', async () => {
      const { sources, transport } = bySource({
        ytmusic: { status: 500, data: { error: 'boom' } },
        youtube: ok([ytHit('y1', 'Song 1')]),
      });
      const provider = new RemoteProvider({ config: { baseUrl: 'https://music.example' }, transport });

      const tracks = await provider.search('song');

      expect(sources).toEqual(['ytmusic', 'youtube']);
      expect(tracks.map((t) => t.title)).toEqual(['Song 1']);
    });

    it('rethrows AuthError from YT Music without trying YouTube', async () => {
      const { sources, transport } = bySource({
        ytmusic: { status: 401, data: { error: 'Unauthorized' } },
        youtube: ok([ytHit('y1', 'Song 1')]),
      });
      const provider = new RemoteProvider({ config: { baseUrl: 'https://music.example' }, transport });

      await expect(provider.search('song')).rejects.toBeInstanceOf(AuthError);
      expect(sources).toEqual(['ytmusic']);
    });

    it('goes straight to defaultSite when it is not YT Music', async () => {
      const { sources, transport } = bySource({ youtube: ok([ytHit('y1', 'Song 1')]) });
      const provider = new RemoteProvider({ config: { baseUrl: 'https://music.example' }, transport, defaultSite: 'youtube' });

      const tracks = await provider.search('song');

      expect(sources).toEqual(['youtube']);
      expect(tracks.map((t) => t.title)).toEqual(['Song 1']);
    });

    it('judges fallback hits by duration and title, not by substrings of ordinary words', () => {
      const track = (title: string, durationSec?: number) =>
        toRemoteTrack({ id: title, title, artist: 'A', url: 'https://www.youtube.com/watch?v=x', site: 'youtube', durationSec });
      expect(isMusicFallback(track('Song', 600))).toBe(true);
      expect(isMusicFallback(track('Song', 601))).toBe(false);
      expect(isMusicFallback(track('Song'))).toBe(true);
      expect(isMusicFallback(track('Chain Reaction'))).toBe(true);
      expect(isMusicFallback(track('24 Hours'))).toBe(true);
      expect(isMusicFallback(track('10 Hours of Rain Ambience'))).toBe(false);
    });
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

  it('maps a body-read timeout to NetworkError, not a bare AbortError (so imports do not read it as a cancel)', async () => {
    const stalledFetch = (async () => ({
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      text: async () => {
        throw new DOMException('The operation was aborted.', 'AbortError');
      },
    })) as unknown as typeof fetch;
    const transport = createFetchTransport(stalledFetch);
    await expect(transport.request({ method: 'GET', url: 'https://music.example/search', headers: {} })).rejects.toBeInstanceOf(NetworkError);
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
