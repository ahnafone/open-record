import { createResolveCache, type CacheableStream } from './stream-cache';

describe('resolve cache', () => {
  it('de-duplicates in-flight resolves and serves later calls from cache until expiry', async () => {
    let clock = Date.parse('2026-01-01T00:00:00Z');
    let release!: (v: CacheableStream) => void;
    const resolve = vi.fn(
      () =>
        new Promise<CacheableStream>((r) => {
          release = r;
        }),
    );
    const cache = createResolveCache({ ttlMs: 3_600_000, resolve, now: () => clock });

    const a = cache.get('https://example.com/a');
    const b = cache.get('https://example.com/a');
    release({ expiresAt: new Date(clock + 600_000).toISOString() });
    expect(await a).toEqual(await b);
    expect(resolve).toHaveBeenCalledTimes(1);

    await cache.get('https://example.com/a');
    expect(resolve).toHaveBeenCalledTimes(1);

    // Past the link's own expiry (minus the safety margin): resolve again.
    clock += 600_000;
    const next = cache.get('https://example.com/a');
    release({});
    await next;
    expect(resolve).toHaveBeenCalledTimes(2);
  });
});
