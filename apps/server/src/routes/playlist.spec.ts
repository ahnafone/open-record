import { execFile } from 'node:child_process';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app';
import { loadConfig } from '../config';
import { parseYoutubeLink } from '../services/playlist';
import { playlistRoutes } from './playlist';

vi.mock('node:child_process', () => ({ execFile: vi.fn(), spawn: vi.fn() }));

const TOKEN = 'test-token-0123456789abcdef';

describe('parseYoutubeLink', () => {
  it('accepts single-song links and rebuilds a canonical watch URL from the 11-char id', () => {
    const songs = [
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      'youtube.com/watch?v=dQw4w9WgXcQ&t=42',
      'https://m.youtube.com/watch?v=dQw4w9WgXcQ',
      'https://music.youtube.com/watch?v=dQw4w9WgXcQ&si=x',
      'https://youtu.be/dQw4w9WgXcQ',
      'https://youtu.be/dQw4w9WgXcQ/',
    ];
    for (const raw of songs) {
      expect(parseYoutubeLink(raw), raw).toEqual({
        kind: 'song',
        id: 'dQw4w9WgXcQ',
        site: raw.includes('music.') ? 'ytmusic' : 'youtube',
        url: `${raw.includes('music.') ? 'https://music.youtube.com' : 'https://www.youtube.com'}/watch?v=dQw4w9WgXcQ`,
      });
    }
  });

  it('keeps a link with list= as a playlist, even when it also names a video', () => {
    expect(parseYoutubeLink('https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PLabc_DEF-123')).toMatchObject({
      kind: 'playlist',
      id: 'PLabc_DEF-123',
    });
  });

  it('rejects other hosts, lookalike hosts and malformed video ids', () => {
    const rejected = [
      'https://evil.example/watch?v=dQw4w9WgXcQ',
      'https://youtube.com.evil.example/watch?v=dQw4w9WgXcQ',
      'https://youtu.be.evil.example/dQw4w9WgXcQ',
      'https://127.0.0.1/watch?v=dQw4w9WgXcQ',
      'https://www.youtube.com/watch?v=short',
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ0',
      'https://www.youtube.com/watch?v=dQw4w9Wg!cQ',
      'https://www.youtube.com/watch',
      'https://youtu.be/',
      'https://youtu.be/dQw4w9WgXcQ/extra',
      'https://www.youtube.com/shorts/dQw4w9WgXcQ',
      'https://www.youtube.com:8443/watch?v=dQw4w9WgXcQ',
    ];
    for (const raw of rejected) {
      expect(() => parseYoutubeLink(raw), raw).toThrow();
    }
  });
});

describe('POST /playlist URL allow-list', () => {
  let app: FastifyInstance;
  const headers = { authorization: `Bearer ${TOKEN}` };

  beforeAll(async () => {
    app = await buildApp(loadConfig({ OPEN_RECORD_TOKEN: TOKEN }), { routes: [playlistRoutes] });
  });

  afterAll(() => app.close());

  it('rejects non-YouTube hosts, IPs, credentials, ports and non-playlist links without running yt-dlp', async () => {
    const rejected = [
      'https://evil.example/playlist?list=PL1234567890',
      'https://youtube.com.evil.example/playlist?list=PL1234567890',
      'http://127.0.0.1/playlist?list=PL1234567890',
      'http://169.254.169.254/latest/meta-data/?list=PL1234567890',
      'http://localhost/playlist?list=PL1234567890',
      'https://user:pass@www.youtube.com/playlist?list=PL1234567890',
      'https://www.youtube.com:8443/playlist?list=PL1234567890',
      'file:///etc/passwd?list=PL1234567890',
      'https://www.youtube.com/watch?v=short',
      'https://www.youtube.com/playlist?list=../../x',
      'https://www.youtube.com/playlist?list=WL',
    ];
    for (const url of rejected) {
      const res = await app.inject({ method: 'POST', url: '/playlist', headers, payload: { url } });
      expect(res.statusCode, url).toBe(400);
    }
    expect(execFile).not.toHaveBeenCalled();
  });

  it('imports a single song link as one entry (metadata only, --no-playlist) without a playlist', async () => {
    vi.mocked(execFile).mockImplementation(((_f: string, _a: string[], _o: unknown, cb: (e: null, out: string, err: string) => void) =>
      cb(null, JSON.stringify({ id: 'dQw4w9WgXcQ', title: 'Never Gonna Give You Up', uploader: 'Rick Astley' }), '')) as unknown as typeof execFile);
    const res = await app.inject({ method: 'POST', url: '/playlist', headers, payload: { url: 'https://youtu.be/dQw4w9WgXcQ' } });
    expect(res.statusCode).toBe(200);
    const args = vi.mocked(execFile).mock.calls.at(-1)?.[1] as string[];
    expect(args).toContain('--no-playlist');
    expect(args).not.toContain('--flat-playlist');
    expect(args.at(-1)).toBe('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    expect(res.json()).toMatchObject({ id: 'dQw4w9WgXcQ', single: true, truncated: false });
    expect(res.json().entries).toHaveLength(1);
  });

  it('passes only a canonical URL rebuilt from the list id to yt-dlp', async () => {
    vi.mocked(execFile).mockImplementation(((_f: string, _a: string[], _o: unknown, cb: (e: null, out: string, err: string) => void) =>
      cb(null, JSON.stringify({ _type: 'playlist', title: 'Mix', entries: [{ id: 'dQw4w9WgXcQ', title: 'Artist - Song' }] }), '')) as unknown as typeof execFile);
    const res = await app.inject({
      method: 'POST',
      url: '/playlist',
      headers,
      payload: { url: 'https://music.youtube.com/watch?v=dQw4w9WgXcQ&list=PLabc_DEF-123&si=x' },
    });
    expect(res.statusCode).toBe(200);
    const args = vi.mocked(execFile).mock.calls.at(-1)?.[1] as string[];
    expect(args.at(-1)).toBe('https://music.youtube.com/playlist?list=PLabc_DEF-123');
    expect(res.json().entries).toHaveLength(1);
  });

  it('answers 422 with the cookie guidance for an age-gated song', async () => {
    // Not 403: the app turns every 401/403 into AuthError, which hides this text.
    vi.mocked(execFile).mockImplementation(((_f: string, _a: string[], _o: unknown, cb: (e: Error, out: string, err: string) => void) =>
      cb(new Error('exit 1'), '', 'ERROR: [youtube] dQw4w9WgXcQ: Sign in to confirm your age\n')) as unknown as typeof execFile);
    const res = await app.inject({ method: 'POST', url: '/playlist', headers, payload: { url: 'https://youtu.be/dQw4w9WgXcQ' } });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toMatch(/confirm your age.*cookies/i);
  });

  it('still answers 403 with the private wording for a private playlist', async () => {
    vi.mocked(execFile).mockImplementation(((_f: string, _a: string[], _o: unknown, cb: (e: Error, out: string, err: string) => void) =>
      cb(new Error('exit 1'), '', 'ERROR: [youtube:tab] PLabc_DEF-123: This playlist is private\n')) as unknown as typeof execFile);
    const res = await app.inject({ method: 'POST', url: '/playlist', headers, payload: { url: 'https://www.youtube.com/playlist?list=PLabc_DEF-123' } });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toMatch(/This playlist is private/i);
  });
});
