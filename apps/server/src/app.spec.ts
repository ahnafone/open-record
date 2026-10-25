import type { FastifyInstance } from 'fastify';
import { buildApp } from './app';
import { loadConfig } from './config';

const TOKEN = 'test-token-0123456789abcdef';

describe('server auth', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    const config = loadConfig({ OPEN_RECORD_TOKEN: TOKEN, DATA_DIR: '/tmp/unused' });
    app = await buildApp(config, {
      routes: [
        async (a) => {
          a.get('/health', { config: { public: true } }, async () => ({ status: 'ok' }));
          a.get('/private', async () => ({ secret: true }));
        },
      ],
    });
  });

  afterAll(() => app.close());

  it('leaves GET /health open', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });

  it('rejects a missing token', async () => {
    const res = await app.inject({ method: 'GET', url: '/private' });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a bad token', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/private',
      headers: { authorization: `Bearer ${TOKEN}x` },
    });
    expect(res.statusCode).toBe(401);
  });

  it('requires auth on unknown routes', async () => {
    const res = await app.inject({ method: 'GET', url: '/nope' });
    expect(res.statusCode).toBe(401);
  });

  it('accepts the correct token', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/private',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
  });

  it('refuses to start without a token', () => {
    expect(() => loadConfig({})).toThrow(/OPEN_RECORD_TOKEN/);
  });
});
