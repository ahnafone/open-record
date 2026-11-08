import { canonicalMediaKey, createResolveCache, type CacheableStream } from './stream-cache';

describe('resolve cache bounds and keys', () => {
  it('evicts the oldest entry once maxEntries is reached', async () => {
    const resolve = vi.fn(async () => ({}) as CacheableStream);
    const cache = createResolveCache({ ttlMs: 3_600_000, resolve, maxEntries: 2 });
    await cache.get('https://example.com/a');
    await cache.get('https://example.com/b');
    await cache.get('https://example.com/c'); // evicts a
    expect(cache.size()).toBe(2);
    expect(resolve).toHaveBeenCalledTimes(3);

    await cache.get('https://example.com/c'); // still cached
    await cache.get('https://example.com/b'); // still cached
    expect(resolve).toHaveBeenCalledTimes(3);
    await cache.get('https://example.com/a'); // evicted: resolved again
    expect(resolve).toHaveBeenCalledTimes(4);
  });

  it('drops expired entries on insert, not only when they are read again', async () => {
    let clock = Date.parse('2026-01-01T00:00:00Z');
    const resolve = vi.fn(async () => ({}) as CacheableStream);
    const cache = createResolveCache({ ttlMs: 1_000, resolve, now: () => clock, maxEntries: 10 });
    await cache.get('https://example.com/a');
    expect(cache.size()).toBe(1);
    clock += 5_000;
    await cache.get('https://example.com/b'); // insert sweeps the expired a
    expect(cache.size()).toBe(1);
  });

  it('keys YouTube variants of one video together, and leaves other URLs alone', () => {
    expect(canonicalMediaKey('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=30')).toBe('youtube:dQw4w9WgXcQ');
    expect(canonicalMediaKey('https://youtu.be/dQw4w9WgXcQ?si=abc')).toBe('youtube:dQw4w9WgXcQ');
    expect(canonicalMediaKey('https://youtube.com/shorts/dQw4w9WgXcQ')).toBe('youtube:dQw4w9WgXcQ');
    expect(canonicalMediaKey('https://music.youtube.com/watch?v=dQw4w9WgXcQ&list=PL1')).toBe('youtube:dQw4w9WgXcQ');
    expect(canonicalMediaKey('https://youtube.com/watch?v=short')).toBe('https://youtube.com/watch?v=short');
    // Not YouTube: the query can carry a token, so the whole URL is the key.
    expect(canonicalMediaKey('https://soundcloud.com/a/b?secret_token=s-1')).toBe(
      'https://soundcloud.com/a/b?secret_token=s-1',
    );
  });

  it('serves every YouTube variant of one video from a single resolve', async () => {
    const resolve = vi.fn(async () => ({}) as CacheableStream);
    const cache = createResolveCache({ ttlMs: 3_600_000, resolve, key: canonicalMediaKey });
    await cache.get('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    await cache.get('https://youtu.be/dQw4w9WgXcQ');
    await cache.get('https://youtube.com/shorts/dQw4w9WgXcQ?feature=share');
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(cache.size()).toBe(1);
  });
});

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
