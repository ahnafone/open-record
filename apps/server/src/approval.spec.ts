import type { FastifyInstance } from 'fastify';
import { SignJWT } from 'jose';
import { buildApp } from './app';
import { ConfigError, loadConfig } from './config';
import { appConfigRoutes } from './routes/health';

const TOKEN = 'test-token-0123456789abcdef';
const JWT_SECRET = 'super-secret-jwt-token-with-at-least-32-characters';
const SERVICE_KEY = 'service-role-key-never-leaves-the-server';
const SUPABASE_URL = 'https://proj.supabase.co';

const ADMIN = '00000000-0000-4000-8000-000000000001';
const APPROVED = '11111111-1111-4111-8111-111111111111';
const PENDING = '22222222-2222-4222-8222-222222222222';
const DENIED = '33333333-3333-4333-8333-333333333333';
const REVOKED = '44444444-4444-4444-8444-444444444444';
const UNKNOWN = '55555555-5555-4555-8555-555555555555';
const BROKEN = '66666666-6666-4666-8666-666666666666';

/** Fake PostgREST: one row per user (no row = unknown), or a network error. */
const STATUS: Record<string, string> = {
  [APPROVED]: 'approved',
  [PENDING]: 'pending',
  [DENIED]: 'denied',
  [REVOKED]: 'revoked',
};

const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const headers = new Headers(init?.headers);
  const userId = /user_id=eq\.([^&]+)/.exec(url.search)?.[1] ?? '';
  if (url.origin !== SUPABASE_URL || headers.get('apikey') !== SERVICE_KEY) {
    return new Response('forbidden', { status: 403 });
  }
  if (userId === BROKEN) throw new Error('connection reset');
  const status = STATUS[userId];
  const rows = status ? [{ status }] : [];
  return new Response(JSON.stringify(rows), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}) as unknown as typeof fetch;

const sign = (sub: string) =>
  new SignJWT({ role: 'authenticated' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(sub)
    .setAudience('authenticated')
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(new TextEncoder().encode(JWT_SECRET));

describe('approval gate (REQUIRE_APPROVAL)', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    const config = loadConfig({
      OPEN_RECORD_TOKEN: TOKEN,
      SUPABASE_JWT_SECRET: JWT_SECRET,
      SUPABASE_URL,
      SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY,
      SUPABASE_ANON_KEY: 'public-anon-key',
      REQUIRE_APPROVAL: 'true',
      ADMIN_USER_ID: ADMIN.toUpperCase(),
      TURNSTILE_SITE_KEY: '0x4AAAAAAA-public',
    });
    app = await buildApp(config, {
      cast: false,
      fetchImpl: fakeFetch,
      routes: [
        appConfigRoutes,
        async (a) => {
          a.get('/whoami', async (request) => ({ userId: request.userId }));
        },
      ],
    });
  });

  afterAll(() => app.close());

  const whoami = async (token: string) =>
    app.inject({ method: 'GET', url: '/whoami', headers: { authorization: `Bearer ${token}` } });

  it.each([
    ['has no access request', UNKNOWN],
    ['is pending', PENDING],
    ['was denied', DENIED],
    ['was revoked', REVOKED],
    ['cannot be looked up', BROKEN],
  ])('refuses a signed-in user who %s with 403, not 401', async (_label, sub) => {
    const res = await whoami(await sign(sub));
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'access-not-approved' });
    expect(res.headers['www-authenticate']).toBeUndefined();
  });

  it('lets an approved user through', async () => {
    const res = await whoami(await sign(APPROVED));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ userId: APPROVED });
  });

  it('lets the admin through without an access request', async () => {
    const res = await whoami(await sign(ADMIN));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ userId: ADMIN });
  });

  it('leaves the static token (owner) unaffected', async () => {
    const res = await whoami(TOKEN);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ userId: null });
  });

  it('keeps the public Turnstile key in /app-config and never the service-role key', async () => {
    const res = await app.inject({ method: 'GET', url: '/app-config' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      supabaseUrl: SUPABASE_URL,
      supabaseAnonKey: 'public-anon-key',
      turnstileSiteKey: '0x4AAAAAAA-public',
    });
    expect(res.body).not.toContain(SERVICE_KEY);
  });
});

describe('approval gate configuration', () => {
  const base = { OPEN_RECORD_TOKEN: TOKEN };

  it('is off by default', () => {
    const config = loadConfig(base);
    expect(config.requireApproval).toBe(false);
    expect(config.supabaseServiceRoleKey).toBeNull();
    expect(config.adminUserId).toBeNull();
    expect(config.appConfig.turnstileSiteKey).toBeNull();
  });

  it('refuses REQUIRE_APPROVAL without the Supabase URL or service-role key', () => {
    expect(() => loadConfig({ ...base, REQUIRE_APPROVAL: 'true', SUPABASE_SERVICE_ROLE_KEY: 'k' })).toThrow(
      ConfigError,
    );
    expect(() => loadConfig({ ...base, REQUIRE_APPROVAL: 'true', SUPABASE_URL: SUPABASE_URL })).toThrow(
      ConfigError,
    );
  });

  it('rejects an ADMIN_USER_ID that is not a UUID', () => {
    expect(() => loadConfig({ ...base, ADMIN_USER_ID: 'not-a-uuid' })).toThrow(ConfigError);
  });
});
