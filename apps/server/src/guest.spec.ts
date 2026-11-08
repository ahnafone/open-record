import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildApp } from './app';
import { loadConfig } from './config';
import { createGuestLimiter } from './services/guest-limit';
import {
  configureCookies,
  configureResolveLimits,
  enrichMissingArtists,
  resolveUrl,
  search,
  type SearchResult,
} from './services/ytdlp';

vi.mock('node:child_process', () => ({ execFile: vi.fn(), spawn: vi.fn() }));

const TOKEN = 'test-token-0123456789abcdef';
const GUEST_ROUTE = '/guest-search';
const SERVICE_KEY = 'service-role-key-never-leaves-the-server';
const SUPABASE_URL = 'https://proj.supabase.co';

/** The real route table (no test routes), with cast off. */
const buildReal = (env: Record<string, string>, accessGate?: (userId: string) => Promise<boolean>) =>
  buildApp(loadConfig({ OPEN_RECORD_TOKEN: TOKEN, ...env }), { cast: false, accessGate });

describe('guest limits', () => {
  it('spends the day budget only on allowed requests: a minute refusal does not use it up', () => {
    const clock = { t: 0 };
    const limit = createGuestLimiter({
      perMinute: 1,
      perDay: 2,
      globalPerMinute: 100,
      now: () => clock.t,
    });
    expect(limit('a')).toBeNull(); // day 1
    expect(limit('a')?.window).toBe('minute'); // refused, day budget untouched
    clock.t += 61_000;
    expect(limit('a')).toBeNull(); // day 2
    clock.t += 61_000;
    expect(limit('a')?.window).toBe('day');
  });

  it('a day refusal does not spend the shared global budget', () => {
    const limit = createGuestLimiter({ perMinute: 10, perDay: 1, globalPerMinute: 2, now: () => 0 });
    expect(limit('a')).toBeNull(); // global 1, day 1
    expect(limit('a')?.window).toBe('day'); // refused: global must stay at 1
    expect(limit('a')?.window).toBe('day');
    expect(limit('b')).toBeNull(); // global 2: only possible if the refusals spent nothing
    expect(limit('c')?.window).toBe('global');
  });

  it('a minute refusal does not spend the shared global budget either', () => {
    const limit = createGuestLimiter({ perMinute: 1, perDay: 100, globalPerMinute: 2, now: () => 0 });
    expect(limit('a')).toBeNull();
    expect(limit('a')?.window).toBe('minute');
    expect(limit('b')).toBeNull();
    expect(limit('c')?.window).toBe('global');
  });
});

