import type { Track } from '@open-record/models';
import {
  AUTO_QUEUE_AHEAD,
  PLAYLIST_QUEUE_AHEAD,
  QUEUE_HISTORY_KEEP,
  QueueWindow,
  RECENTLY_QUEUED_FUTURE_SKEW_MS,
  buildQueueWindow,
  isRecentlyQueued,
  parseRecentlyQueued,
  pruneRecentlyQueued,
  queueAheadFor,
  restoreQueueWindow,
} from './queue-window';

const track = (id: string): Track => ({
  id,
  providerId: 'test',
  title: id,
  artist: 'Artist',
});

const context = Array.from({ length: 300 }, (_, i) => track(`t${i}`));
const ids = (tracks: readonly Track[]) => tracks.map((t) => t.id);
const pool = Array.from({ length: 10 }, (_, i) => track(`p${i}`));

/** Deterministic random source. */
function seeded(seed = 42): () => number {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 2 ** 32;
    return s / 2 ** 32;
  };
}

describe('queue window', () => {
  it('uses 50 tracks ahead for auto and 100 for a playlist', () => {
    expect(AUTO_QUEUE_AHEAD).toBe(50);
    expect(PLAYLIST_QUEUE_AHEAD).toBe(100);
    expect(QUEUE_HISTORY_KEEP).toBe(20);
    expect(queueAheadFor('auto')).toBe(50);
    expect(queueAheadFor('playlist')).toBe(100);

    const auto = buildQueueWindow(context, 0, 'auto', { shuffle: false });
    expect(auto.tracks.length).toBe(51);
    expect(auto.window.limit).toBe(50);
    expect(auto.window.remaining).toBe(249);

    const playlist = buildQueueWindow(context, 0, 'playlist', {
      shuffle: false,
    });
    expect(playlist.tracks.length).toBe(101);
    expect(playlist.window.limit).toBe(100);
    expect(playlist.window.remaining).toBe(199);
  });

  it('keeps up to 20 played entries before the cursor', () => {
    const built = buildQueueWindow(context, 30, 'auto', { shuffle: false });

    expect(built.cursor).toBe(20);
    expect(ids(built.tracks)).toEqual(ids(context.slice(10, 81)));
    expect(built.tracks[built.cursor].id).toBe('t30');

    // Fewer than 20 earlier entries: keep exactly what exists.
    const early = buildQueueWindow(context, 5, 'auto', { shuffle: false });
    expect(early.cursor).toBe(5);
    expect(ids(early.tracks)).toEqual(ids(context.slice(0, 56)));
    expect(early.tracks[early.cursor].id).toBe('t5');

    const fromStart = buildQueueWindow(context, 0, 'auto', {
      shuffle: false,
    });
    expect(fromStart.cursor).toBe(0);
    expect(fromStart.tracks[0].id).toBe('t0');
  });

  it('holds the undrawn pool in play order and tops the queue up until exhausted', () => {
    const built = buildQueueWindow(context, 0, 'auto', { shuffle: false });
    const { window } = built;

    expect(window.shuffle).toBe(false);
    expect(window.ids()).toEqual(ids(context.slice(51)));

    expect(window.take(0)).toEqual([]);
    expect(window.take(-5)).toEqual([]);

    expect(ids(window.take(50))).toEqual(ids(context.slice(51, 101)));
    expect(window.remaining).toBe(199);

    expect(ids(window.take(1000))).toEqual(ids(context.slice(101)));
    expect(window.remaining).toBe(0);
    expect(window.ids()).toEqual([]);
    expect(window.take(1)).toEqual([]);
  });

  it('builds nothing for an empty context or an out-of-range index', () => {
    for (const built of [
      buildQueueWindow([], 0, 'auto', { shuffle: false }),
      buildQueueWindow(context, -1, 'auto', { shuffle: false }),
      buildQueueWindow(context, context.length, 'auto', { shuffle: false }),
    ]) {
      expect(built.tracks).toEqual([]);
      expect(built.cursor).toBe(-1);
      expect(built.window.remaining).toBe(0);
    }

    const shuffled = buildQueueWindow([], 0, 'playlist', { shuffle: true });
    expect(shuffled.window.shuffle).toBe(true);
    expect(shuffled.window.limit).toBe(100);
  });

  it('starts a shuffled build at the tapped track and leaves the undrawn pool in source order', () => {
    const built = buildQueueWindow(context, 5, 'auto', {
      shuffle: true,
      random: seeded(42),
    });
    const drawn = ids(built.tracks);

    expect(built.cursor).toBe(0);
    expect(drawn.length).toBe(51);
    expect(drawn[0]).toBe('t5');
    expect(new Set(drawn).size).toBe(51);
    expect(drawn).not.toEqual(ids(context.slice(5, 56)));
    expect(built.window.shuffle).toBe(true);

    const undrawn = new Set(drawn);
    expect(built.window.ids()).toEqual(
      ids(context.filter((t) => !undrawn.has(t.id))),
    );

    // The same seed produces the same queue and pool.
    const again = buildQueueWindow(context, 5, 'auto', {
      shuffle: true,
      random: seeded(42),
    });
    expect(ids(again.tracks)).toEqual(drawn);
    expect(again.window.ids()).toEqual(built.window.ids());
  });

  it('restores the source order when shuffle is turned off, without losing entries', () => {
    const window = new QueueWindow(pool, {
      limit: 50,
      shuffle: true,
      random: seeded(9),
    });

    const taken = window.take(3);
    expect(taken.length).toBe(3);
    expect(window.remaining).toBe(7);

    const takenIds = new Set(ids(taken));
    const natural = ids(pool.filter((t) => !takenIds.has(t.id)));

    window.setShuffle(false);
    expect(window.ids()).toEqual(natural);

    window.setShuffle(true);
    expect(window.ids()).toHaveLength(7);
    expect([...window.ids()].sort()).toEqual([...natural].sort());
    expect(window.ids()).not.toEqual(natural);

    window.setShuffle(false);
    expect(window.ids()).toEqual(natural);
  });

  it('releases a refused draw back in order, skipping tracks removed while held', () => {
    const window = new QueueWindow(pool, { limit: 50, shuffle: false });

    const draw = window.reserve(3);
    expect(ids(draw.tracks)).toEqual(['p0', 'p1', 'p2']);
    expect(window.remaining).toBe(7);

    // Removed while held: not put back. Replaced while held: the replacement is.
    window.remove(new Set(['p1']));
    window.replace('p2', track('q2'));
    draw.release();
    draw.release(); // a second release is a no-op
    expect(window.ids()).toEqual(['p0', 'q2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8', 'p9']);

    // A committed draw is consumed for good: release does nothing.
    const kept = window.reserve(1);
    kept.commit();
    kept.release();
    expect(window.remaining).toBe(8);
  });

  it('restores a window from ids and rejects one with a missing track', () => {
    const byId = new Map(context.map((t) => [t.id, t]));
    const resolve = (id: string) => byId.get(id);

    const window = restoreQueueWindow(['t9', 't3', 't5'], resolve, {
      limit: 50,
      shuffle: false,
    });
    expect(window).not.toBeNull();
    expect(window?.remaining).toBe(3);
    expect(window?.limit).toBe(50);
    expect(window?.ids()).toEqual(['t9', 't3', 't5']);
    expect(ids(window?.take(2) ?? [])).toEqual(['t9', 't3']);
    expect(ids(window?.take(2) ?? [])).toEqual(['t5']);

    expect(
      restoreQueueWindow(['t9', 'gone'], resolve, {
        limit: 50,
        shuffle: false,
      }),
    ).toBeNull();
    expect(
      restoreQueueWindow([], resolve, { limit: 50, shuffle: false })?.remaining,
    ).toBe(0);
  });

  it('treats the persisted order as the origin of a restored window', () => {
    const byId = new Map(pool.map((t) => [t.id, t]));
    const window = restoreQueueWindow(['p4', 'p1', 'p7'], (id) => byId.get(id), {
      limit: 50,
      shuffle: true,
      random: seeded(3),
    });

    const taken = new Set(ids(window?.take(1) ?? []));
    window?.setShuffle(false);
    expect(window?.ids()).toEqual(
      ['p4', 'p1', 'p7'].filter((id) => !taken.has(id)),
    );
  });

  describe('eligibility (12h autoplay dedupe)', () => {
    const notBanned = (banned: string[]) => (t: Track) => !banned.includes(t.id);

    it('take skips ineligible tracks and leaves them in the pool', () => {
      const window = new QueueWindow(pool.slice(0, 5), {
        limit: 50,
        shuffle: true,
        random: seeded(1),
      });
      const drawn = window.take(3, notBanned(['p0', 'p2']));
      expect(ids(drawn).sort()).toEqual(['p1', 'p3', 'p4']);
      expect(window.ids().sort()).toEqual(['p0', 'p2']);
    });

    it('a strict stop: nothing eligible means a short draw, no fallback', () => {
      const window = new QueueWindow(pool.slice(0, 3), {
        limit: 50,
        shuffle: true,
        random: seeded(1),
      });
      expect(window.take(2, () => false)).toEqual([]);
      expect(window.remaining).toBe(3);
    });

    it('in-order draws ignore eligibility and take the list order', () => {
      const window = new QueueWindow(pool.slice(0, 4), {
        limit: 50,
        shuffle: false,
      });
      expect(ids(window.take(2, () => false))).toEqual(['p0', 'p1']);
      expect(ids(window.take(5, notBanned(['p3'])))).toEqual(['p2', 'p3']);
      expect(window.remaining).toBe(0);
    });

    it('shuffled draws only pick eligible tracks', () => {
      const window = new QueueWindow(pool, {
        limit: 50,
        shuffle: true,
        random: seeded(9),
      });
      const banned = ['p1', 'p4', 'p8'];
      const drawn = window.take(10, notBanned(banned));
      expect(drawn.length).toBe(7);
      expect(ids(drawn).some((id) => banned.includes(id))).toBe(false);
      expect(window.ids().sort()).toEqual(banned.sort());
    });

    it('reserve with eligibility releases ineligible tracks untouched', () => {
      const window = new QueueWindow(pool.slice(0, 4), {
        limit: 50,
        shuffle: true,
        random: seeded(2),
      });
      const draw = window.reserve(4, notBanned(['p1']));
      expect(ids(draw.tracks).sort()).toEqual(['p0', 'p2', 'p3']);
      draw.release();
      expect(window.ids().sort()).toEqual(['p0', 'p1', 'p2', 'p3']);
    });

    it('buildQueueWindow fills the shuffled ahead only with eligible tracks', () => {
      const banned = new Set(['t1', 't2']);
      const built = buildQueueWindow(context.slice(0, 10), 0, 'auto', {
        shuffle: true,
        random: seeded(4),
        eligible: (t) => !banned.has(t.id),
      });
      expect(built.tracks[0].id).toBe('t0');
      expect(ids(built.tracks.slice(1)).sort()).toEqual(['t3', 't4', 't5', 't6', 't7', 't8', 't9']);
      // The skipped tracks stay in the pool for later fills.
      expect(built.window.ids()).toEqual(['t1', 't2']);
    });

    it('buildQueueWindow ignores eligibility when shuffle is off', () => {
      const built = buildQueueWindow(context.slice(0, 10), 0, 'auto', {
        shuffle: false,
        eligible: () => false,
      });
      expect(ids(built.tracks)).toEqual(ids(context.slice(0, 10)));
      expect(built.window.remaining).toBe(0);
    });

    it('buildQueueWindow never filters the tapped track or history', () => {
      const built = buildQueueWindow(context.slice(0, 10), 3, 'auto', {
        shuffle: true,
        random: seeded(6),
        eligible: () => false,
      });
      expect(ids(built.tracks)).toEqual(['t3']);
      expect(built.cursor).toBe(0);
    });

    it('shuffled builds keep the tapped track even when ineligible', () => {
      const built = buildQueueWindow(context.slice(0, 10), 4, 'auto', {
        shuffle: true,
        random: seeded(5),
        eligible: (t) => t.id !== 't4' && t.id !== 't0',
      });
      expect(built.tracks[0].id).toBe('t4');
      expect(ids(built.tracks)).not.toContain('t0');
    });
  });

  describe('recently queued record', () => {
    const record = { a: 1_000, b: 0, c: 2_000 };
    const twelveH = 12 * 60 * 60 * 1000;

    it('prunes entries older than 12 hours', () => {
      // `b` is past 12h; `a` and `c` are still inside.
      const now = twelveH + 999;
      expect(pruneRecentlyQueued(record, now)).toEqual({ a: 1_000, c: 2_000 });
      // One more ms and `a` (exactly 12h old) falls out.
      expect(pruneRecentlyQueued(record, now + 1_000)).toEqual({ c: 2_000 });
    });

    it('treats a song as recent only inside the 12h window', () => {
      const now = 10_000;
      expect(isRecentlyQueued(record, 'a', now)).toBe(true);
      expect(isRecentlyQueued(record, 'a', 1_000 + twelveH)).toBe(false);
      expect(isRecentlyQueued(record, 'missing', now)).toBe(false);
    });

    it('parses only numeric timestamps from stored data', () => {
      expect(parseRecentlyQueued({ a: 5, b: 'x', c: Number.NaN, d: null }, 10)).toEqual({
        a: 5,
      });
      expect(parseRecentlyQueued(null, 10)).toEqual({});
      expect(parseRecentlyQueued([1, 2], 10)).toEqual({});
    });

    it('drops future-dated stamps so they cannot pin a song', () => {
      const now = 10_000;
      const skew = RECENTLY_QUEUED_FUTURE_SKEW_MS;
      const future = { far: now + twelveH, near: now + skew, ok: now - 1 };

      // Within the skew allowance a stamp is kept; beyond it, it is dropped.
      expect(pruneRecentlyQueued({ ...future, late: now + skew + 1 }, now)).toEqual({
        near: now + skew,
        ok: now - 1,
      });
      expect(parseRecentlyQueued(future, now)).toEqual({
        near: now + skew,
        ok: now - 1,
      });
      expect(isRecentlyQueued({ far: now + twelveH }, 'far', now)).toBe(false);
    });
  });
});
