import { execFile } from 'node:child_process';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app';
import { loadConfig } from '../config';
import { STREAM_FORMAT, configureResolveLimits, streamFormatFor } from '../services/ytdlp';
import { streamRoutes } from './stream';

vi.mock('node:child_process', () => ({ execFile: vi.fn(), spawn: vi.fn() }));

const TOKEN = 'test-token-0123456789abcdef';
const PAGE = 'https://93.184.216.34/watch?v=busy';
const INFO = {
  id: 'busy',
  title: 'Busy',
  ext: 'm4a',
  protocol: 'https',
  url: 'https://rr1.googlevideo.com/videoplayback?expire=1900000000',
};

describe('POST /stream load safeguards', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    const config = loadConfig({ OPEN_RECORD_TOKEN: TOKEN });
    app = await buildApp(config, { routes: [streamRoutes] });
    // One yt-dlp slot and no wait queue: a second concurrent resolve is refused.
    configureResolveLimits(1, 0);
  });

  afterAll(() => app.close());

  it('answers 503 with Retry-After when every slot is busy', async () => {
    const finish: ((err: null, stdout: string, stderr: string) => void)[] = [];
    vi.mocked(execFile).mockImplementation(((_f: string, _a: string[], _o: unknown, cb: never) => {
      finish.push(cb);
    }) as unknown as typeof execFile);
    const headers = { authorization: `Bearer ${TOKEN}` };

    const first = app.inject({ method: 'POST', url: '/stream', headers, payload: { url: PAGE } });
    await vi.waitFor(() => expect(finish).toHaveLength(1));

    const second = await app.inject({
      method: 'POST',
      url: '/stream',
      headers,
      payload: { url: 'https://93.184.216.34/watch?v=other' },
    });
    expect(second.statusCode).toBe(503);
    expect(second.headers['retry-after']).toBe('5');

    finish[0](null, JSON.stringify(INFO), '');
    const res = await first;
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ url: INFO.url, mimeType: 'audio/mp4', track: { title: 'Busy' } });
  });
});

describe('POST /stream quality', () => {
  let app: FastifyInstance;
  const headers = { authorization: `Bearer ${TOKEN}` };

  beforeAll(async () => {
    const config = loadConfig({ OPEN_RECORD_TOKEN: TOKEN });
    app = await buildApp(config, { routes: [streamRoutes] });
    configureResolveLimits(4);
  });

  afterAll(() => app.close());

  beforeEach(() => {
    vi.mocked(execFile).mockReset();
    vi.mocked(execFile).mockImplementation(((_f: string, _a: string[], _o: unknown, cb: (e: null, out: string, err: string) => void) => {
      cb(null, JSON.stringify(INFO), '');
    }) as unknown as typeof execFile);
  });

  const formatArg = (call: number): string => {
    const args = vi.mocked(execFile).mock.calls[call][1] as string[];
    return args[args.indexOf('-f') + 1];
  };

  it('rejects an unknown quality with 400 before running yt-dlp', async () => {
    for (const quality of ['ultra', 160, '']) {
      const res = await app.inject({ method: 'POST', url: '/stream', headers, payload: { url: PAGE, quality } });
      expect(res.statusCode).toBe(400);
    }
    expect(execFile).not.toHaveBeenCalled();
  });

  it('maps each quality to its format selector and caches per quality', async () => {
    const url = 'https://93.184.216.34/watch?v=quality';
    expect((await app.inject({ method: 'POST', url: '/stream', headers, payload: { url } })).statusCode).toBe(200);
    expect(formatArg(0)).toBe(streamFormatFor('highest'));
    expect(streamFormatFor('highest')).toBe(STREAM_FORMAT);

    const low = await app.inject({ method: 'POST', url: '/stream', headers, payload: { url, quality: 'low' } });
    expect(low.statusCode).toBe(200);
    expect(execFile).toHaveBeenCalledTimes(2); // not served from the `highest` cache entry
    expect(formatArg(1)).toBe(streamFormatFor('low'));
    expect(streamFormatFor('low').split('/')[0]).toBe('bestaudio[ext=m4a][abr<=64]');
    expect(streamFormatFor('high')).toContain('[abr<=160]');
    expect(streamFormatFor('medium')).toContain('[abr<=128]');
    // Every capped selector ends with the uncapped fallback.
    expect(streamFormatFor('medium').endsWith(`/${STREAM_FORMAT}`)).toBe(true);
  });
});