/** yt-dlp stand-in: `reply` picks what each run gets; `hold` leaves it unanswered until released. */
type Reply = { stdout?: string; stderr?: string; hold?: boolean };
function fakeYtDlp(reply: (args: string[]) => Reply) {
  const calls: string[][] = [];
  const released: (() => void)[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  vi.mocked(execFile).mockImplementation(((_bin: string, args: string[], _opts: unknown, done: (...a: unknown[]) => void) => {
    calls.push(args);
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    const r = reply(args);
    const finish = () => {
      inFlight--;
      if (r.stderr !== undefined && r.stdout === undefined) {
        done(Object.assign(new Error('failed'), { code: 1 }), '', r.stderr);
      } else {
        done(null, r.stdout ?? '', '');
      }
    };
    if (r.hold) released.push(finish);
    else setTimeout(finish, 0);
    return undefined;
  }) as unknown as typeof execFile);
  return { calls, released, maxInFlight: () => maxInFlight };
}

const SIGN_IN_ERROR = 'ERROR: [youtube] abc: Sign in to confirm your age. This video may be inappropriate for some users.';
const VIDEO_INFO = JSON.stringify({
  id: 'aaaaaaaaaaa',
  title: 'Song',
  webpage_url: 'https://www.youtube.com/watch?v=aaaaaaaaaaa',
  uploader: 'Artist',
});

describe('guest yt-dlp lane', () => {
  let jarDir: string | undefined;

  beforeEach(() => {
    vi.mocked(execFile).mockReset();
    // Fresh guest slots (one for guests) and a clean cookie setting for every test.
    configureResolveLimits(2, undefined, 1);
    configureCookies(null);
  });

  afterEach(() => {
    vi.mocked(execFile).mockReset();
    configureCookies(null);
    if (jarDir) rmSync(jarDir, { recursive: true, force: true });
    jarDir = undefined;
  });

  /** Points the server at a usable Netscape cookies file for this test. */
  function useCookies(): void {
    jarDir = mkdtempSync(join(tmpdir(), 'open-record-guest-spec-'));
    const jar = join(jarDir, 'cookies.txt');
    writeFileSync(jar, '# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t0\tSID\tvalue\n');
    configureCookies(jar);
  }

  it('never retries a guest sign-in refusal with cookies', async () => {
    useCookies();
    const fake = fakeYtDlp(() => ({ stderr: SIGN_IN_ERROR }));
    await expect(resolveUrl('https://www.youtube.com/watch?v=aaaaaaaaaaa', 'guest')).rejects.toThrow(
      /confirm your age/,
    );
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]).not.toContain('--cookies');
    expect(fake.calls[0]).not.toContain('ejs:github');
  });

  it('keeps the member cookie retry: a sign-in refusal runs once more with the jar', async () => {
    useCookies();
    const fake = fakeYtDlp((args) => (args.includes('--cookies') ? { stdout: VIDEO_INFO } : { stderr: SIGN_IN_ERROR }));
    const result = await resolveUrl('https://www.youtube.com/watch?v=aaaaaaaaaaa', 'member');
    expect(result.title).toBe('Song');
    expect(fake.calls).toHaveLength(2);
    expect(fake.calls[0]).not.toContain('--cookies');
    expect(fake.calls[1]).toContain('--cookies');
    expect(fake.calls[1]).toContain('ejs:github');
  });

  it('runs guest enrichment one lookup at a time, at most three per search', async () => {
    const ids = ['enrichg0001', 'enrichg0002', 'enrichg0003', 'enrichg0004', 'enrichg0005'];
    const fake = fakeYtDlp((args) => {
      if (args.includes('--flat-playlist')) {
        return {
          stdout: JSON.stringify({
            entries: ids.map((id) => ({ _type: 'url', id, title: 'Song', url: `https://www.youtube.com/watch?v=${id}` })),
          }),
        };
      }
      return { stdout: VIDEO_INFO };
    });
    const results = await search('song', 'youtube', 'guest');
    const lookups = fake.calls.filter((args) => args.includes('--no-playlist'));
    expect(lookups).toHaveLength(3);
    expect(fake.maxInFlight()).toBe(1);
    expect(results.slice(0, 3).every((r) => r.artist === 'Artist')).toBe(true);
    expect(results.slice(3).every((r) => r.artist === '')).toBe(true);
  });

  it('stops guest enrichment at once when the guest slot is taken', async () => {
    // A held guest run takes the only guest slot.
    const fake = fakeYtDlp((args) => (args.at(-1)?.includes('holdholdho') ? { hold: true } : { stdout: VIDEO_INFO }));
    const holder = resolveUrl('https://www.youtube.com/watch?v=holdholdho', 'guest').catch(() => undefined);
    await vi.waitFor(() => expect(fake.calls).toHaveLength(1));

    const results: SearchResult[] = ['busyaaaaaa1', 'busyaaaaaa2', 'busyaaaaaa3'].map((id) => ({
      id,
      title: 'Song',
      artist: '',
      url: `https://www.youtube.com/watch?v=${id}`,
      site: 'youtube',
    }));
    await enrichMissingArtists(results, 'guest');
    expect(fake.calls.filter((args) => args.at(-1)?.includes('busyaaa'))).toHaveLength(0);
    expect(results.every((r) => r.artist === '')).toBe(true);

    fake.released.forEach((release) => release());
    await holder;
  });
});

/** A guest-enabled route and a token-only route, registered in place of the real ones. */
const routes = [
  async (a: FastifyInstance) => {
    a.get(GUEST_ROUTE, { config: { guest: true } }, async (request) => ({ userId: request.userId }));
    a.get('/private', async () => ({ secret: true }));
  },
];

const build = (env: Record<string, string>) =>
  buildApp(loadConfig({ OPEN_RECORD_TOKEN: TOKEN, ...env }), { cast: false, routes });

