import { execFile } from 'node:child_process';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app';
import { loadConfig } from '../config';
import { searchRoutes } from '../routes/search';
import { streamRoutes } from '../routes/stream';
import { isBlockedAddress, validateUrl, type LookupFn } from './url-guard';
import {
  artistOf,
  parseTitle,
  rankByRelevance,
  search,
  toStreamResponse,
} from './ytdlp';

vi.mock('node:child_process', () => ({ execFile: vi.fn(), spawn: vi.fn() }));

const publicLookup: LookupFn = async () => ['93.184.215.14'];

describe('URL validation (SSRF guard)', () => {
  it.each([
    'ftp://example.com/a',
    'file:///etc/passwd',
    'javascript:alert(1)',
    'http://user:pw@example.com/',
    'http://localhost:8787/health',
    'http://127.0.0.1/',
    'http://2130706433/', // 127.0.0.1 in decimal
    'http://10.1.2.3/',
    'http://192.168.1.1/',
    'http://169.254.169.254/latest/meta-data/',
    'http://[::1]/',
    'http://[::ffff:127.0.0.1]/',
    'http://[fd00:ec2::254]/',
    `https://example.com/${'a'.repeat(3000)}`,
  ])('rejects %s', async (url) => {
    await expect(validateUrl(url, publicLookup)).rejects.toThrow();
  });

  it('rejects hostnames that resolve to private addresses', async () => {
    await expect(
      validateUrl('https://evil.example/', async () => ['8.8.8.8', '10.0.0.5']),
    ).rejects.toThrow(/not allowed/);
  });

  it('accepts a public https URL', async () => {
    await expect(
      validateUrl('https://www.youtube.com/watch?v=abc', publicLookup),
    ).resolves.toBe('https://www.youtube.com/watch?v=abc');
    expect(isBlockedAddress('2606:4700::1111')).toBe(false);
  });
});

describe('search result mapping', () => {
  it('maps flat yt-dlp search entries and passes args without a shell', async () => {
    const sample = {
      _type: 'playlist',
      entries: [
        {
          _type: 'url',
          ie_key: 'Youtube',
          id: 'dQw4w9WgXcQ',
          url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
          title: 'Never Gonna Give You Up',
          channel: 'Rick Astley - Topic',
          duration: 213.4,
          thumbnails: [
            { url: 'https://i.ytimg.com/small.jpg' },
            { url: 'https://i.ytimg.com/big.jpg' },
          ],
        },
        { _type: 'url', id: 'nourl', title: 'dropped: no url' },
        null,
      ],
    };
    const mocked = vi.mocked(execFile);
    mocked.mockImplementation(((
      _file: string,
      _args: string[],
      _opts: unknown,
      cb: (...a: unknown[]) => void,
    ) => {
      cb(null, JSON.stringify(sample), '');
    }) as unknown as typeof execFile);

    const results = await search('rick astley; rm -rf /', 'youtube');

    expect(results).toEqual([
      {
        id: 'dQw4w9WgXcQ',
        title: 'Never Gonna Give You Up',
        artist: 'Rick Astley',
        durationSec: 213,
        thumbnailUrl: 'https://i.ytimg.com/big.jpg',
        url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
        site: 'youtube',
      },
    ]);
    const [file, args] = mocked.mock.calls[0] as unknown as [string, string[]];
    expect(file).toBe('yt-dlp');
    expect(args.slice(-2)).toEqual(['--', 'ytsearch15:rick astley; rm -rf /']);
  });

  it('refuses sources yt-dlp cannot search', async () => {
    await expect(search('x', 'bandcamp')).rejects.toMatchObject({
      status: 400,
    });
  });
});

