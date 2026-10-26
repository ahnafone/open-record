import type { FastifyInstance } from 'fastify';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

  it('rejects no token, a wrong signature, an expired token and a non-user (anon) audience', async () => {
    expect((await app.inject({ method: 'GET', url: '/whoami' })).statusCode).toBe(401);
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

describe('GET /app-config', () => {
  const env = {
    OPEN_RECORD_TOKEN: TOKEN,
    SUPABASE_URL: 'https://abc.supabase.co/',
    SUPABASE_ANON_KEY: 'public-anon-key',
    SUPABASE_JWT_SECRET: 'super-secret-jwt-token-with-at-least-32-characters',
  };

  it('is public, not cached, and returns only the Supabase URL and anon key', async () => {
    const app = await buildApp(loadConfig(env));
    const res = await app.inject({ method: 'GET', url: '/app-config' });
    await app.close();
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.json()).toEqual({ supabaseUrl: 'https://abc.supabase.co', supabaseAnonKey: 'public-anon-key' });
    expect(res.body).not.toContain(env.SUPABASE_JWT_SECRET);
  });

  it('serves nulls without an anon key and rejects a key without a URL', async () => {
    const app = await buildApp(loadConfig({ OPEN_RECORD_TOKEN: TOKEN, SUPABASE_URL: env.SUPABASE_URL }));
    const res = await app.inject({ method: 'GET', url: '/app-config' });
    await app.close();
    expect(res.json()).toEqual({ supabaseUrl: null, supabaseAnonKey: null });
    expect(() => loadConfig({ OPEN_RECORD_TOKEN: TOKEN, SUPABASE_ANON_KEY: 'k' })).toThrow(/SUPABASE_URL/);
  });
});

describe('web app (WEB_DIR)', () => {
  let app: FastifyInstance;
  let dir: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'or-web-'));
    writeFileSync(join(dir, 'index.html'), '<!doctype html><title>Open Record</title>');
    writeFileSync(join(dir, 'main.js'), 'console.log(1)');
    app = await buildApp(loadConfig({ OPEN_RECORD_TOKEN: TOKEN, WEB_DIR: dir }));
  });

  afterAll(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const html = { accept: 'text/html' };

  it('serves index.html and assets without a token, with SPA fallback', async () => {
    const index = await app.inject({ method: 'GET', url: '/', headers: html });
    expect(index.statusCode).toBe(200);
    expect(index.body).toContain('Open Record');
    expect((await app.inject({ method: 'GET', url: '/main.js' })).body).toBe('console.log(1)');
    const deep = await app.inject({ method: 'GET', url: '/library/abc', headers: html });
    expect(deep.statusCode).toBe(200);
    expect(deep.body).toContain('Open Record');
  });

  it('does not shadow or open up the API', async () => {
    expect((await app.inject({ method: 'GET', url: '/search?q=x', headers: html })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/stream', payload: {} })).statusCode).toBe(401);
    const getStream = await app.inject({ method: 'GET', url: '/stream', headers: html });
    expect(getStream.body).not.toContain('Open Record');
    expect((await app.inject({ method: 'GET', url: '/health' })).json()).toEqual({ status: 'ok' });
    const appConfig = await app.inject({ method: 'GET', url: '/app-config', headers: html });
    expect(appConfig.json()).toEqual({ supabaseUrl: null, supabaseAnonKey: null });
  });
});
