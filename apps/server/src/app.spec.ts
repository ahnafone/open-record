import type { FastifyInstance } from 'fastify';
import { SignJWT } from 'jose';
import { buildApp } from './app';
import { loadConfig } from './config';

const TOKEN = 'test-token-0123456789abcdef';

describe('server auth', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    const config = loadConfig({ OPEN_RECORD_TOKEN: TOKEN });
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

describe('server auth with Supabase JWTs', () => {
  const SECRET = 'super-secret-jwt-token-with-at-least-32-characters';
  let app: FastifyInstance;

  const sign = (
    secret = SECRET,
    { exp = '1h', aud = 'authenticated', sub = 'user-1' }: { exp?: string | number; aud?: string; sub?: string } = {},
  ) =>
    new SignJWT({ role: 'authenticated' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(sub)
      .setAudience(aud)
      .setIssuedAt()
      .setExpirationTime(exp)
      .sign(new TextEncoder().encode(secret));

  const get = (token: string) =>
    app.inject({ method: 'GET', url: '/whoami', headers: { authorization: `Bearer ${token}` } });

  beforeAll(async () => {
    const config = loadConfig({ OPEN_RECORD_TOKEN: TOKEN, SUPABASE_JWT_SECRET: SECRET });
    app = await buildApp(config, {
      routes: [async (a) => void a.get('/whoami', async (request) => ({ userId: request.userId }))],
    });
  });

  afterAll(() => app.close());

  it('accepts a valid Supabase access token and exposes the user id', async () => {
    const res = await get(await sign());
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ userId: 'user-1' });
  });

  it('rejects a wrong signature, an expired token and a non-user (anon) audience', async () => {
    expect((await get(await sign('another-secret-that-is-at-least-32-chars!!'))).statusCode).toBe(401);
    expect((await get(await sign(SECRET, { exp: Math.floor(Date.now() / 1000) - 60 }))).statusCode).toBe(401);
    expect((await get(await sign(SECRET, { aud: 'anon' }))).statusCode).toBe(401);
  });

  it('still accepts the static token (no user id)', async () => {
    const res = await get(TOKEN);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ userId: null });
  });
});
