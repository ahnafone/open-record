import { randomBytes } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { SignJWT } from 'jose';
import { buildApp } from '../app';
import { loadConfig, type ServerConfig } from '../config';
import { MediaRelay } from '../services/media-relay';
import { UploadCache } from '../services/upload-cache';
import { castUploadRoutes, serveRelayUpload } from './cast-uploads';

const TOKEN = 'test-token-0123456789abcdef';
const SECRET = 'super-secret-jwt-token-with-at-least-32-characters';
const MB = 1024 * 1024;

interface UploadResponse {
  uploadId: string;
  sizeBytes: number;
  expiresAt: number;
  error?: string;
}

const sign = (sub: string): Promise<string> =>
  new SignJWT({ role: 'authenticated' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(sub)
    .setAudience('authenticated')
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(new TextEncoder().encode(SECRET));

const bearer = async (user: string): Promise<Record<string, string>> => ({
  authorization: `Bearer ${await sign(user)}`,
});

describe('cast upload routes', () => {
  let config: ServerConfig;
  let dataDir: string;
  let relay: MediaRelay;
  let cache: UploadCache;
  let app: FastifyInstance;
  let base: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'open-record-cast-uploads-'));
    config = loadConfig({
      OPEN_RECORD_TOKEN: TOKEN,
      SUPABASE_JWT_SECRET: SECRET,
      OPEN_RECORD_DATA_DIR: dataDir,
      CAST_MEDIA_BASE_URL: 'http://127.0.0.1:8787',
      CAST_CACHE_MB: '8',
      CAST_UPLOAD_MAX_MB: '1',
    });
    relay = new MediaRelay({
      secret: randomBytes(32),
      dataDir,
      baseUrl: config.castMediaBaseUrl as string,
      ttlMs: 900_000,
      pruneMs: 0,
    });
    cache = new UploadCache({
      dataDir,
      capBytes: 8 * MB,
      maxUploadBytes: 1 * MB,
      liveUploads: () => relay.liveUploads(),
    });

    app = await buildApp(config, {
      cast: { relay, uploads: cache },
      routes: [
        castUploadRoutes,
        // Stand-in for the public relay route's `case 'upload'` (the real one
        // lives in routes/cast.ts, owned by another change).
        async (instance) => {
          instance.get<{ Params: { token: string } }>(
            '/test/relay/:token',
            { config: { public: true } },
            async (request, reply) => {
              const entry = relay.verify(request.params.token);
              if (!entry) return reply.code(404).send({ error: 'not-found' });
              return serveRelayUpload(cache, entry, request, reply);
            },
          );
        },
      ],
    });
    await app.listen({ port: 0, host: '127.0.0.1' });
    base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await app.close();
    relay.dispose();
    await rm(dataDir, { recursive: true, force: true });
  });

  async function postUpload(
    token: string,
    body: Buffer,
    filename = 'song.mp3',
  ): Promise<{ status: number; json: UploadResponse }> {
    const form = new FormData();
    form.append('file', new Blob([body], { type: 'audio/mpeg' }), filename);
    const response = await fetch(`${base}/cast/uploads`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: form,
    });
    return { status: response.status, json: (await response.json()) as UploadResponse };
  }

  function mintUpload(userId: string, uploadId: string): string {
    const made = relay.create({ userId, trackId: 'track-1', plan: { kind: 'upload', uploadId } });
    return new URL(made.url).pathname.split('/').pop() ?? '';
  }

  it('rejects a request without a token', async () => {
    const form = new FormData();
    form.append('file', new Blob([Buffer.from('x')]), 'song.mp3');
    const response = await fetch(`${base}/cast/uploads`, { method: 'POST', body: form });
    expect(response.status).toBe(401);
  });

  it('refuses the static token (account required)', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/cast/uploads/usage',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: 'account-required' });
  });

  it('stores a multipart file for the caller and reports its id and size', async () => {
    const jwt = await sign('user-a');
    const body = Buffer.from('uploaded audio bytes');
    const { status, json } = await postUpload(jwt, body, 'Song.MP3');

    expect(status).toBe(200);
    expect(json.uploadId).toMatch(/^[a-f0-9]{64}\.mp3$/);
    expect(json.sizeBytes).toBe(body.length);
    expect(json.expiresAt).toBeGreaterThan(Date.now());

    const path = join(dataDir, 'cast', 'user-a', json.uploadId);
    expect((await readFile(path)).equals(body)).toBe(true);
  });

  it('dedupes the same bytes uploaded twice', async () => {
    const jwt = await sign('user-a');
    const body = Buffer.from('same bytes');
    const first = await postUpload(jwt, body);
    const second = await postUpload(jwt, body);

    expect(second.json.uploadId).toBe(first.json.uploadId);
    expect(await readdir(join(dataDir, 'cast', 'user-a'))).toHaveLength(1);
  });

  it('rejects an oversize upload and keeps nothing on disk', async () => {
    const jwt = await sign('user-a');
    const { status, json } = await postUpload(jwt, Buffer.alloc(MB + 1, 1));

    expect(status).toBe(413);
    expect(json).toEqual({ error: 'file-too-large' });
    expect(await readdir(join(dataDir, 'cast', 'user-a'))).toEqual([]);
  });

  it('scopes usage to the caller', async () => {
    const uploaded = await postUpload(await sign('user-a'), Buffer.from('scoped'));
    expect(uploaded.status).toBe(200);

    const mine = await app.inject({
      method: 'GET',
      url: '/cast/uploads/usage',
      headers: await bearer('user-a'),
    });
    expect(mine.statusCode).toBe(200);
    expect(mine.json()).toEqual({ bytes: 6, count: 1, cap: 8 * MB });

    const theirs = await app.inject({
      method: 'GET',
      url: '/cast/uploads/usage',
      headers: await bearer('user-b'),
    });
    expect(theirs.statusCode).toBe(200);
    expect(theirs.json()).toEqual({ bytes: 0, count: 0, cap: 8 * MB });
  });

  it('scopes DELETE to the caller', async () => {
    const { json } = await postUpload(await sign('user-a'), Buffer.from('scoped'));

    const foreign = await app.inject({
      method: 'DELETE',
      url: '/cast/uploads',
      headers: await bearer('user-b'),
    });
    expect(foreign.json()).toEqual({ freedBytes: 0, retainedBytes: 0 });

    const mine = await app.inject({
      method: 'DELETE',
      url: '/cast/uploads',
      headers: await bearer('user-a'),
    });
    expect(mine.json()).toEqual({ freedBytes: 6, retainedBytes: 0 });
    expect(
      await readdir(join(dataDir, 'cast', 'user-a')).then((names) => names.includes(json.uploadId)),
    ).toBe(false);
  });

  it('keeps a file referenced by a live relay plan when clearing', async () => {
    const { json } = await postUpload(await sign('user-a'), Buffer.from('playing'));
    mintUpload('user-a', json.uploadId);

    const cleared = await app.inject({
      method: 'DELETE',
      url: '/cast/uploads',
      headers: await bearer('user-a'),
    });
    expect(cleared.json()).toEqual({ freedBytes: 0, retainedBytes: 7 });
    expect(await readdir(join(dataDir, 'cast', 'user-a'))).toHaveLength(1);
  });

  it('serves a ranged upload stream with the right headers', async () => {
    const body = Buffer.from('abcdefghij');
    const { json } = await postUpload(await sign('user-a'), body);
    const token = mintUpload('user-a', json.uploadId);

    const response = await app.inject({
      method: 'GET',
      url: `/test/relay/${token}`,
      headers: { range: 'bytes=0-1' },
    });
    expect(response.statusCode).toBe(206);
    expect(response.headers['content-type']).toBe('audio/mpeg');
    expect(response.headers['content-range']).toBe(`bytes 0-1/${body.length}`);
    expect(response.headers['content-length']).toBe('2');
    expect(response.headers['accept-ranges']).toBe('bytes');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['content-disposition']).toBe('inline');
    expect(response.rawPayload.equals(body.subarray(0, 2))).toBe(true);
  });

  it('answers 410 for an upload plan whose file does not exist', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/test/relay/${mintUpload('user-a', `${'f'.repeat(64)}.mp3`)}`,
    });
    expect(response.statusCode).toBe(410);
    expect(response.json()).toEqual({ error: 'unavailable' });
  });

  it('answers 503 for every upload endpoint when no cache is wired', async () => {
    const disabled = await buildApp(config, {
      cast: { relay },
      routes: [castUploadRoutes],
    });
    try {
      const response = await disabled.inject({
        method: 'GET',
        url: '/cast/uploads/usage',
        headers: await bearer('user-a'),
      });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({ error: 'uploads-disabled' });
    } finally {
      await disabled.close();
    }
  });
});
