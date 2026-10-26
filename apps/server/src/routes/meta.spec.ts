import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app';
import { loadConfig } from '../config';
import { metaRoutes } from './meta';

const TOKEN = 'test-token-0123456789abcdef';

describe('GET /meta/aliases', () => {
  let app: FastifyInstance;
  const headers = { authorization: `Bearer ${TOKEN}` };

  beforeAll(async () => {
    app = await buildApp(loadConfig({ OPEN_RECORD_TOKEN: TOKEN }), { routes: [metaRoutes] });
  });

  afterAll(() => {
    vi.unstubAllGlobals();
    return app.close();
  });

  it('requires the bearer token', async () => {
    const res = await app.inject({ method: 'GET', url: '/meta/aliases?title=Lemon' });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a missing or oversized title', async () => {
    expect((await app.inject({ method: 'GET', url: '/meta/aliases?artist=x', headers })).statusCode).toBe(400);
    const long = 'a'.repeat(301);
    expect((await app.inject({ method: 'GET', url: `/meta/aliases?title=${long}`, headers })).statusCode).toBe(400);
  });

  it('answers empty lists when MusicBrainz fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new Error('offline'))));
    const res = await app.inject({ method: 'GET', url: '/meta/aliases?artist=Nobody&title=Nothing', headers });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ titles: [], artists: [] });
  });
});
