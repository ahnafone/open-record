import { createAliasLookup, parseRecordingAliases, type AliasFetch } from './musicbrainz';

const BODY = {
  recordings: [
    {
      score: 100,
      title: 'Lemon',
      aliases: [{ name: 'レモン', 'sort-name': 'Remon' }],
      'artist-credit': [
        {
          name: '米津玄師',
          artist: { name: '米津玄師', 'sort-name': 'Yonezu, Kenshi', aliases: [{ name: 'Kenshi Yonezu' }] },
        },
      ],
    },
    // Unrelated recording: low score and no title/artist overlap.
    { score: 40, title: 'Something Else', 'artist-credit': [{ name: 'Other' }] },
  ],
};

const ok = (body: unknown): Awaited<ReturnType<AliasFetch>> => ({
  ok: true,
  status: 200,
  text: async () => JSON.stringify(body),
});

describe('musicbrainz aliases', () => {
  it('collects title and artist aliases from matching recordings only', () => {
    const out = parseRecordingAliases(BODY, { artist: 'Kenshi Yonezu', title: 'Lemon' });
    expect(out.titles).toEqual(['Lemon', 'レモン', 'Remon']);
    expect(out.artists).toEqual(['米津玄師', 'Yonezu, Kenshi', 'Kenshi Yonezu']);
  });

  it('looks up by ISRC first, sends a User-Agent, caches, and fails soft', async () => {
    const fetchFn = vi.fn<AliasFetch>(async () => ok(BODY));
    const svc = createAliasLookup({ fetch: fetchFn, minIntervalMs: 0 });
    const q = { artist: 'Kenshi Yonezu', title: 'Lemon', isrc: 'JP-U90-18-00001' };

    expect((await svc.lookup(q)).titles).toContain('レモン');
    await svc.lookup(q);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0];
    expect(decodeURIComponent(url)).toContain('isrc:JPU901800001');
    expect(init.headers['User-Agent']).toMatch(/OpenRecord/);

    const broken = createAliasLookup({ fetch: async () => Promise.reject(new Error('down')), minIntervalMs: 0 });
    expect(await broken.lookup({ artist: 'a', title: 'b' })).toEqual({ titles: [], artists: [] });
  });
});
