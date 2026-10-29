import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app';
import { loadConfig } from '../config';
import { searchRoutes } from '../routes/search';
import { streamRoutes } from '../routes/stream';
import { isBlockedAddress, validateUrl, type LookupFn } from './url-guard';
import {
  ageGateHint,
  artistOf,
  BASE_ARGS,
  configureCookies,
  cookieState,
  cookiesStatus,
  lastError,
  parseTitle,
  rankByRelevance,
  search,
  toStreamResponse,
} from './ytdlp';

vi.mock('node:child_process', () => ({ execFile: vi.fn(), spawn: vi.fn() }));

/** Set to make `mkdtempSync` fail, as when the temp directory is full or read-only. */
const fsMock = vi.hoisted(() => ({ failMkdtemp: false }));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    mkdtempSync: ((...args: unknown[]) => {
      if (fsMock.failMkdtemp)
        throw new Error('ENOSPC: no space left on device');
      return (actual.mkdtempSync as (...a: unknown[]) => unknown)(...args);
    }) as typeof actual.mkdtempSync,
  };
});

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

describe('yt-dlp cookies', () => {
  const emptySearch = { _type: 'playlist', entries: [] };
  const AGE_STDERR =
    'ERROR: [youtube] dQw4w9WgXcQ: Sign in to confirm your age\n';
  const PRIVATE_STDERR =
    'ERROR: [youtube] dQw4w9WgXcQ: Private video. Sign in if you have access\n';

  /** Answers successive `execFile` calls from `runs`; the last one repeats. */
  function mockRuns(
    ...runs: { payload?: unknown; stderr?: string; error?: boolean }[]
  ): void {
    const mocked = vi.mocked(execFile);
    mocked.mockImplementation(((
      _file: string,
      _args: string[],
      _opts: unknown,
      cb: (...a: unknown[]) => void,
    ) => {
      const run = runs[Math.min(mocked.mock.calls.length - 1, runs.length - 1)];
      if (run.error) cb(new Error('exit 1'), '', run.stderr ?? '');
      else cb(null, JSON.stringify(run.payload ?? emptySearch), '');
    }) as unknown as typeof execFile);
  }

  /** Every `execFile` call fails with `err`, keeping extra fields (code, killed). */
  function mockFailure(err: Error): void {
    vi.mocked(execFile).mockImplementation(((
      _file: string,
      _args: string[],
      _opts: unknown,
      cb: (...a: unknown[]) => void,
    ) => {
      cb(err, '', '');
    }) as unknown as typeof execFile);
  }

  function callArgs(index: number): string[] {
    return vi.mocked(execFile).mock.calls[index][1] as string[];
  }

  function lastArgs(): string[] {
    return callArgs(vi.mocked(execFile).mock.calls.length - 1);
  }

  /** A cookies.txt on disk; returns its path and a cleanup function. */
  function cookiesFile(contents?: string): {
    path: string;
    cleanup: () => void;
  } {
    const dir = mkdtempSync(join(tmpdir(), 'open-record-test-'));
    const path = join(dir, 'cookies.txt');
    writeFileSync(
      path,
      contents ??
        '# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t0\tSID\tabc\n',
    );
    return {
      path,
      cleanup: () => rmSync(dir, { recursive: true, force: true }),
    };
  }

  // The cookies path is module state shared by every test in this file.
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    vi.mocked(execFile).mockReset();
    // Never let a timeout or early abort in one test poison mkdtempSync later.
    fsMock.failMkdtemp = false;
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    warn.mockRestore();
    configureCookies(null);
  });

  it('runs anonymously first and retries once with --cookies on the age gate', async () => {
    const { path, cleanup } = cookiesFile();
    let copy = '';
    let mode = 0;
    try {
      configureCookies(path);
      expect(cookiesStatus()).toEqual({ path, ok: true });
      let calls = 0;
      vi.mocked(execFile).mockImplementation(((
        _file: string,
        args: string[],
        _opts: unknown,
        cb: (...a: unknown[]) => void,
      ) => {
        calls += 1;
        if (calls === 1) {
          expect(args).not.toContain('--cookies');
          cb(new Error('exit 1'), '', AGE_STDERR);
          return;
        }
        copy = args[args.indexOf('--cookies') + 1];
        mode = statSync(copy).mode & 0o777;
        cb(null, JSON.stringify(emptySearch), '');
      }) as unknown as typeof execFile);

      await expect(search('x', 'youtube')).resolves.toEqual([]);

      expect(calls).toBe(2);
      // The retry's --cookies sits right after the global args.
      expect(lastArgs().indexOf('--cookies')).toBe(BASE_ARGS.length);
      expect(copy).not.toBe(path);
      expect(dirname(copy)).not.toBe(dirname(path));
      expect(mode).toBe(0o600); // tokens are never world-readable
      // The per-run directory is removed once the promise settles.
      expect(() => statSync(dirname(copy))).toThrow();
    } finally {
      cleanup();
    }
  });

  it('retries a sign-in refusal once and keeps its own message', async () => {
    const { path, cleanup } = cookiesFile();
    try {
      configureCookies(path);
      mockRuns(
        { error: true, stderr: PRIVATE_STDERR },
        { error: true, stderr: PRIVATE_STDERR },
      );
      // "Private video" must still classify as a per-track failure in the app,
      // so a retry that fails the same way is not turned into age-gate copy.
      await expect(search('x', 'youtube')).rejects.toMatchObject({
        message: expect.stringMatching(/Private video/),
        status: 502,
      });
      expect(vi.mocked(execFile)).toHaveBeenCalledTimes(2);
      expect(callArgs(0)).not.toContain('--cookies');
      expect(callArgs(1)).toContain('--cookies');
    } finally {
      cleanup();
    }
  });

  it('does not retry errors that are not about signing in', async () => {
    const { path, cleanup } = cookiesFile();
    try {
      configureCookies(path);
      mockRuns({
        error: true,
        stderr: 'ERROR: [youtube] dQw4w9WgXcQ: Video unavailable\n',
      });
      await expect(search('x', 'youtube')).rejects.toThrow(/Video unavailable/);
      expect(vi.mocked(execFile)).toHaveBeenCalledTimes(1);
    } finally {
      cleanup();
    }
  });

  it('hints adding cookies and does not retry without a jar', async () => {
    mockRuns({ error: true, stderr: AGE_STDERR });
    await expect(search('x', 'youtube')).rejects.toMatchObject({
      message: expect.stringMatching(/confirm your age.*cookies/i),
      status: 502,
    });
    expect(vi.mocked(execFile)).toHaveBeenCalledTimes(1);
  });

  it('hints a broken file and does not retry', async () => {
    configureCookies('/nonexistent/open-record-cookies.txt');
    expect(cookiesStatus()).toMatchObject({
      path: '/nonexistent/open-record-cookies.txt',
      ok: false,
      reason: expect.stringMatching(/ENOENT/),
    });
    mockRuns({ error: true, stderr: AGE_STDERR });
    const err = await search('x', 'youtube').catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 502 });
    const message = (err as Error).message;
    expect(message).toMatch(/confirm your age/i);
    expect(message).toMatch(/cookies file cannot be read/i);
    // The hint must name both places the operator can fix the jar.
    expect(message).toContain('YTDLP_COOKIES_FILE');
    expect(message).toMatch(/data-directory cookies\.txt/);
    expect(vi.mocked(execFile)).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/ENOENT/)); // broken once
  });

  it('reports a stale jar when the retry also hits the age gate, and cleans up', async () => {
    const { path, cleanup } = cookiesFile();
    let copy = '';
    try {
      configureCookies(path);
      vi.mocked(execFile).mockImplementation(((
        _file: string,
        args: string[],
        _opts: unknown,
        cb: (...a: unknown[]) => void,
      ) => {
        if (args.includes('--cookies'))
          copy = args[args.indexOf('--cookies') + 1];
        cb(new Error('exit 1'), '', AGE_STDERR);
      }) as unknown as typeof execFile);

      await expect(search('x', 'youtube')).rejects.toMatchObject({
        message: expect.stringMatching(/confirm your age.*may be stale/),
        status: 502,
      });
      expect(vi.mocked(execFile)).toHaveBeenCalledTimes(2);
      // The failed retry's copy is gone too.
      expect(copy).not.toBe('');
      expect(() => statSync(copy)).toThrow();
    } finally {
      cleanup();
    }
  });

  it('hints the temp directory when the per-run copy cannot be written', async () => {
    const { path, cleanup } = cookiesFile();
    try {
      // A usable jar on disk; only this run's private copy fails to be created.
      configureCookies(path);
      expect(cookieState()).toBe('ok');
      fsMock.failMkdtemp = true;
      mockRuns({ error: true, stderr: AGE_STDERR });

      await expect(search('x', 'youtube')).rejects.toMatchObject({
        message: expect.stringMatching(/confirm your age.*temporary copy/i),
        status: 502,
      });
      // The retry never starts: the run could not get its own copy of the jar.
      expect(vi.mocked(execFile)).toHaveBeenCalledTimes(1);
      expect(callArgs(0)).not.toContain('--cookies');
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/ENOSPC/));
    } finally {
      fsMock.failMkdtemp = false;
      cleanup();
    }
  });

  it('resolves <data dir>/cookies.txt per request: absent, added, removed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'open-record-test-'));
    const path = join(dir, 'cookies.txt');
    try {
      configureCookies(null, path);
      // Nothing on disk yet: the optional default is skipped silently.
      expect(cookieState()).toBe('none');
      expect(cookiesStatus()).toBeNull();
      expect(warn).not.toHaveBeenCalled();

      // Dropped in later: the next run picks it up without reconfiguring.
      writeFileSync(
        path,
        '# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t0\tSID\tabc\n',
      );
      mockRuns({ error: true, stderr: AGE_STDERR }, { payload: emptySearch });
      await expect(search('x', 'youtube')).resolves.toEqual([]);
      expect(callArgs(0)).not.toContain('--cookies');
      expect(lastArgs()).toContain('--cookies');

      // Deleted again: back to anonymous, still without reconfiguring.
      rmSync(path);
      expect(cookieState()).toBe('none');
      expect(cookiesStatus()).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not retry when yt-dlp is missing, and keeps the 500', async () => {
    const { path, cleanup } = cookiesFile();
    try {
      configureCookies(path);
      expect(cookieState()).toBe('ok');
      mockFailure(
        Object.assign(new Error('spawn yt-dlp ENOENT'), { code: 'ENOENT' }),
      );
      await expect(search('x', 'youtube')).rejects.toMatchObject({
        status: 500,
      });
      expect(vi.mocked(execFile)).toHaveBeenCalledTimes(1);
      expect(callArgs(0)).not.toContain('--cookies');
    } finally {
      cleanup();
    }
  });

  it('does not retry a timeout, and keeps the 504', async () => {
    const { path, cleanup } = cookiesFile();
    try {
      configureCookies(path);
      expect(cookieState()).toBe('ok');
      mockFailure(Object.assign(new Error('yt-dlp killed'), { killed: true }));
      await expect(search('x', 'youtube')).rejects.toMatchObject({
        status: 504,
      });
      expect(vi.mocked(execFile)).toHaveBeenCalledTimes(1);
      expect(callArgs(0)).not.toContain('--cookies');
    } finally {
      cleanup();
    }
  });

  it('keeps a broken explicit path even when the fallback file exists', async () => {
    const { path, cleanup } = cookiesFile();
    try {
      configureCookies('/nonexistent/explicit-cookies.txt', path);
      expect(cookiesStatus()).toMatchObject({
        path: '/nonexistent/explicit-cookies.txt',
        ok: false,
      });

      mockRuns({ error: true, stderr: AGE_STDERR });
      await expect(search('x', 'youtube')).rejects.toMatchObject({
        message: expect.stringMatching(/cookies file cannot be read/i),
      });
      expect(vi.mocked(execFile)).toHaveBeenCalledTimes(1);
    } finally {
      cleanup();
    }
  });

  it('stays silent when neither a path nor the fallback file exists', () => {
    const { path, cleanup } = cookiesFile();
    try {
      configureCookies(null, join(dirname(path), 'missing', 'cookies.txt'));
      expect(cookiesStatus()).toBeNull();
      expect(cookieState()).toBe('none');
      expect(warn).not.toHaveBeenCalled();
    } finally {
      cleanup();
    }
  });

  it('reports jars it cannot use, with the reason', () => {
    const empty = cookiesFile('');
    const page = cookiesFile('<html><body>not cookies</body></html>\n');
    // Real exports mark HttpOnly cookies this way: a data row, not a comment.
    const httpOnly = cookiesFile(
      '# Netscape HTTP Cookie File\n' +
        '#HttpOnly_.youtube.com\tTRUE\t/\tTRUE\t0\tSID\tabc\n',
    );
    try {
      configureCookies(empty.path);
      expect(cookiesStatus()).toEqual({
        path: empty.path,
        ok: false,
        reason: 'empty',
      });
      configureCookies(page.path);
      expect(cookiesStatus()).toEqual({
        path: page.path,
        ok: false,
        reason: 'not a Netscape cookies.txt',
      });
      configureCookies(httpOnly.path);
      expect(cookiesStatus()).toEqual({ path: httpOnly.path, ok: true });
      expect(warn).toHaveBeenCalled();
    } finally {
      empty.cleanup();
      page.cleanup();
      httpOnly.cleanup();
    }
  });

  it('keeps yt-dlp wording when the jar is usable and hints otherwise', () => {
    const own = 'Sign in to confirm your age';
    expect(ageGateHint(own, 'ok')).toBe(own);
    expect(ageGateHint(own, 'broken')).toMatch(
      /confirm your age.*cookies file cannot be read/i,
    );
    expect(ageGateHint('some other error', 'none')).toBe('some other error');
  });
});

describe('client-facing yt-dlp errors', () => {
  it('redacts the temp directory and stays undefined without an ERROR line', () => {
    const tmp = tmpdir();
    const message = lastError(
      `ERROR: [youtube] dQw4w9WgXcQ: unable to load cookies from ` +
        `${tmp}/open-record-cookies-abc/cookies.txt\n`,
    );
    expect(message).toContain('<tmp>');
    expect(message).not.toContain(tmp);

    expect(lastError('')).toBeUndefined();
    expect(lastError('WARNING: [youtube] nothing failed\n')).toBeUndefined();
  });
});
