import type { SessionTrack } from '@open-record/models';
import { fromSessionTrack } from './session-track';

describe('fromSessionTrack', () => {
  it('drops remote art and page links that are not http(s) or bundled catalog art', () => {
    const base: SessionTrack = {
      entryId: 'e1',
      id: 'remote:abc',
      providerId: 'remote',
      title: 'T',
      artist: 'A',
    };
    const hostile = fromSessionTrack({
      ...base,
      artUrl: 'data:image/svg+xml;base64,PHN2Zz4=',
      source: { site: 'youtube', url: 'javascript:alert(1)' },
    });
    expect(hostile.artUrl).toBeUndefined();
    expect(hostile.source).toBeUndefined();

    const ok = fromSessionTrack({
      ...base,
      artUrl: 'https://i.example/abc.jpg',
      source: { site: 'youtube', url: 'https://youtu.be/abc', id: 'abc' },
    });
    expect(ok.artUrl).toBe('https://i.example/abc.jpg');
    expect(ok.source).toEqual({ site: 'youtube', url: 'https://youtu.be/abc', id: 'abc' });
  });
});
