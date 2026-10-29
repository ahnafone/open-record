import type { PlayableSource, Track } from '@open-record/models';
import type {
  AudioEngine,
  AudioEngineListener,
  EngineMedia,
} from './audio-engine';
import { PlayerEngine } from './player-engine';

class FakeEngine implements AudioEngine {
  readonly ownsSystemControls = false;
  readonly wantsNeighbours = false;
  listener: AudioEngineListener | null = null;
  loaded: string[] = [];
  seeks: number[] = [];
  failOn = new Set<string>();

  setListener(l: AudioEngineListener | null): void {
    this.listener = l;
  }
  async load(media: EngineMedia): Promise<void> {
    this.loaded.push(media.id);
  }
  async play(): Promise<void> {
    const id = this.loaded.at(-1) ?? '';
    if (this.failOn.has(id)) {
      this.listener?.onError({ code: 'decode', message: 'bad file' });
    } else {
      this.listener?.onPlaying();
    }
  }
  async pause(): Promise<void> {
    this.listener?.onPaused();
  }
  async seek(sec: number): Promise<void> {
    this.seeks.push(sec);
    this.listener?.onTime(sec);
  }
  async stop(): Promise<void> {
    /* noop */
  }
  async destroy(): Promise<void> {
    /* noop */
  }
}

const track = (id: string): Track => ({
  id,
  providerId: 'test',
  title: id,
  artist: 'Artist',
});
const tracks = ['a', 'b', 'c', 'd', 'e'].map(track);

/** A track with a known duration, for play-completion tests. */
const timed = (id: string, durationSec: number): Track => ({
  ...track(id),
  durationSec,
});

/** Feed 1 Hz time ticks from `from` to `to` inclusive. */
function listen(fake: FakeEngine, from: number, to: number): void {
  for (let sec = from; sec <= to; sec++) fake.listener?.onTime(sec);
}

const resolve = async (t: Track): Promise<PlayableSource> => ({
  url: `/${t.id}.mp3`,
  kind: 'bundled',
});

/** Let async error-driven skips settle. */
const flush = () => new Promise<void>((r) => setTimeout(r));

/** Deterministic random source. */
function seeded(seed = 42): () => number {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 2 ** 32;
    return s / 2 ** 32;
  };
}

function setup(opts: { skipOnError?: boolean } = {}) {
  const fake = new FakeEngine();
  const player = new PlayerEngine(fake, resolve, { random: seeded(), ...opts });
  const ids = () => player.current()?.id;
  return { fake, player, ids };
}