describe('guest streaming', () => {
  it('lets a signed-out caller use a guest route when GUEST_STREAMING is on', async () => {
    const app = await build({ GUEST_STREAMING: 'true' });
    const res = await app.inject({ method: 'GET', url: GUEST_ROUTE });
    await app.close();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ userId: null });
  });

  it('answers 401 to a signed-out caller when GUEST_STREAMING is off', async () => {
    const app = await build({});
    const guest = await app.inject({ method: 'GET', url: GUEST_ROUTE });
    const priv = await app.inject({ method: 'GET', url: '/private' });
    await app.close();
    expect(guest.statusCode).toBe(401);
    expect(priv.statusCode).toBe(401);
  });

  it('answers 429 guest_limit with Retry-After once the per-minute burst is used up', async () => {
    const app = await build({ GUEST_STREAMING: 'true', GUEST_STREAM_PER_MINUTE: '3' });
    for (let i = 0; i < 3; i++) {
      expect((await app.inject({ method: 'GET', url: GUEST_ROUTE })).statusCode).toBe(200);
    }
    const limited = await app.inject({ method: 'GET', url: GUEST_ROUTE });
    await app.close();
    expect(limited.statusCode).toBe(429);
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    expect(limited.json()).toEqual({ error: 'guest_limit', window: 'minute' });
  });

  it('keeps authenticated callers unchanged and outside the guest budget', async () => {
    const app = await build({ GUEST_STREAMING: 'true', GUEST_STREAM_PER_MINUTE: '1' });
    const authed = { authorization: `Bearer ${TOKEN}` };
    for (let i = 0; i < 5; i++) {
      const res = await app.inject({ method: 'GET', url: GUEST_ROUTE, headers: authed });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ userId: null });
    }
    // A presented but bad credential is never a guest, even on a guest route.
    const bad = await app.inject({ method: 'GET', url: GUEST_ROUTE, headers: { authorization: 'Bearer nope' } });
    expect(bad.statusCode).toBe(401);
    // The guest budget was never spent by the authenticated calls.
    expect((await app.inject({ method: 'GET', url: GUEST_ROUTE })).statusCode).toBe(200);
    await app.close();
  });

  it('ignores a spoofed X-Forwarded-For: rotating it does not open a new bucket', async () => {
    const app = await build({ GUEST_STREAMING: 'true', GUEST_STREAM_PER_MINUTE: '2' });
    const statuses: number[] = [];
    for (let i = 0; i < 3; i++) {
      const res = await app.inject({
        method: 'GET',
        url: GUEST_ROUTE,
        headers: { 'x-forwarded-for': `203.0.113.${i + 1}`, 'cf-connecting-ip': `198.51.100.${i + 1}` },
      });
      statuses.push(res.statusCode);
    }
    await app.close();
    expect(statuses).toEqual([200, 200, 429]);
  });

  it('lets guests past the approval gate on the real /search route', async () => {
    const app = await buildReal(
      {
        GUEST_STREAMING: 'true',
        REQUIRE_APPROVAL: 'true',
        SUPABASE_URL,
        SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY,
      },
      async () => false, // would refuse every signed-in user
    );
    // Bandcamp has no search: the route answers 400 without running yt-dlp.
    const res = await app.inject({ method: 'GET', url: '/search?q=x&source=bandcamp' });
    await app.close();
    expect(res.statusCode).toBe(400);
  });

  it('refuses guests a host outside GUEST_ALLOWED_HOSTS on /resolve and /stream, before any fetch', async () => {
    vi.mocked(execFile).mockClear();
    const app = await buildReal({ GUEST_STREAMING: 'true' });
    const urls = [
      'https://evil.example/track.mp3',
      'https://youtube.com.evil.example/watch?v=x', // lookalike suffix
      'https://youtube.com@evil.example/watch?v=x', // userinfo trick
      'https://notyoutube.com/watch?v=x', // lookalike prefix
      'https://evil.example/?next=youtube.com', // allowed name only in the query
    ];
    const results: { status: number; body: unknown }[] = [];
    for (const url of urls) {
      for (const route of ['/resolve', '/stream']) {
        const res = await app.inject({ method: 'POST', url: route, payload: { url } });
        results.push({ status: res.statusCode, body: res.json() });
      }
    }
    await app.close();
    expect(results.every((r) => r.status === 403 && (r.body as { error: string }).error === 'guest_host_not_allowed')).toBe(true);
    expect(execFile).not.toHaveBeenCalled();
  });

  it('caps all guests together at GUEST_GLOBAL_PER_MINUTE, whatever their addresses', async () => {
    const app = await buildReal({ GUEST_STREAMING: 'true', GUEST_GLOBAL_PER_MINUTE: '2' });
    const statuses: number[] = [];
    let last: unknown;
    for (let i = 0; i < 3; i++) {
      // Distinct client addresses: each has its own per-IP budget, the global cap is shared.
      const res = await app.inject({
        method: 'GET',
        url: '/search?q=x&source=bandcamp',
        remoteAddress: `198.51.100.${i + 10}`,
      });
      statuses.push(res.statusCode);
      last = res.json();
    }
    await app.close();
    expect(statuses).toEqual([400, 400, 429]);
    expect(last).toEqual({ error: 'guest_limit', window: 'global' });
  });

  it('caps guests at GUEST_MAX_CONCURRENT yt-dlp runs and leaves a slot for signed-in callers', async () => {
    vi.mocked(execFile).mockClear();
    const app = await buildReal({ GUEST_STREAMING: 'true' }); // defaults: 2 slots, 1 for guests
    const guest = app.inject({ method: 'GET', url: '/search?q=one' });
    await vi.waitFor(() => expect(execFile).toHaveBeenCalledTimes(1));

    const refused = await app.inject({ method: 'GET', url: '/search?q=two' });
    expect(refused.statusCode).toBe(503);
    expect(refused.json()).toEqual({ error: 'guest_busy' });

    const member = app.inject({
      method: 'GET',
      url: '/search?q=three',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    await vi.waitFor(() => expect(execFile).toHaveBeenCalledTimes(2));

    // Let the two yt-dlp runs fail so both requests finish.
    for (const call of vi.mocked(execFile).mock.calls) {
      const done = call.at(-1) as unknown as (err: Error, stdout: string, stderr: string) => void;
      done(Object.assign(new Error('stopped'), { code: 1 }), '', 'ERROR: stopped');
    }
    const [g, m] = await Promise.all([guest, member]);
    await app.close();
    expect(g.statusCode).toBe(502);
    expect(m.statusCode).toBe(502);
  });
});