describe('artist and title cleanup', () => {
  it.each([
    [{ channel: 'Rick Astley - Topic' }, 'Rick Astley'],
    [{ uploader: 'DaftPunkVEVO' }, 'Daft Punk'],
    [{ uploader: 'Daft Punk VEVO' }, 'Daft Punk'],
    [{ artist: '  ', uploader: 'Band' }, 'Band'],
    [{ uploader: 'VEVO', channel: 'Real Channel' }, 'Real Channel'],
    [{}, ''],
  ])('artistOf(%o) -> %s', (info, expected) => {
    expect(artistOf(info)).toBe(expected);
  });

  it.each([
    [
      'Daft Punk - Get Lucky (Official Video)',
      'DaftPunkVEVO',
      'Get Lucky',
      'Daft Punk',
    ],
    [
      'Daft Punk - Get Lucky [Official Audio]',
      undefined,
      'Get Lucky',
      'Daft Punk',
    ],
    ['Adele - Hello (Official Lyric Video)', 'XL Recordings', 'Hello', 'Adele'],
    [
      'Rick Astley - Never Gonna Give You Up (Official Music Video) (4K)',
      'Rick Astley',
      'Never Gonna Give You Up',
      'Rick Astley',
    ],
    [
      'Song - Live at Wembley',
      'Some Fan',
      'Song - Live at Wembley',
      'Some Fan',
    ],
    [
      'Track (Remastered 2011) (Lyrics)',
      'Band - Topic',
      'Track (Remastered 2011)',
      'Band',
    ],
  ])('parseTitle(%s, %s)', (title, channel, expectedTitle, expectedArtist) => {
    expect(parseTitle(title, channel)).toEqual({
      title: expectedTitle,
      artist: expectedArtist,
    });
  });

  it('ranks official uploads first and demotes unrequested variants, stably', () => {
    const titles = [
      'Song (Karaoke Version)',
      'Song (Live)',
      'Song',
      'Song (Official Music Video)',
      'Song (Cover)',
      'Song (Official Audio)',
    ];
    expect(rankByRelevance(titles, 'artist song', (t) => t)).toEqual([
      'Song (Official Music Video)',
      'Song (Official Audio)',
      'Song',
      'Song (Karaoke Version)',
      'Song (Live)',
      'Song (Cover)',
    ]);
    expect(
      rankByRelevance(['Song', 'Song (Live)'], 'song live', (t) => t),
    ).toEqual(['Song', 'Song (Live)']);
  });

  it('fills in missing YouTube Music artists from a per-track lookup', async () => {
    const flat = {
      _type: 'playlist',
      entries: [
        {
          _type: 'url',
          id: 'ytmEnrich01',
          url: 'https://music.youtube.com/watch?v=ytmEnrich01',
          title: 'Get Lucky',
        },
      ],
    };
    const full = {
      id: 'ytmEnrich01',
      title: 'Get Lucky',
      track: 'Get Lucky',
      artists: ['Daft Punk'],
      duration: 248,
    };
    const mocked = vi.mocked(execFile);
    mocked.mockImplementation(((
      _file: string,
      args: string[],
      _opts: unknown,
      cb: (...a: unknown[]) => void,
    ) => {
      cb(
        null,
        JSON.stringify(args.includes('--flat-playlist') ? flat : full),
        '',
      );
    }) as unknown as typeof execFile);

    const [result] = await search('get lucky', 'ytmusic');
    expect(result).toMatchObject({
      title: 'Get Lucky',
      artist: 'Daft Punk',
      durationSec: 248,
      site: 'ytmusic',
    });
  });
});

describe('yt-dlp routes auth', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    const config = loadConfig({
      OPEN_RECORD_TOKEN: 'test-token-0123456789abcdef',
    });
    app = await buildApp(config, { routes: [searchRoutes, streamRoutes] });
  });

  afterAll(() => app.close());

  it.each([
    ['GET', '/search?q=test'],
    ['POST', '/resolve'],
    ['POST', '/stream'],
  ] as const)('%s %s requires the token', async (method, url) => {
    const res = await app.inject({
      method,
      url,
      payload: method === 'POST' ? { url: 'https://example.com' } : undefined,
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('stream response mapping', () => {
  const media =
    'https://rr1.googlevideo.com/videoplayback?itag=140&expire=1900000000&sig=abc';

  it('maps a direct m4a link, keeps only allow-listed headers and reads expire', () => {
    const res = toStreamResponse({
      id: 'abc',
      title: 'Video title',
      track: 'Real Track',
      artist: 'Band',
      album: 'Album',
      ext: 'm4a',
      protocol: 'https',
      url: media,
      duration: 200.4,
      thumbnail: 'https://i.ytimg.com/t.jpg',
      http_headers: {
        'User-Agent': 'UA',
        Referer: 'https://www.youtube.com/',
        Cookie: 'secret',
        'X-Foo': 'bar',
      },
    });
    expect(res).toEqual({
      url: media,
      mimeType: 'audio/mp4',
      expiresAt: new Date(1900000000 * 1000).toISOString(),
      httpHeaders: { 'User-Agent': 'UA', Referer: 'https://www.youtube.com/' },
      track: {
        title: 'Real Track',
        artist: 'Band',
        album: 'Album',
        durationSec: 200,
        thumbnailUrl: 'https://i.ytimg.com/t.jpg',
      },
    });
  });

  it.each([
    ['segmented protocol', { protocol: 'm3u8_native', url: media }],
    ['dash protocol', { protocol: 'http_dash_segments', url: media }],
    [
      'manifest url',
      { protocol: 'https', url: 'https://cdn.example.com/a/index.m3u8' },
    ],
    ['no url', { protocol: 'https' }],
  ])('refuses %s with 422', (_name, extra) => {
    let caught: unknown;
    try {
      toStreamResponse({ id: 'x', title: 't', ...extra });
    } catch (err) {
      caught = err;
    }
    expect(caught).toMatchObject({ status: 422 });
  });
});
