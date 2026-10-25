import { execFile } from 'node:child_process';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app';
import { loadConfig } from '../config';
import { configureResolveLimits } from '../services/ytdlp';
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
