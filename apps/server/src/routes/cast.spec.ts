import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable, Writable } from 'node:stream';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import { loadConfig, type ServerConfig } from '../config';
import { MediaRelay } from '../services/media-relay';
import type { MediaPlan } from '../services/media-plan';
import { createTranscoder, ffmpegAvailable } from '../services/transcode';
import { UploadCache } from '../services/upload-cache';
import { UrlRejectedError, type ValidatedUrl } from '../services/url-guard';
import type { StreamResponse } from '../services/ytdlp';
import { castRoutes } from './cast';

const TOKEN = 'test-token-0123456789abcdef';
const CATALOG_BODY = Buffer.from('0123456789abcdefghij');
const AUDIO_BODY = Buffer.from(Array.from({ length: 1024 }, (_, i) => i % 256));

const track = { title: 'Song', artist: 'Artist' };

function streamResponse(url: string): StreamResponse {
  return {
    url,
    mimeType: 'audio/mpeg',
    httpHeaders: { 'user-agent': 'open-record-test' },
    track,
  };
}

function upstreamResponse(url: string): StreamResponse {
  return streamResponse(url);
}

describe('cast relay route', () => {
  let config: ServerConfig;
  let webDir: string;
  let uploadsDir: string;
  let relay: MediaRelay;
  let upstream: Server;
  let upstreamBase: string;
  let upstreamHits = 0;
  let resolveCalls = 0;
  let lastUpstreamHeaders: IncomingMessage['headers'] = {};

  let resolver: (url: string) => Promise<StreamResponse>;
  let validator: (url: string) => Promise<ValidatedUrl>;

  beforeAll(async () => {
    webDir = await mkdtemp(join(tmpdir(), 'open-record-cast-route-'));
    uploadsDir = await mkdtemp(join(tmpdir(), 'open-record-cast-uploads-route-'));
    await mkdir(join(webDir, 'catalog', 'audio'), { recursive: true });
    await writeFile(join(webDir, 'catalog', 'audio', 'song.mp3'), CATALOG_BODY);
    await writeFile(join(webDir, 'secret.mp3'), 'do not serve me');

    config = loadConfig({
      OPEN_RECORD_TOKEN: TOKEN,
      CAST_MEDIA_BASE_URL: 'http://10.0.0.5:8787',
      WEB_DIR: webDir,
    });
    relay = new MediaRelay({
      secret: randomBytes(32),
      dataDir: webDir,
      baseUrl: config.castMediaBaseUrl ?? 'http://10.0.0.5:8787',
      ttlMs: 900_000,
      pruneMs: 0,
    });

    upstream = createServer((request, response) => {
      upstreamHits += 1;
      lastUpstreamHeaders = request.headers;

      if (request.url === '/redirect') {
        response.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data' });
        response.end();
        return;
      }

      if (request.headers['if-none-match'] === '"v1"') {
        response.writeHead(304, { etag: '"v1"' });
        response.end();
        return;
      }

      const range = request.headers.range;
      if (typeof range === 'string') {
        const match = /^bytes=(\d+)-(\d*)$/.exec(range);
        if (match) {
          const start = Number(match[1]);
          const end = match[2] ? Math.min(Number(match[2]), AUDIO_BODY.length - 1) : AUDIO_BODY.length - 1;
          if (start < AUDIO_BODY.length && end >= start) {
            response.writeHead(206, {
              'content-type': 'audio/mpeg',
              'content-length': end - start + 1,
              'content-range': `bytes ${start}-${end}/${AUDIO_BODY.length}`,
              'accept-ranges': 'bytes',
            });
            response.end(AUDIO_BODY.subarray(start, end + 1));
            return;
          }
        }
        response.writeHead(416, { 'content-range': `bytes */${AUDIO_BODY.length}`, 'accept-ranges': 'bytes' });
        response.end();
        return;
      }

      response.writeHead(200, {
        'content-type': 'audio/mpeg',
        'content-length': AUDIO_BODY.length,
        'accept-ranges': 'bytes',
      });
      response.end(AUDIO_BODY);
    });
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    const address = upstream.address();
    if (!address || typeof address === 'string') throw new Error('upstream did not bind a TCP port');
    upstreamBase = `http://127.0.0.1:${address.port}`;

    resolver = async (url) => {
      resolveCalls += 1;
      return upstreamResponse(url.startsWith('https://') ? `${upstreamBase}/audio` : url);
    };
    validator = async (url) => ({ url, addresses: ['127.0.0.1'] });
  });

  beforeEach(() => {
    upstreamHits = 0;
    resolveCalls = 0;
    lastUpstreamHeaders = {};
  });

  afterAll(async () => {
    relay.dispose();
    await new Promise<void>((resolve) => {
      upstream.close(() => resolve());
      upstream.closeAllConnections();
    });
    await rm(webDir, { recursive: true, force: true });
    await rm(uploadsDir, { recursive: true, force: true });
  });

  async function makeApp(
    overrides: {
      relay?: MediaRelay | null;
      uploads?: UploadCache;
      resolve?: (url: string) => Promise<StreamResponse>;
      validate?: (url: string) => Promise<ValidatedUrl>;
      logger?: FastifyServerOptions['logger'];
      transcode?: typeof createTranscoder;
      hasFfmpeg?: typeof ffmpegAvailable;
    } = {},
  ): Promise<FastifyInstance> {
    const app = Fastify({ logger: overrides.logger ?? false });
    await app.register(rateLimit, { global: false });
    await app.register(castRoutes, {
      config,
      relay: overrides.relay === undefined ? relay : overrides.relay,
      uploads: overrides.uploads,
      resolveStream: overrides.resolve ?? resolver,
      validateRelayUrl: overrides.validate ?? validator,
      transcode: overrides.transcode,
      hasFfmpeg: overrides.hasFfmpeg,
    });
    await app.ready();
    return app;
  }

  function mint(plan: MediaPlan, trackId = 'track-1'): string {
    const made = relay.create({ userId: 'user-1', trackId, plan });
    return new URL(made.url).pathname.split('/').pop() ?? '';
  }

  it('streams a resolved remote URL and honours Range', async () => {
    const app = await makeApp();
    try {
      const token = mint({ kind: 'remote', pageUrl: 'https://page.example/one' });

      const full = await app.inject({ method: 'GET', url: `/cast/relay/${token}` });
      expect(full.statusCode).toBe(200);
      expect(full.headers['content-type']).toBe('audio/mpeg');
      expect(full.headers['content-length']).toBe(String(AUDIO_BODY.length));
      expect(full.headers['accept-ranges']).toBe('bytes');
      expect(full.headers['cache-control']).toBe('no-store');
      expect(full.headers['x-content-type-options']).toBe('nosniff');
      expect(full.headers['content-disposition']).toBe('inline');
      expect(full.rawPayload.equals(AUDIO_BODY)).toBe(true);
      expect(lastUpstreamHeaders['user-agent']).toBe('open-record-test');

      const ranged = await app.inject({
        method: 'GET',
        url: `/cast/relay/${token}`,
        headers: { range: 'bytes=10-19' },
      });
      expect(ranged.statusCode).toBe(206);
      expect(ranged.headers['content-range']).toBe(`bytes 10-19/${AUDIO_BODY.length}`);
      expect(ranged.headers['content-length']).toBe('10');
      expect(ranged.rawPayload.equals(AUDIO_BODY.subarray(10, 20))).toBe(true);

      // The per-entry resolved URL is reused; the page is not resolved twice.
      expect(resolveCalls).toBe(1);
      expect(relay.verify(token)?.stream).toEqual({ transcoded: false, offsetSec: 0 });
    } finally {
      await app.close();
    }
  });

  it('answers 503 ffmpeg-missing for a source it cannot pass through', async () => {
    const app = await makeApp({
      resolve: async () => ({ url: `${upstreamBase}/audio`, mimeType: 'audio/webm', track }),
      hasFfmpeg: async () => false,
    });
    try {
      const result = await app.inject({
        method: 'GET',
        url: `/cast/relay/${mint({ kind: 'remote', pageUrl: 'https://page.example/webm' })}`,
      });
      expect(result.statusCode).toBe(503);
      expect(result.json()).toEqual({ error: 'ffmpeg-missing' });
      expect(upstreamHits).toBe(1);
    } finally {
      await app.close();
    }
  });

  it('transcodes non-Cast-friendly audio to ADTS and honours ?offset', async () => {
    const transcodeCalls: { ffmpegPath: string; offsetSec: number }[] = [];
    const transcode = ((opts: { ffmpegPath: string; offsetSec: number }) => {
      transcodeCalls.push(opts);
      const stdin = new PassThrough();
      const stream = new PassThrough();
      stdin.pipe(stream);
      return { stdin, stream, done: Promise.resolve(), kill: vi.fn() };
    }) as unknown as typeof createTranscoder;

    let mimeType = 'audio/webm';
    const app = await makeApp({
      resolve: async () => ({ url: `${upstreamBase}/audio`, mimeType, track }),
      hasFfmpeg: async () => true,
      transcode,
    });
    try {
      const token = mint({ kind: 'remote', pageUrl: 'https://page.example/webm' });
      const result = await app.inject({ method: 'GET', url: `/cast/relay/${token}` });
      expect(result.statusCode).toBe(200);
      expect(result.headers['content-type']).toBe('audio/aac');
      // Explicitly not seekable: the receiver must not try byte ranges.
      expect(result.headers['accept-ranges']).toBe('none');
      expect(result.headers['cache-control']).toBe('no-store');
      expect(result.headers['x-content-type-options']).toBe('nosniff');
      expect(result.headers['content-disposition']).toBe('inline');
      expect(result.rawPayload.equals(AUDIO_BODY)).toBe(true);
      expect(transcodeCalls).toEqual([{ ffmpegPath: config.ffmpegPath, offsetSec: 0 }]);
      expect(relay.verify(token)?.stream).toEqual({ transcoded: true, offsetSec: 0 });

      // `?offset` forces the transcode path even for a Cast-friendly mime: only
      // ffmpeg's input seek can honour a source offset.
      mimeType = 'audio/mp4';
      const restarted = await app.inject({
        method: 'GET',
        url: `/cast/relay/${mint({ kind: 'remote', pageUrl: 'https://page.example/mp4' })}?offset=42`,
      });
      expect(restarted.statusCode).toBe(200);
      expect(restarted.headers['content-type']).toBe('audio/aac');
      expect(transcodeCalls.at(-1)).toEqual({ ffmpegPath: config.ffmpegPath, offsetSec: 42 });

      // A Range request must not hand ffmpeg a 206 slice of the source.
      mimeType = 'audio/webm';
      upstreamHits = 0;
      const ranged = await app.inject({
        method: 'GET',
        url: `/cast/relay/${mint({ kind: 'remote', pageUrl: 'https://page.example/webm-range' })}`,
        headers: { range: 'bytes=10-19' },
      });
      expect(ranged.statusCode).toBe(200);
      expect(ranged.rawPayload.equals(AUDIO_BODY)).toBe(true);
      expect(upstreamHits).toBe(2);
    } finally {
      await app.close();
    }
  });

  it('supersedes the previous ffmpeg for a relay entry instead of stacking encoders', async () => {
    interface FakeTranscoder {
      stdin: PassThrough;
      stream: PassThrough;
      done: Promise<void>;
      kill: ReturnType<typeof vi.fn>;
    }
    const transcoders: FakeTranscoder[] = [];
    const transcodeCalls: { ffmpegPath: string; offsetSec: number }[] = [];
    const transcode = ((opts: { ffmpegPath: string; offsetSec: number }) => {
      transcodeCalls.push(opts);
      const stdin = new PassThrough();
      const stream = new PassThrough();
      stdin.pipe(stream);
      const transcoder: FakeTranscoder = {
        stdin,
        stream,
        done: new Promise<void>(() => undefined),
        // Ends the output so a superseded request's reply can complete.
        kill: vi.fn(() => {
          stdin.end();
          stream.end();
        }),
      };
      transcoders.push(transcoder);
      return transcoder;
    }) as unknown as typeof createTranscoder;

    const app = await makeApp({
      resolve: async () => ({ url: `${upstreamBase}/audio`, mimeType: 'audio/webm', track }),
      hasFfmpeg: async () => true,
      transcode,
    });
    try {
      const url = `/cast/relay/${mint({ kind: 'remote', pageUrl: 'https://page.example/supersede' })}`;

      const first = app.inject({ method: 'GET', url });
      await vi.waitFor(() => expect(transcoders).toHaveLength(1));

      // A receiver retry (same signed URL) while the first encoder still runs.
      const second = app.inject({ method: 'GET', url });
      await vi.waitFor(() => expect(transcoders).toHaveLength(2));
      expect(transcoders[0].kill).toHaveBeenCalled();

      const [firstResponse, secondResponse] = await Promise.all([first, second]);
      expect(firstResponse.statusCode).toBe(200);
      expect(secondResponse.statusCode).toBe(200);

      // Both streams have torn down and unregistered: the second's kill now
      // comes from its own cleanup, and a third GET starts a fresh encoder
      // without a stale request's teardown firing.
      await vi.waitFor(() => expect(transcoders[1].kill).toHaveBeenCalled());
      const secondKills = transcoders[1].kill.mock.calls.length;
      const third = await app.inject({ method: 'GET', url });
      expect(third.statusCode).toBe(200);
      expect(transcoders).toHaveLength(3);
      expect(transcodeCalls).toHaveLength(3);
      expect(transcoders[1].kill.mock.calls.length).toBe(secondKills);
      expect(transcoders[2].kill).toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('serves a catalog file with Range and refuses traversal or a missing file', async () => {
    const app = await makeApp();
    try {
      const token = mint({ kind: 'catalog', file: 'song.mp3' });
      const full = await app.inject({ method: 'GET', url: `/cast/relay/${token}` });
      expect(full.statusCode).toBe(200);
      expect(full.headers['content-type']).toBe('audio/mpeg');
      expect(full.headers['accept-ranges']).toBe('bytes');
      expect(full.headers['cache-control']).toBe('no-store');
      expect(full.headers['x-content-type-options']).toBe('nosniff');
      expect(full.headers['content-disposition']).toBe('inline');
      expect(full.rawPayload.equals(CATALOG_BODY)).toBe(true);

      const ranged = await app.inject({
        method: 'GET',
        url: `/cast/relay/${token}`,
        headers: { range: 'bytes=2-5' },
      });
      expect(ranged.statusCode).toBe(206);
      expect(ranged.headers['content-range']).toBe(`bytes 2-5/${CATALOG_BODY.length}`);
      expect(ranged.rawPayload.equals(CATALOG_BODY.subarray(2, 6))).toBe(true);

      for (const file of ['../secret.mp3', 'missing.mp3']) {
        const bad = await app.inject({ method: 'GET', url: `/cast/relay/${mint({ kind: 'catalog', file })}` });
        expect(bad.statusCode).toBe(404);
        expect(bad.json()).toEqual({ error: 'not-found' });
      }
    } finally {
      await app.close();
    }
  });

  it('never writes relay tokens to the logs', async () => {
    let output = '';
    const stream = new Writable({
      write(chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void) {
        output += chunk.toString();
        callback();
      },
    });
    const app = await makeApp({ logger: { level: 'info', stream } });
    try {
      const token = mint({ kind: 'remote', pageUrl: 'https://page.example/logs' });
      const ok = await app.inject({ method: 'GET', url: `/cast/relay/${token}` });
      expect(ok.statusCode).toBe(200);

      const tampered = `${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`;
      const bad = await app.inject({ method: 'GET', url: `/cast/relay/${tampered}` });
      expect(bad.statusCode).toBe(404);

      let limited = false;
      for (let i = 0; i < 40 && !limited; i += 1) {
        const result = await app.inject({ method: 'GET', url: `/cast/relay/${tampered}` });
        if (result.statusCode === 429) limited = true;
        else expect(result.statusCode).toBe(404);
      }
      expect(limited).toBe(true);

      app.log.info('cast relay log capture marker');
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(output).toContain('cast relay log capture marker');
      expect(output).not.toContain(token);
      expect(output).not.toContain(tampered);
    } finally {
      await app.close();
    }
  });

  it('refuses a resolved URL the validator rejects without fetching it', async () => {
    const metadata = 'http://169.254.169.254/latest/meta-data';
    let target = metadata;
    const rejectAll = vi.fn(async (): Promise<ValidatedUrl> => {
      throw new UrlRejectedError('url host is not allowed');
    });
    const app = await makeApp({
      resolve: async () => ({ url: target, mimeType: 'audio/mpeg', track }),
      validate: rejectAll,
    });
    try {
      const blocked = await app.inject({
        method: 'GET',
        url: `/cast/relay/${mint({ kind: 'remote', pageUrl: 'https://page.example/meta' })}`,
      });
      expect(blocked.statusCode).toBe(502);
      expect(blocked.json()).toEqual({ error: 'unavailable' });
      expect(upstreamHits).toBe(0);

      // A validator rejection of the upstream itself must also prevent the fetch.
      target = `${upstreamBase}/audio`;
      const refused = await app.inject({
        method: 'GET',
        url: `/cast/relay/${mint({ kind: 'remote', pageUrl: 'https://page.example/local' })}`,
      });
      expect(refused.statusCode).toBe(502);
      expect(refused.json()).toEqual({ error: 'unavailable' });
      expect(upstreamHits).toBe(0);
      expect(rejectAll).toHaveBeenCalledTimes(2);
    } finally {
      await app.close();
    }
  });

  it('refuses a redirect to a rejected host', async () => {
    const validate = vi.fn(async (url: string): Promise<ValidatedUrl> => {
      if (new URL(url).hostname === '169.254.169.254') throw new UrlRejectedError('url host is not allowed');
      return { url, addresses: ['127.0.0.1'] };
    });
    const app = await makeApp({
      resolve: async () => ({ url: `${upstreamBase}/redirect`, mimeType: 'audio/mpeg', track }),
      validate,
    });
    try {
      const refused = await app.inject({
        method: 'GET',
        url: `/cast/relay/${mint({ kind: 'remote', pageUrl: 'https://page.example/redirect' })}`,
      });
      expect(refused.statusCode).toBe(502);
      expect(refused.json()).toEqual({ error: 'unavailable' });
      expect(upstreamHits).toBe(1);
      expect(validate).toHaveBeenCalledTimes(2);
      expect(validate.mock.calls[1][0]).toContain('169.254.169.254');
    } finally {
      await app.close();
    }
  });

  it('limits invalid tokens per IP', async () => {
    const app = await makeApp();
    try {
      for (let i = 0; i < 30; i += 1) {
        const result = await app.inject({ method: 'GET', url: '/cast/relay/not-a-token' });
        expect(result.statusCode).toBe(404);
        expect(result.json()).toEqual({ error: 'not-found' });
      }
      const limited = await app.inject({ method: 'GET', url: '/cast/relay/not-a-token' });
      expect(limited.statusCode).toBe(429);
      expect(limited.json()).toEqual({ error: 'too-many-requests' });
    } finally {
      await app.close();
    }
  });

  it('answers 503 for the whole /cast tree when the relay is disabled', async () => {
    const app = await makeApp({ relay: null });
    try {
      const result = await app.inject({ method: 'GET', url: '/cast/relay/anything' });
      expect(result.statusCode).toBe(503);
      expect(result.json()).toEqual({ error: 'cast-disabled' });
    } finally {
      await app.close();
    }
  });

  it('answers 503 for an upload plan when no upload cache is configured', async () => {
    const app = await makeApp();
    try {
      const result = await app.inject({
        method: 'GET',
        url: `/cast/relay/${mint({ kind: 'upload', uploadId: `${'a'.repeat(64)}.mp3` })}`,
      });
      expect(result.statusCode).toBe(503);
      expect(result.json()).toEqual({ error: 'cast-disabled' });
    } finally {
      await app.close();
    }
  });

  it('serves an upload plan through the relay when an upload cache is configured', async () => {
    const cache = new UploadCache({
      dataDir: uploadsDir,
      capBytes: 1024 * 1024,
      maxUploadBytes: 1024 * 1024,
      liveUploads: () => relay.liveUploads(),
    });
    const stored = await cache.store('user-1', Readable.from([AUDIO_BODY]), 'mp3');
    const app = await makeApp({ uploads: cache });
    try {
      const token = mint({ kind: 'upload', uploadId: stored.uploadId });

      const full = await app.inject({ method: 'GET', url: `/cast/relay/${token}` });
      expect(full.statusCode).toBe(200);
      expect(full.headers['content-type']).toBe('audio/mpeg');
      expect(full.headers['content-length']).toBe(String(AUDIO_BODY.length));
      expect(full.headers['accept-ranges']).toBe('bytes');
      expect(full.headers['cache-control']).toBe('no-store');
      expect(full.headers['x-content-type-options']).toBe('nosniff');
      expect(full.rawPayload.equals(AUDIO_BODY)).toBe(true);

      const ranged = await app.inject({
        method: 'GET',
        url: `/cast/relay/${token}`,
        headers: { range: 'bytes=0-1' },
      });
      expect(ranged.statusCode).toBe(206);
      expect(ranged.headers['content-range']).toBe(`bytes 0-1/${AUDIO_BODY.length}`);
      expect(ranged.rawPayload.equals(AUDIO_BODY.subarray(0, 2))).toBe(true);
    } finally {
      await app.close();
    }
  });
});
