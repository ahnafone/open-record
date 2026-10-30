import type { PlayableSource, Track } from '@open-record/models';
import type {
  AudioEngine,
  AudioEngineListener,
  EngineErrorCode,
  EngineMedia,
  EngineNeighbours,
  SkipDirection,
} from './audio-engine';
import { LOAD_RETRY_DELAYS_MS, PlayerEngine } from './player-engine';
import type { PlayerEngineOptions } from './player-engine';

class FakeEngine implements AudioEngine {
  readonly ownsSystemControls = false;
  readonly wantsNeighbours: boolean;
  listener: AudioEngineListener | null = null;
  loaded: string[] = [];
  /** Neighbour windows passed to each `load`, for native-window tests. */
  neighbours: (EngineNeighbours | undefined)[] = [];
  seeks: number[] = [];
  failOn = new Set<string>();
  /** Engine error code reported by `play` for ids in `failOn`. */
  failCode: EngineErrorCode = 'decode';
  /** Ids whose `load` rejects (a load failure rather than a media error). */
  failLoadOn = new Set<string>();

  constructor(wantsNeighbours = false) {
    this.wantsNeighbours = wantsNeighbours;
  }

  setListener(l: AudioEngineListener | null): void {
    this.listener = l;
  }
  async load(media: EngineMedia, neighbours?: EngineNeighbours): Promise<void> {
    this.loaded.push(media.id);
    this.neighbours.push(neighbours);
    if (this.failLoadOn.has(media.id)) throw new Error('load failed');
  }
  async play(): Promise<void> {
    const id = this.loaded.at(-1) ?? '';
    if (this.failOn.has(id)) {
      this.listener?.onError({ code: this.failCode, message: 'bad file' });
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

/** A track with a download source URL, for media-identity tests. */
const sourced = (id: string, url: string): Track => ({
  ...track(id),
  source: { site: 'test', url },
});

/** Three long tracks, for skip/completion tests. */
const timedTracks = (): Track[] => ['a', 'b', 'c'].map((id) => timed(id, 200));

/** Feed 1 Hz time ticks from `from` to `to` inclusive. */
function listen(fake: FakeEngine, from: number, to: number): void {
  for (let sec = from; sec <= to; sec++) fake.listener?.onTime(sec);
}

const resolve = async (t: Track): Promise<PlayableSource> => ({
  url: `/${t.id}.mp3`,
  kind: 'bundled',
});

/** Let async work (no pending timers) settle. */
const flush = () => new Promise<void>((r) => setTimeout(r));

/** Run async retry timers and everything they start. */
const wait = (ms: number) => vi.advanceTimersByTimeAsync(ms);

/** Deterministic random source. */
function seeded(seed = 42): () => number {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 2 ** 32;
    return s / 2 ** 32;
  };
}

/** An error shaped like the remote provider's retryable network failure. */
function networkError(message = 'offline'): Error {
  const err = new Error(message);
  err.name = 'NetworkError';
  return err;
}

/** Report a native skip; the second arg is optional in the engine contract. */
function nativeSkip(
  fake: FakeEngine,
  direction: SkipDirection,
  trackId?: string,
): void {
  const onSkipped = fake.listener?.onSkipped as
    | ((d: SkipDirection, id?: string) => void)
    | undefined;
  onSkipped?.(direction, trackId);
}

function setup(
  opts: {
    wantsNeighbours?: boolean;
    retryDelaysMs?: readonly number[];
    resolve?: (track: Track) => Promise<PlayableSource>;
    transientError?: PlayerEngineOptions['transientError'];
  } = {},
) {
  const fake = new FakeEngine(opts.wantsNeighbours ?? false);
  const player = new PlayerEngine(fake, opts.resolve ?? resolve, {
    random: seeded(),
    retryDelaysMs: opts.retryDelaysMs,
    transientError: opts.transientError,
  });
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

  describe('failed loads never move the queue', () => {
    it('retries a resolve failure on the same track, then errors', async () => {
      vi.useFakeTimers();
      try {
        let resolves = 0;
        const { player, ids, fake } = setup({
          resolve: async () => {
            resolves++;
            throw networkError();
          },
        });

        await player.setQueue(tracks.slice(0, 3), { startIndex: 0 });
        expect(resolves).toBe(1);
        expect(ids()).toBe('a');
        expect(player.status()).toBe('loading');
        expect(player.retrying()).toBe(true);
        expect(player.error()).toBeNull();
        expect(fake.loaded).toEqual([]);

        await wait(LOAD_RETRY_DELAYS_MS[0]);
        expect(resolves).toBe(2);
        await wait(LOAD_RETRY_DELAYS_MS[1]);
        expect(resolves).toBe(3);

        // Terminal: still the same track and cursor, no next() happened.
        expect(ids()).toBe('a');
        expect(player.currentIndex()).toBe(0);
        expect(player.upcoming().map((t) => t.id)).toEqual(['b', 'c']);
        expect(fake.loaded).toEqual([]);
        expect(player.status()).toBe('error');
        expect(player.retrying()).toBe(false);
        expect(player.error()).toMatchObject({
          trackId: 'a',
          code: 'resolve',
          message: 'offline',
        });

        // No further attempts after the budget is spent.
        await wait(10_000);
        expect(resolves).toBe(3);
        expect(ids()).toBe('a');
      } finally {
        vi.useRealTimers();
      }
    });

    it('retries engine load/play failures and plays a successful retry', async () => {
      vi.useFakeTimers();
      try {
        const { player, ids, fake } = setup();
        fake.failOn.add('a');
        fake.failCode = 'network';

        await player.setQueue(tracks.slice(0, 2));
        expect(fake.loaded).toEqual(['a']);
        expect(player.status()).toBe('loading');
        expect(player.retrying()).toBe(true);

        // Second attempt succeeds after the first backoff.
        fake.failOn.delete('a');
        await wait(LOAD_RETRY_DELAYS_MS[0]);
        expect(fake.loaded).toEqual(['a', 'a']);
        expect(ids()).toBe('a');
        expect(player.status()).toBe('playing');
        expect(player.retrying()).toBe(false);
        expect(player.error()).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });

    it('gives up on an engine error after the retry budget, on the same track', async () => {
      vi.useFakeTimers();
      try {
        const { player, ids, fake } = setup();
        fake.failOn.add('a');
        fake.failCode = 'network';

        await player.setQueue(tracks.slice(0, 2));
        await wait(LOAD_RETRY_DELAYS_MS[0]);
        await wait(LOAD_RETRY_DELAYS_MS[1]);

        expect(fake.loaded).toEqual(['a', 'a', 'a']);
        expect(ids()).toBe('a');
        expect(player.status()).toBe('error');
        expect(player.retrying()).toBe(false);
        expect(player.error()).toMatchObject({ trackId: 'a', code: 'network' });
      } finally {
        vi.useRealTimers();
      }
    });

    it('retries a thrown engine load failure as an unknown engine error', async () => {
      vi.useFakeTimers();
      try {
        const { player, ids, fake } = setup();
        fake.failLoadOn.add('a');

        await player.setQueue(tracks.slice(0, 2));
        expect(fake.loaded).toEqual(['a']);
        expect(player.status()).toBe('loading');

        fake.failLoadOn.delete('a');
        await wait(LOAD_RETRY_DELAYS_MS[0]);
        expect(fake.loaded).toEqual(['a', 'a']);
        expect(ids()).toBe('a');
        expect(player.status()).toBe('playing');
      } finally {
        vi.useRealTimers();
      }
    });

    it('does not retry non-retryable engine errors (decode)', async () => {
      const { player, ids, fake } = setup();
      fake.failOn.add('a'); // decode

      await player.setQueue(tracks.slice(0, 2));
      expect(fake.loaded).toEqual(['a']);
      expect(ids()).toBe('a');
      expect(player.status()).toBe('error');
      expect(player.retrying()).toBe(false);
      expect(player.error()).toMatchObject({ trackId: 'a', code: 'decode' });
      // Raw engine detail is not leaked into the user-facing copy.
      expect(player.error()?.message).not.toContain('bad file');
    });

    it('does not retry when autoplay is false', async () => {
      vi.useFakeTimers();
      try {
        let resolves = 0;
        const { player, ids } = setup({
          resolve: async () => {
            resolves++;
            throw networkError();
          },
        });

        await player.setQueue(tracks.slice(0, 3), { autoplay: false });
        expect(resolves).toBe(1);
        expect(player.status()).toBe('error');
        expect(player.retrying()).toBe(false);
        expect(ids()).toBe('a');

        await wait(10_000);
        expect(resolves).toBe(1);
        expect(ids()).toBe('a');
      } finally {
        vi.useRealTimers();
      }
    });

    it('does not retry a mid-track error after playback started', async () => {
      vi.useFakeTimers();
      try {
        const { player, fake } = setup();
        await player.setQueue(tracks.slice(0, 2));
        expect(player.status()).toBe('playing');

        fake.listener?.onError({ code: 'network', message: 'dropped' });
        expect(player.status()).toBe('error');
        expect(player.retrying()).toBe(false);
        expect(player.current()?.id).toBe('a');

        await wait(10_000);
        expect(fake.loaded).toEqual(['a']);
      } finally {
        vi.useRealTimers();
      }
    });

    it('honours a positive Retry-After hint capped at 3s', async () => {
      vi.useFakeTimers();
      try {
        let resolves = 0;
        const busy = Object.assign(networkError('busy'), {
          name: 'busy',
          retryAfterSec: 30,
        });
        const { player } = setup({
          resolve: async () => {
            resolves++;
            throw busy;
          },
        });

        await player.setQueue(tracks.slice(0, 2));
        expect(resolves).toBe(1);

        await wait(2999);
        expect(resolves).toBe(1);
        await wait(1);
        expect(resolves).toBe(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it('keeps the transient mapping for a busy terminal error', async () => {
      vi.useFakeTimers();
      try {
        const busy = Object.assign(new Error('busy'), { name: 'busy' });
        const { player } = setup({
          resolve: async () => {
            throw busy;
          },
          transientError: (err) =>
            err === busy ? 'Server is busy, try again in 5s.' : undefined,
        });

        await player.setQueue(tracks.slice(0, 3));
        await wait(LOAD_RETRY_DELAYS_MS[0]);
        await wait(LOAD_RETRY_DELAYS_MS[1]);

        expect(player.current()?.id).toBe('a');
        expect(player.error()).toMatchObject({
          trackId: 'a',
          message: 'Server is busy, try again in 5s.',
          transient: true,
        });
      } finally {
        vi.useRealTimers();
      }
    });

    it('does not retry abort/auth/config/4xx resolve failures', async () => {
      const cases: [string, unknown][] = [
        ['AuthError', Object.assign(new Error('auth'), { name: 'AuthError' })],
        [
          'RemoteConfigError',
          Object.assign(new Error('config'), { name: 'RemoteConfigError' }),
        ],
        [
          'HttpError',
          Object.assign(new Error('missing'), {
            name: 'HttpError',
            status: 404,
          }),
        ],
        ['AbortedError', Object.assign(new Error('aborted'), { name: 'AbortedError' })],
      ];
      for (const [name, failure] of cases) {
        vi.useFakeTimers();
        try {
          let resolves = 0;
          const { player } = setup({
            resolve: async () => {
              resolves++;
              throw failure;
            },
          });
          await player.setQueue([track(name)]);
          expect(resolves).toBe(1);
          expect(player.status()).toBe('error');
          expect(player.retrying()).toBe(false);
          await wait(10_000);
          expect(resolves).toBe(1);
        } finally {
          vi.useRealTimers();
        }
      }
    });

    it('pausing during backoff cancels the retry and stays on the track', async () => {
      vi.useFakeTimers();
      try {
        let resolves = 0;
        const { player, ids } = setup({
          resolve: async () => {
            resolves++;
            throw networkError();
          },
        });

        await player.setQueue(tracks.slice(0, 3));
        expect(player.retrying()).toBe(true);
        expect(player.status()).toBe('loading');

        await player.pause();
        expect(player.retrying()).toBe(false);
        expect(player.status()).toBe('paused');
        expect(ids()).toBe('a');

        await wait(10_000);
        expect(resolves).toBe(1);
        expect(ids()).toBe('a');
      } finally {
        vi.useRealTimers();
      }
    });

    it('next during backoff cancels the stale retry for the old track', async () => {
      vi.useFakeTimers();
      try {
        const { player, ids, fake } = setup();
        fake.failOn.add('a');
        fake.failCode = 'network';

        await player.setQueue(tracks.slice(0, 3));
        expect(player.retrying()).toBe(true);
        expect(ids()).toBe('a');

        expect(await player.next()).toBe(true);
        expect(ids()).toBe('b');
        expect(player.status()).toBe('playing');

        // Neither the cancelled backoff nor a stale attempt may override b.
        await wait(10_000);
        expect(ids()).toBe('b');
        expect(fake.loaded).toEqual(['a', 'b']);
        expect(player.status()).toBe('playing');
      } finally {
        vi.useRealTimers();
      }
    });

    it('manual play after a terminal error retries the same track', async () => {
      vi.useFakeTimers();
      try {
        let resolves = 0;
        const { player, ids } = setup({
          resolve: async (t) => {
            resolves++;
            if (resolves <= 3) throw networkError();
            return { url: `/${t.id}.mp3`, kind: 'bundled' };
          },
        });

        await player.setQueue(tracks.slice(0, 2));
        await wait(LOAD_RETRY_DELAYS_MS[0]);
        await wait(LOAD_RETRY_DELAYS_MS[1]);
        expect(player.status()).toBe('error');
        expect(ids()).toBe('a');

        await player.play();
        expect(resolves).toBe(4);
        expect(ids()).toBe('a');
        expect(player.status()).toBe('playing');
        expect(player.error()).toBeNull();
        expect(player.retrying()).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('onSkipped track id', () => {
    it('ignores a skip whose trackId is not the expected neighbour', async () => {
      const { player, fake } = setup();
      await player.setQueue(timedTracks(), { startIndex: 0 });
      await flush();

      nativeSkip(fake, 'next', 'c');
      await flush();
      expect(player.current()?.id).toBe('a');
      expect(fake.loaded).toEqual(['a']);

      nativeSkip(fake, 'next', 'b');
      await flush();
      expect(player.current()?.id).toBe('b');
    });

    it('still accepts a skip without a trackId', async () => {
      const { player, fake } = setup();
      await player.setQueue(timedTracks(), { startIndex: 1 });

      nativeSkip(fake, 'next');
      await flush();
      expect(player.current()?.id).toBe('c');
    });

    it('verifies the expected neighbour for a previous skip', async () => {
      const { player, fake } = setup();
      await player.setQueue(timedTracks(), { startIndex: 1 });

      nativeSkip(fake, 'previous', 'c');
      await flush();
      expect(player.current()?.id).toBe('b');

      nativeSkip(fake, 'previous', 'a');
      await flush();
      expect(player.current()?.id).toBe('a');
    });
  });

  describe('applyOrder', () => {
    it('replaces the order without reloading the same media', async () => {
      const { player, fake } = setup();
      await player.setQueue(tracks.slice(0, 3), { startIndex: 1 }); // b
      fake.listener?.onTime(30);
      const loads = fake.loaded.length;

      const result = await player.applyOrder(tracks.slice(1, 4), 0, {
        positionSec: 30,
      });

      expect(result).toEqual({ reloaded: false, moved: true });
      expect(player.current()?.id).toBe('b');
      expect(fake.loaded.length).toBe(loads);
      expect(fake.seeks.at(-1)).toBe(30);
      expect(player.position()).toBe(30);
    });

    it('reports no move when the same entry stays current', async () => {
      const { player, fake } = setup();
      await player.setQueue(tracks.slice(0, 3), { startIndex: 1 }); // b
      const loads = fake.loaded.length;

      const result = await player.applyOrder(tracks.slice(0, 3), 1);

      expect(result).toEqual({ reloaded: false, moved: false });
      expect(fake.loaded.length).toBe(loads);
    });

    it('reloads when the media behind the same cue changes', async () => {
      const { player, fake } = setup();
      const first = sourced('a', '/a-v1.mp3');
      const second = sourced('a', '/a-v2.mp3');
      await player.setQueue([first], { autoplay: false });
      const loads = fake.loaded.length;

      const result = await player.applyOrder([second], 0);

      expect(result.reloaded).toBe(true);
      expect(fake.loaded.length).toBe(loads + 1);
      expect(player.current()).toBe(second);
      expect(player.status()).toBe('playing');
    });

    it('skips between duplicate entries without reloading, seeking to the position', async () => {
      const { player, fake } = setup();
      const one = sourced('a', '/a.mp3');
      const two = sourced('a', '/a.mp3');
      await player.setQueue([one, two], { startIndex: 0 });
      fake.listener?.onTime(100);
      const loads = fake.loaded.length;

      const result = await player.applyOrder([one, two], 1, {
        positionSec: 5,
      });

      expect(result).toEqual({ reloaded: false, moved: true });
      expect(player.currentIndex()).toBe(1);
      expect(player.current()?.id).toBe('a');
      expect(fake.loaded.length).toBe(loads);
      expect(fake.seeks.at(-1)).toBe(5);
    });

    it('refreshes the neighbour window when an in-place order change alters it', async () => {
      const { player, fake } = setup({ wantsNeighbours: true });
      await player.setQueue(
        [track('a'), track('b'), track('c')],
        { startIndex: 0 },
      );
      const loads = fake.loaded.length;

      const result = await player.applyOrder(
        [track('a'), track('c'), track('b')],
        0,
      );
      await flush();

      expect(result).toEqual({ reloaded: false, moved: false });
      expect(fake.loaded.length).toBe(loads + 1);
      expect(fake.neighbours.at(-1)?.next?.id).toBe('c');
      expect(fake.neighbours.at(-1)?.previous).toBeUndefined();
    });

    it('skips a neighbour refresh when the window and repeat mode are unchanged', async () => {
      const { player, fake } = setup({ wantsNeighbours: true });
      await player.setQueue(tracks.slice(0, 3), { startIndex: 1 });
      const loads = fake.loaded.length;

      // Same previous/current/next and repeat: nothing to re-send.
      player.setRepeat('off');
      player.setShuffle(false);
      await player.applyOrder(tracks.slice(0, 3), 1);
      await flush();
      expect(fake.loaded.length).toBe(loads);

      // Repeat is part of the window signature, so a real change refreshes.
      player.setRepeat('all');
      await flush();
      expect(fake.loaded.length).toBe(loads + 1);
    });

    it('clears pending play-next entries when a session order is applied', async () => {
      const { player } = setup();
      await player.setQueue(tracks.slice(0, 3), { startIndex: 0 });
      player.playNext([track('x')]);
      expect(player.playNextIndices().length).toBe(1);

      await player.applyOrder(tracks.slice(0, 2), 0);

      expect(player.playNextIndices()).toEqual([]);
      expect(player.queue().map((t) => t.id)).toEqual(['a', 'b']);
      expect(player.upcoming().map((t) => t.id)).toEqual(['b']);
    });

    it('forces shuffle and repeat off for a session order, unless sessionMode is false', async () => {
      const { player } = setup();
      await player.setQueue(tracks, { startIndex: 0 });
      player.setShuffle(true);
      player.setRepeat('one');

      await player.applyOrder(tracks, 0);
      expect(player.shuffle()).toBe(false);
      expect(player.repeat()).toBe('off');

      player.setShuffle(true);
      player.setRepeat('all');
      await player.applyOrder(tracks, 0, { sessionMode: false });
      expect(player.shuffle()).toBe(true);
      expect(player.repeat()).toBe('all');
    });

    it('clears the engine when the session order is empty', async () => {
      const { player, fake } = setup();
      await player.setQueue(tracks.slice(0, 3));
      const loads = fake.loaded.length;

      const result = await player.applyOrder([], 0);

      expect(result).toEqual({ reloaded: false, moved: true });
      expect(player.queue()).toEqual([]);
      expect(player.current()).toBeNull();
      expect(player.status()).toBe('idle');
      expect(player.position()).toBe(0);
      expect(fake.loaded.length).toBe(loads);
    });
  });

  describe('seekIfDrifted', () => {
    it('does not scrub within the tolerance, but does beyond it', async () => {
      const { player, fake } = setup();
      await player.setQueue([track('a')]);
      fake.listener?.onTime(10);
      const seeks = fake.seeks.length;

      await player.seekIfDrifted(11.5, 2);
      expect(fake.seeks.length).toBe(seeks);

      await player.seekIfDrifted(30);
      expect(fake.seeks.at(-1)).toBe(30);
    });

    it('is a no-op without a current track', async () => {
      const { player, fake } = setup();
      await player.seekIfDrifted(50);
      expect(fake.seeks).toEqual([]);
    });
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
      nativeSkip(fake, 'next', 'b');
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

      nativeSkip(fake, 'next', 'b');
      await flush();

      expect(player.current()?.id).toBe('b');
      expect(player.lastPlay()).toBeNull();
    });

    it('does not count a native skip from the middle of a track', async () => {
      const { player, fake } = setup();
      await player.setQueue([timed('a', 200), timed('b', 200)]);
      listen(fake, 1, 100);

      nativeSkip(fake, 'next', 'b');
      await flush();

      expect(player.current()?.id).toBe('b');
      expect(player.lastPlay()).toBeNull();
    });

    it('never counts a failed load', async () => {
      const { player, fake } = setup();
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

  describe('dropPlayed', () => {
    it('drops older played entries and shifts the cursor without reloading', async () => {
      const { player, fake } = setup();
      await player.setQueue(tracks, { startIndex: 4 }); // e
      player.playNext([track('x')]);
      fake.listener?.onTime(30);
      const loads = fake.loaded.length;
      const seeks = fake.seeks.length;
      const position = player.position();
      const status = player.status();

      player.dropPlayed(2);

      // a, b were more than 2 entries behind the cursor.
      expect(player.queue().map((t) => t.id)).toEqual(['c', 'd', 'e', 'x']);
      expect(player.currentIndex()).toBe(2);
      expect(player.current()?.id).toBe('e');
      expect(player.playNextIndices()).toEqual([3]);
      expect(player.upcoming().map((t) => t.id)).toEqual(['x']);
      // Playback continues untouched.
      expect(player.status()).toBe(status);
      expect(player.position()).toBe(position);
      expect(fake.loaded.length).toBe(loads);
      expect(fake.seeks.length).toBe(seeks);

      // Keep counts at or beyond the cursor, and negative values, are no-ops.
      player.dropPlayed(-1);
      player.dropPlayed(2);
      player.dropPlayed(10);
      expect(player.queue().map((t) => t.id)).toEqual(['c', 'd', 'e', 'x']);
      expect(player.currentIndex()).toBe(2);
      expect(player.playNextIndices()).toEqual([3]);
    });
  });

  describe('loadSeq', () => {
    it('bumps on every load and when the queue is cleared or replaced', async () => {
      const { player } = setup();
      const start = player.loadSeq();

      await player.setQueue(tracks.slice(0, 3), { startIndex: 0 });
      const first = player.loadSeq();
      expect(first).toBeGreaterThan(start);

      await player.next();
      const second = player.loadSeq();
      expect(second).toBeGreaterThan(first);

      await player.clear();
      const cleared = player.loadSeq();
      expect(cleared).toBeGreaterThan(second);

      await player.setQueue([]);
      const emptied = player.loadSeq();
      expect(emptied).toBeGreaterThan(cleared);

      await player.setQueue(tracks.slice(0, 2));
      expect(player.loadSeq()).toBeGreaterThan(emptied);
    });
  });
});
