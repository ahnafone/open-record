import { RemoteProvider, remoteTrackId, type HttpTransport } from '../index';

function streamTransport(): HttpTransport & { posts: number } {
  const transport = {
    posts: 0,
    async request(req: { method?: string; url: string }) {
      if (req.url.endsWith('/stream')) {
        transport.posts++;
        return {
          status: 200,
          headers: { 'content-type': 'application/json' },
          data: {
            url: 'https://cdn.example/stream.m4a',
            mimeType: 'audio/mp4',
            expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
            track: { title: 'Song', artist: 'Artist' },
          },
        };
      }
      return { status: 404, headers: { 'content-type': 'application/json' }, data: {} };
    },
  };
  return transport;
}

describe('remote provider resolve', () => {
  const pageUrl = 'https://www.youtube.com/watch?v=abc';
  const trackId = remoteTrackId(pageUrl);

  it('prefers the saved local file over the stream link', async () => {
    const transport = streamTransport();
    const provider = new RemoteProvider({
      config: { baseUrl: 'https://music.example', token: 't' },
      transport,
      lookupSavedFile: async () => 'file:///data/imported/remote-x.audio.m4a',
    });

    const source = await provider.resolve(trackId);

    expect(source).toEqual({ url: 'file:///data/imported/remote-x.audio.m4a', kind: 'file', mimeType: 'audio/mp4' });
    expect(transport.posts).toBe(0);
  });

  it('falls back to a cached stream link when nothing is saved', async () => {
    const transport = streamTransport();
    const provider = new RemoteProvider({
      config: { baseUrl: 'https://music.example', token: 't' },
      transport,
      lookupSavedFile: async () => undefined,
    });

    const first = await provider.resolve(trackId);
    const second = await provider.resolve(trackId);

    expect(first).toEqual({ url: 'https://cdn.example/stream.m4a', kind: 'remote', mimeType: 'audio/mp4' });
    expect(second).toEqual(first);
    expect(transport.posts).toBe(1);
  });
});
