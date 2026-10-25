import { createLinkCache } from '../index';

describe('link cache', () => {
  it('reuses a link until shortly before it expires, then reloads', async () => {
    let now = 0;
    let loads = 0;
    const cached = createLinkCache(
      async () => ({ url: `https://cdn.example/${++loads}`, expiresAt: 300_000 }),
      { now: () => now, marginMs: 60_000 },
    );

    const first = await cached('t1');
    now = 239_999;
    expect(await cached('t1')).toBe(first);
    expect(loads).toBe(1);

    now = 240_000;
    const second = await cached('t1');
    expect(second).not.toBe(first);
    expect(loads).toBe(2);
  });

  it('shares one in-flight load between concurrent callers', async () => {
    let loads = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const cached = createLinkCache(async () => {
      loads++;
      await gate;
      return { url: 'https://cdn.example/a', expiresAt: 10_000_000 };
    });

    const a = cached('t1');
    const b = cached('t1');
    release();
    const [ra, rb] = await Promise.all([a, b]);

    expect(loads).toBe(1);
    expect(ra).toBe(rb);
  });

  it('does not cache links without an expiry or a failed load', async () => {
    let loads = 0;
    const cached = createLinkCache<{ url: string; expiresAt?: number }>(async () => {
      if (++loads === 1) throw new Error('boom');
      return { url: 'https://cdn.example/x' };
    });

    await expect(cached('t1')).rejects.toThrow('boom');
    // The failure is not cached, and the link without expiry is not cached either.
    await cached('t1');
    await cached('t1');
    expect(loads).toBe(3);
  });
});
