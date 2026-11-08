import { createAccessGate } from './access-gate';

const SUPABASE_URL = 'https://proj.supabase.co';
const SERVICE_KEY = 'service-role-key-never-leaves-the-server';
const USER = '11111111-1111-4111-8111-111111111111';
const TTL_MS = 60_000;
const ERROR_TTL_MS = 3_000;

/** Fake PostgREST that counts lookups; `rows` is what it answers with. */
function fakeFetch(answer: () => Response | Promise<Response>) {
  const calls = { count: 0 };
  const fetchImpl = (async () => {
    calls.count += 1;
    return answer();
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const rows = (status: string | null): Response =>
  new Response(JSON.stringify(status ? [{ status }] : []), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

describe('access gate cache', () => {
  it('caches an approval for the positive TTL, then looks it up again', async () => {
    let clock = 0;
    const { fetchImpl, calls } = fakeFetch(() => rows('approved'));
    const gate = createAccessGate({
      supabaseUrl: SUPABASE_URL,
      serviceRoleKey: SERVICE_KEY,
      ttlMs: TTL_MS,
      fetchImpl,
      now: () => clock,
    });

    expect(await gate(USER)).toBe(true);
    clock = TTL_MS - 1;
    expect(await gate(USER)).toBe(true);
    expect(calls.count).toBe(1);

    clock = TTL_MS;
    expect(await gate(USER)).toBe(true);
    expect(calls.count).toBe(2);
  });

  it('caches a denial for the negative TTL too', async () => {
    let clock = 0;
    let status = 'pending';
    const { fetchImpl, calls } = fakeFetch(() => rows(status));
    const gate = createAccessGate({
      supabaseUrl: SUPABASE_URL,
      serviceRoleKey: SERVICE_KEY,
      ttlMs: TTL_MS,
      fetchImpl,
      now: () => clock,
    });

    expect(await gate(USER)).toBe(false);
    status = 'approved';
    clock = TTL_MS - 1;
    expect(await gate(USER)).toBe(false);
    expect(calls.count).toBe(1);

    // Once the denial expires, the approval granted meanwhile is seen.
    clock = TTL_MS;
    expect(await gate(USER)).toBe(true);
    expect(calls.count).toBe(2);
  });

  it('fails closed on a lookup error and retries after the short error TTL', async () => {
    let clock = 0;
    let fail = true;
    const { fetchImpl, calls } = fakeFetch(() => {
      if (fail) throw new Error('connection reset');
      return rows('approved');
    });
    const gate = createAccessGate({
      supabaseUrl: SUPABASE_URL,
      serviceRoleKey: SERVICE_KEY,
      ttlMs: TTL_MS,
      fetchImpl,
      now: () => clock,
    });

    expect(await gate(USER)).toBe(false);
    clock = ERROR_TTL_MS - 1;
    expect(await gate(USER)).toBe(false);
    expect(calls.count).toBe(1);

    // The error answer lasts 3 s, not the 60 s approval TTL.
    fail = false;
    clock = ERROR_TTL_MS;
    expect(await gate(USER)).toBe(true);
    expect(calls.count).toBe(2);
  });

  it('shares one lookup between concurrent checks for the same user', async () => {
    let release: (response: Response) => void = () => undefined;
    const pending = new Promise<Response>((resolve) => {
      release = resolve;
    });
    const { fetchImpl, calls } = fakeFetch(() => pending);
    const gate = createAccessGate({
      supabaseUrl: SUPABASE_URL,
      serviceRoleKey: SERVICE_KEY,
      fetchImpl,
    });

    const first = gate(USER);
    const second = gate(USER);
    release(rows('approved'));
    expect(await Promise.all([first, second])).toEqual([true, true]);
    expect(calls.count).toBe(1);
  });
});
