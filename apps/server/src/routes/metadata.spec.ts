import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app';
import { loadConfig } from '../config';
import { metadataRoutes } from './metadata';

describe('GET /metadata', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    const config = loadConfig({ OPEN_RECORD_TOKEN: 'test-token-0123456789abcdef', DATA_DIR: '/tmp/unused' });
    app = await buildApp(config, { routes: [metadataRoutes] });
  });

  afterAll(() => app.close());

  it('requires the bearer token', async () => {
    const res = await app.inject({ method: 'GET', url: '/metadata?title=Midnight%20City' });
    expect(res.statusCode).toBe(401);
  });
});