describe('PlayerEngine', () => {
  it('plays the queue in order and stops at the end with repeat off', async () => {
    const { player, ids, fake } = setup();
    await player.setQueue(tracks.slice(0, 3), { startIndex: 1 });
    expect(ids()).toBe('b');
    expect(player.status()).toBe('playing');

    expect(await player.next()).toBe(true);
    expect(ids()).toBe('c');
    expect(await player.next()).toBe(false);

    fake.listener?.onEnded();
    await Promise.resolve();
    expect(player.status()).toBe('ended');
    expect(ids()).toBe('c');
  });

  it('previous restarts after 3s, otherwise goes back', async () => {
    const { player, ids, fake } = setup();
    await player.setQueue(tracks, { startIndex: 2 });

    fake.listener?.onTime(10);
    await player.previous();
    expect(ids()).toBe('c');
    expect(fake.seeks.at(-1)).toBe(0);

    fake.listener?.onTime(1);
    await player.previous();
    expect(ids()).toBe('b');
  });

  it('repeat all wraps both ways; repeat one restarts on track end', async () => {
    const { player, ids, fake } = setup();
    await player.setQueue(tracks.slice(0, 2), { startIndex: 1 });
    player.setRepeat('all');
    await player.next();
    expect(ids()).toBe('a');
    await player.previous();
    expect(ids()).toBe('b');

    player.setRepeat('one');
    const loads = fake.loaded.length;
    fake.listener?.onTime(30);
    fake.listener?.onEnded();
    await Promise.resolve();
    expect(ids()).toBe('b');
    expect(fake.loaded.length).toBe(loads);
    expect(fake.seeks.at(-1)).toBe(0);
  });

  it('shuffle keeps the current track first and a stable order', async () => {
    const { player, ids } = setup();
    await player.setQueue(tracks, { startIndex: 2 });
    player.setShuffle(true);

    expect(ids()).toBe('c');
    const order = player.upcoming().map((t) => t.id);
    expect([...order].sort()).toEqual(['a', 'b', 'd', 'e']);

    // Walking the queue follows the same order it promised.
    const played: string[] = [];
    while (await player.next()) played.push(ids() ?? '');
    expect(played).toEqual(order);

    // Turning shuffle off resumes the original order from the current track.
    player.setShuffle(false);
    expect(player.currentIndex()).toBe(tracks.findIndex((t) => t.id === ids()));
  });

  it('plays "play next" items first, in the order added, then resumes', async () => {
    const { player, ids } = setup();
    await player.setQueue(tracks.slice(0, 4), { startIndex: 1 }); // b
    player.playNext([track('x')]);
    player.playNext([track('y')]);
    const upcoming = () =>
      player.upcomingEntries().map((e) => e.track.id + (e.playNext ? '*' : ''));
    expect(upcoming()).toEqual(['x*', 'y*', 'c', 'd']);

    // Remove a normal item and a play-next item by queue index.
    const at = (id: string) =>
      player.upcomingEntries().find((e) => e.track.id === id)?.queueIndex ?? -1;
    expect(player.removeUpcoming(at('d'))).toBe(true);
    player.playNext([track('z')]);
    expect(player.removeUpcoming(at('y'))).toBe(true);
    expect(upcoming()).toEqual(['x*', 'z*', 'c']);

    const played: string[] = [];
    while (await player.next()) played.push(ids() ?? '');
    expect(played).toEqual(['x', 'z', 'c']);
    expect(player.upcomingEntries().some((e) => e.playNext)).toBe(false);
  });

  it('skips failing tracks and exposes the error', async () => {
    const { player, ids, fake } = setup();
    fake.failOn.add('b');
    await player.setQueue(tracks.slice(0, 3), { startIndex: 1 });
    await flush();
    expect(ids()).toBe('c');
    expect(player.status()).toBe('playing');
    expect(player.error()).toBeNull();

    const strict = setup({ skipOnError: false });
    strict.fake.failOn.add('a');
    await strict.player.setQueue(tracks.slice(0, 2));
    await flush();
    expect(strict.ids()).toBe('a');
    expect(strict.player.status()).toBe('error');
    expect(strict.player.error()).toMatchObject({
      trackId: 'a',
      code: 'decode',
    });
  });

  it('stops skipping when every track fails', async () => {
    const { player, fake } = setup();
    ['a', 'b', 'c'].forEach((id) => fake.failOn.add(id));
    player.setRepeat('all');
    vi.useFakeTimers();
    try {
      await player.setQueue(tracks.slice(0, 3));
      // Chained skips are spaced out: the second waits ~1s.
      await vi.advanceTimersByTimeAsync(10);
      expect(fake.loaded.length).toBe(2);
      await vi.advanceTimersByTimeAsync(1000);
    } finally {
      vi.useRealTimers();
    }
    expect(player.status()).toBe('error');
    expect(fake.loaded.length).toBe(3);
  });

  it('does not skip on a busy server or while loading paused (startup restore)', async () => {
    const fake = new FakeEngine();
    let resolves = 0;
    const busy = Object.assign(new Error('busy'), { name: 'busy' });
    const player = new PlayerEngine(
      fake,
      async () => {
        resolves++;
        throw busy;
      },
      {
        transientError: (err) =>
          err === busy ? 'Server is busy, try again in 5s.' : undefined,
      },
    );
    await player.setQueue(tracks.slice(0, 3));
    await flush();
    expect(resolves).toBe(1);
    expect(player.current()?.id).toBe('a');
    expect(player.error()).toMatchObject({
      message: 'Server is busy, try again in 5s.',
      transient: true,
    });

    // Restoring a saved queue paused must not walk (and autoplay) the queue.
    const offline = new PlayerEngine(new FakeEngine(), async () => {
      throw new Error('offline');
    });
    await offline.setQueue(tracks.slice(0, 3), { autoplay: false });
    await flush();
    expect(offline.current()?.id).toBe('a');
    expect(offline.status()).toBe('error');
  });

  describe('play counting', () => {
    it('counts a play once 90% is listened to, and only once', async () => {
      const { player, fake } = setup();
      await player.setQueue([timed('a', 200)]);
      expect(player.lastPlay()).toBeNull();

      listen(fake, 1, 179);
      expect(player.lastPlay()).toBeNull();

      listen(fake, 180, 181);
      const play = player.lastPlay();
      expect(play?.track.id).toBe('a');
      expect(play?.seq).toBe(1);
      expect(typeof play?.at).toBe('number');

      // Later ticks, a pause and a resume do not count it again.
      listen(fake, 182, 190);
      await player.pause();
      await player.play();
      listen(fake, 191, 195);
      expect(player.lastPlay()?.seq).toBe(1);
    });

    it('does not count a track skipped early', async () => {
      const { player, fake } = setup();
      await player.setQueue([timed('a', 200), timed('b', 200)]);
      listen(fake, 1, 20);
      await player.next();
      expect(player.current()?.id).toBe('b');
      expect(player.lastPlay()).toBeNull();
    });

    it('counts a track of unknown duration only on end', async () => {
      const { player, fake } = setup();
      await player.setQueue([track('a')]);
      listen(fake, 1, 60);
      expect(player.lastPlay()).toBeNull();

      fake.listener?.onEnded();
      await flush();
      expect(player.lastPlay()).toMatchObject({ seq: 1 });
      expect(player.lastPlay()?.track.id).toBe('a');
    });

    it('counts each repeat-one loop', async () => {
      const { player, fake } = setup();
      await player.setQueue([timed('a', 100)]);
      player.setRepeat('one');

      listen(fake, 1, 90);
      expect(player.lastPlay()?.seq).toBe(1);

      // The end is already counted, so it does not add another.
      fake.listener?.onEnded();
      await flush();
      expect(player.lastPlay()?.seq).toBe(1);

      listen(fake, 1, 90);
      expect(player.lastPlay()?.seq).toBe(2);

      fake.listener?.onEnded();
      await flush();
      listen(fake, 1, 90);
      expect(player.lastPlay()?.seq).toBe(3);
    });

    it('counts again when a finished track is replayed', async () => {
      const { player, fake } = setup();
      await player.setQueue([timed('a', 100)]);
      listen(fake, 1, 90);
      expect(player.lastPlay()?.seq).toBe(1);

      fake.listener?.onEnded();
      await flush();
      expect(player.status()).toBe('ended');
      expect(player.lastPlay()?.seq).toBe(1);

      await player.play();
      listen(fake, 1, 90);
      expect(player.lastPlay()?.seq).toBe(2);
    });

    it('counts a native auto-advance that starts from the end of the track', async () => {
      const { player, fake } = setup();
      await player.setQueue([timed('a', 200), timed('b', 200)]);
      listen(fake, 1, 120);
      // The screen was off: the 78 s gap earns no listen time, so 90% is never
      // reached even though the position is at the end.
      fake.listener?.onTime(198);
      expect(player.lastPlay()).toBeNull();

      // A neighbour is queued, so the native layer advances on its own and
      // reports a skip instead of an end (also when the WebView was suspended).
      fake.listener?.onSkipped('next');
      await flush();

      expect(player.lastPlay()?.track.id).toBe('a');
      expect(player.lastPlay()?.seq).toBe(1);
      expect(player.current()?.id).toBe('b');
    });

    it('counts again when the listener drags back to the start', async () => {
      const { player, fake } = setup();
      await player.setQueue([timed('a', 100)]);
      listen(fake, 1, 90);
      expect(player.lastPlay()?.seq).toBe(1);

      await player.seek(0);
      listen(fake, 1, 90);
      expect(player.lastPlay()?.seq).toBe(2);
    });

    it('does not count a short track skipped before 90%', async () => {
      const { player, fake } = setup();
      await player.setQueue([timed('a', 5), timed('b', 5)]);
      listen(fake, 1, 2);

      fake.listener?.onSkipped('next');
      await flush();

      expect(player.current()?.id).toBe('b');
      expect(player.lastPlay()).toBeNull();
    });

    it('does not count a native skip from the middle of a track', async () => {
      const { player, fake } = setup();
      await player.setQueue([timed('a', 200), timed('b', 200)]);
      listen(fake, 1, 100);

      fake.listener?.onSkipped('next');
      await flush();

      expect(player.current()?.id).toBe('b');
      expect(player.lastPlay()).toBeNull();
    });

    it('never counts a failed load', async () => {
      const { player, fake } = setup({ skipOnError: false });
      fake.failOn.add('a');
      await player.setQueue([timed('a', 100)]);
      await flush();
      expect(player.status()).toBe('error');
      expect(player.lastPlay()).toBeNull();

      const unresolved = new PlayerEngine(new FakeEngine(), async () => {
        throw new Error('offline');
      });
      await unresolved.setQueue([timed('a', 100)]);
      await flush();
      expect(unresolved.status()).toBe('error');
      expect(unresolved.lastPlay()).toBeNull();
    });
  });
});
