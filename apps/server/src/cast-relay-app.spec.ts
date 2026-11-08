import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildCastRelayApp } from './cast-relay-app';
import { loadConfig } from './config';
import { MediaRelay } from './services/media-relay';
import type { RouteOptions } from './routes';

/**
 * The relay listener is the only LAN-facing surface, so it must serve the relay
 * route and nothing else of the main API.
 */
describe('cast relay listener', () => {
  let dir: string;
  let relay: MediaRelay;
  let app: FastifyInstance;
  let token: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'open-record-relay-listener-'));
    await mkdir(join(dir, 'catalog', 'audio'), { recursive: true });
    await writeFile(join(dir, 'catalog', 'audio', 'song.mp3'), Buffer.from('0123456789'));

    const config = loadConfig({
      OPEN_RECORD_TOKEN: 'test-token-0123456789abcdef',
      CAST_MEDIA_BASE_URL: 'http://10.0.0.5:8788',
      WEB_DIR: dir,
    });
    relay = new MediaRelay({
      secret: randomBytes(32),
      dataDir: dir,
      baseUrl: 'http://10.0.0.5:8788',
      ttlMs: 900_000,
      pruneMs: 0,
    });
    const made = relay.create({
      userId: 'user-1',
      trackId: 'track-1',
      plan: { kind: 'catalog', file: 'song.mp3' },
    });
    token = new URL(made.url).pathname.split('/').pop() ?? '';

    app = await buildCastRelayApp({ config, relay } as RouteOptions);
  });

  afterAll(async () => {
    await app.close();
    relay.dispose();
    await rm(dir, { recursive: true, force: true });
  });

  it('serves the relay route for a valid token', async () => {
    const response = await app.inject({ method: 'GET', url: `/cast/relay/${token}` });
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe('0123456789');
  });

  it('answers 404 to a forged token and to every main API path', async () => {
    const forged = await app.inject({ method: 'GET', url: '/cast/relay/not-a-real-token' });
    expect(forged.statusCode).toBe(404);

    for (const url of ['/health', '/session', '/cast/devices', '/api/library']) {
      const response = await app.inject({ method: 'GET', url });
      expect(response.statusCode, url).toBe(404);
    }
  });
});
