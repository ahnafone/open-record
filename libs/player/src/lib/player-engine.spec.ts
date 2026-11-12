import type { PlayableSource, Track } from '@open-record/models';
import type {
  AudioEngine,
  AudioEngineListener,
  EngineError,
  EngineErrorCode,
  EngineMedia,
  EngineNeighbours,
  SkipDirection,
} from './audio-engine';
import {
  LOAD_RETRY_DELAYS_MS,
  MAX_STACK_ENTRIES,
  PlayerEngine,
  UNSUPPORTED_REMOTE_RETRY_DELAYS_MS,
} from './player-engine';
import type { PlayerEngineOptions } from './player-engine';

class FakeEngine implements AudioEngine {
  readonly ownsSystemControls = false;
  readonly wantsNeighbours: boolean;
  listener: AudioEngineListener | null = null;
  loaded: string[] = [];
  /** Neighbour windows passed to each `load`, for native-window tests. */
  neighbours: (EngineNeighbours | undefined)[] = [];
  /** Neighbour windows passed to each `preload` (web engines). */
  preloads: EngineNeighbours[] = [];
  seeks: number[] = [];
  failOn = new Set<string>();
  /** Engine error code reported by `play` for ids in `failOn`. */
  failCode: EngineErrorCode = 'decode';
  /** Ids whose `load` rejects (a load failure rather than a media error). */
  failLoadOn = new Set<string>();
  /** When set, `play` rejects with this engine error (a failed resume). */
  rejectPlayWith: EngineError | null = null;
  /** Number of `pause` calls, for the outgoing-track stop tests. */
  pauses = 0;
  readonly overlapsLoad: boolean;
  /** Crossfade lengths forwarded by `setCrossfade`. */
  crossfades: number[] = [];

  constructor(wantsNeighbours = false, overlapsLoad = false) {
    this.wantsNeighbours = wantsNeighbours;
    this.overlapsLoad = overlapsLoad;
  }

  setCrossfade(sec: number): void {
    this.crossfades.push(sec);
  }

  setListener(l: AudioEngineListener | null): void {
    this.listener = l;
  }
  /** When set, `load` waits for it (a load still in flight). */
  loadGate: Promise<void> | null = null;

  async load(media: EngineMedia, neighbours?: EngineNeighbours): Promise<void> {
    this.loaded.push(media.id);
    this.neighbours.push(neighbours);
    if (this.loadGate) await this.loadGate;
    if (this.failLoadOn.has(media.id)) throw new Error('load failed');
  }
  /** When set, `play` waits for it before starting (a pending play start). */
  playGate: Promise<void> | null = null;

  async play(): Promise<void> {
    if (this.playGate) await this.playGate;
    if (this.rejectPlayWith) throw this.rejectPlayWith;
    const id = this.loaded.at(-1) ?? '';
    if (this.failOn.has(id)) {
      this.listener?.onError({ code: this.failCode, message: 'bad file' });
    } else {
      this.listener?.onPlaying();
    }
  }
  async pause(): Promise<void> {
    this.pauses++;
    this.listener?.onPaused();
  }
  preload(neighbours: EngineNeighbours): void {
    this.preloads.push(neighbours);
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
    overlapsLoad?: boolean;
    retryDelaysMs?: readonly number[];
    resolve?: (track: Track) => Promise<PlayableSource>;
    resolveNeighbour?: PlayerEngineOptions['resolveNeighbour'];
    transientError?: PlayerEngineOptions['transientError'];
  } = {},
) {
  const fake = new FakeEngine(
    opts.wantsNeighbours ?? false,
    opts.overlapsLoad ?? false,
  );
  const player = new PlayerEngine(fake, opts.resolve ?? resolve, {
    random: seeded(),
    retryDelaysMs: opts.retryDelaysMs,
    transientError: opts.transientError,
    resolveNeighbour: opts.resolveNeighbour,
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
    // a and b were never played, so they are still in the shuffle pool.
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

  it('shuffle keeps played history before the current track', async () => {
    const { player, ids } = setup();
    await player.setQueue(tracks, { startIndex: 0 });
    await player.next();
    await player.next(); // a and b played; now c
    player.setShuffle(true);

    expect(ids()).toBe('c');
    expect([...player.upcoming().map((t) => t.id)].sort()).toEqual(['d', 'e']);
    await player.previous();
    expect(ids()).toBe('b');
    await player.previous();
    expect(ids()).toBe('a');
  });

  it('plays Your Stack first, playNext at the front, then resumes Keep Spinning', async () => {
    const { player, ids } = setup();
    await player.setQueue(tracks.slice(0, 4), { startIndex: 1 }); // b
    player.playNext(track('x'));
    player.playNext(track('y'));
    const upcoming = () =>
      player.upcomingEntries().map((e) => e.track.id + (e.stackEntryId ? '*' : ''));
    // playNext goes to the front: the newest sits first.
    expect(upcoming()).toEqual(['y*', 'x*', 'c', 'd']);

    // Remove a normal item and a stack item by queue index.
    const at = (id: string) =>
      player.upcomingEntries().find((e) => e.track.id === id)?.queueIndex ?? -1;
    expect(player.removeUpcoming(at('d'))).toBe(true);
    player.playNext(track('z'));
    expect(player.removeUpcoming(at('y'))).toBe(true);
    expect(upcoming()).toEqual(['z*', 'x*', 'c']);

    const played: string[] = [];
    while (await player.next()) played.push(ids() ?? '');
    expect(played).toEqual(['z', 'x', 'c']);
    expect(player.upcomingEntries().some((e) => e.stackEntryId)).toBe(false);
  });

  describe('Your Stack', () => {
    const stackIds = (player: PlayerEngine) =>
      player.stackEntries().map((e) => e.track.id);

    it('addToStack appends after existing stack entries, before Keep Spinning', async () => {
      const { player } = setup();
      await player.setQueue(tracks.slice(0, 4), { startIndex: 0 }); // a
      player.addToStack(track('x'));
      player.addToStack(track('y'));
      player.playNext(track('z'));
      expect(stackIds(player)).toEqual(['z', 'x', 'y']);
      expect(player.keepSpinningEntries().map((e) => e.track.id)).toEqual([
        'b',
        'c',
        'd',
      ]);
      expect(player.upcoming().map((t) => t.id)).toEqual(['z', 'x', 'y', 'b', 'c', 'd']);
    });

    it('allows the same song many times, each with its own entry id', async () => {
      const { player } = setup();
      await player.setQueue(tracks.slice(0, 2), { startIndex: 0 }); // a, b
      player.addToStack(track('x'));
      player.addToStack(track('x'));
      const [first, second] = player.stackEntries();
      expect(stackIds(player)).toEqual(['x', 'x']);
      expect(first.entryId).not.toBe(second.entryId);
      expect(player.removeStackEntry(second.entryId)).toBe(true);
      expect(player.stackEntries().map((e) => e.entryId)).toEqual([first.entryId]);
    });

    it('allows the currently playing song in the stack', async () => {
      const { player } = setup();
      await player.setQueue(tracks.slice(0, 2), { startIndex: 0 }); // a playing
      player.addToStack(track('a'));
      expect(stackIds(player)).toEqual(['a']);
      expect(player.currentIndex()).toBe(0);
      expect(player.current()?.id).toBe('a');
    });

    it('removeStackEntry returns false for an unknown or Keep Spinning entry', async () => {
      const { player } = setup();
      await player.setQueue(tracks.slice(0, 3), { startIndex: 0 });
      player.addToStack(track('x'));
      expect(player.removeStackEntry('missing')).toBe(false);
      expect(stackIds(player)).toEqual(['x']);
    });

    it('clearStack empties the stack and keeps Keep Spinning', async () => {
      const { player } = setup();
      await player.setQueue(tracks.slice(0, 4), { startIndex: 0 });
      player.addToStack(track('x'));
      player.playNext(track('y'));
      player.clearStack();
      expect(player.stackEntries()).toEqual([]);
      expect(player.upcoming().map((t) => t.id)).toEqual(['b', 'c', 'd']);
    });

    it('clearKeepSpinning keeps Your Stack and history', async () => {
      const { player } = setup();
      await player.setQueue(tracks, { startIndex: 0 });
      await player.next(); // a played; now b
      player.addToStack(track('x'));
      player.clearKeepSpinning();
      expect(stackIds(player)).toEqual(['x']);
      expect(player.upcoming().map((t) => t.id)).toEqual(['x']);
      expect(player.current()?.id).toBe('b');
      expect(player.queue().map((t) => t.id)).toEqual(['a', 'b', 'x']);
    });

    it('setStack replaces pending stack entries and keeps their ids', async () => {
      const { player } = setup();
      await player.setQueue(tracks.slice(0, 3), { startIndex: 0 });
      player.addToStack(track('x'));
      const kept = { entryId: 'kept-id', track: track('y') };
      player.setStack([kept, { entryId: 'other-id', track: track('z') }]);
      expect(player.stackEntries()).toEqual([
        kept,
        { entryId: 'other-id', track: track('z') },
      ]);
      expect(player.upcoming().map((t) => t.id)).toEqual(['y', 'z', 'b', 'c']);
    });

    it('a stack applied while nothing is loaded starts on play', async () => {
      const { player } = setup();
      player.setStack([
        { entryId: 'e1', track: track('x') },
        { entryId: 'e2', track: track('y') },
      ]);
      expect(player.currentIndex()).toBe(-1);
      expect(stackIds(player)).toEqual(['x', 'y']);

      await player.play();

      expect(player.current()?.id).toBe('x');
      expect(stackIds(player)).toEqual(['y']);
    });

    it('playNext on an idle engine puts the new entry before the stack', async () => {
      const { player } = setup();
      player.setStack([{ entryId: 'e1', track: track('x') }]);

      player.playNext(track('z'));

      expect(stackIds(player)).toEqual(['z', 'x']);
      expect(await player.startStack()).toBe(true);
      expect(player.current()?.id).toBe('z');
    });

    it('keeps Your Stack through a queue replace while the new track loads', async () => {
      const { player, fake } = setup();
      await player.setQueue(tracks.slice(0, 2), { startIndex: 0 });
      player.addToStack(track('x'));
      const kept = player.stackEntries();

      let release!: () => void;
      fake.loadGate = new Promise<void>((resolve) => (release = resolve));
      const replacing = player.setQueue(tracks.slice(2, 4), {
        startIndex: 0,
        keepStack: kept,
      });
      // Synchronously, before the load finishes: the stack is already back.
      expect(player.stackEntries()).toEqual(kept);

      release();
      await replacing;
      expect(player.stackEntries()).toEqual(kept);
      expect(player.current()?.id).toBe('c');
    });

    it('refuses stack entries beyond the 500 cap', () => {
      const { player } = setup();
      player.setStack(
        Array.from({ length: MAX_STACK_ENTRIES }, (_, i) => ({
          entryId: `e${i}`,
          track: track('x'),
        })),
      );
      player.addToStack(track('over'));
      expect(player.stackEntries()).toHaveLength(MAX_STACK_ENTRIES);
    });
  });

  describe('replaceUpcoming', () => {
    it('swaps a non-current entry in place without loading media', async () => {
      const { player, fake } = setup();
      await player.setQueue(tracks.slice(0, 3), { startIndex: 0 });
      player.playNext(track('x'));
      fake.listener?.onTime(30);
      const loads = fake.loaded.length;
      const seq = player.loadSeq();
      const position = player.position();
      const status = player.status();
      const current = player.current();
      const next = sourced('b', '/b-v2.mp3');

      expect(player.replaceUpcoming('b', next)).toBe(true);

      expect(player.queue().map((t) => t.id)).toEqual(['a', 'x', 'b', 'c']);
      expect(player.queue()[2]).toBe(next);
      // Playback is untouched: same load generation, media and transport state.
      expect(player.current()).toBe(current);
      expect(player.currentIndex()).toBe(0);
      expect(player.loadSeq()).toBe(seq);
      expect(fake.loaded.length).toBe(loads);
      expect(player.status()).toBe(status);
      expect(player.position()).toBe(position);
      expect(player.stackEntries().length).toBe(1);

      // The current record and an absent id are refused.
      expect(player.replaceUpcoming('a', track('z'))).toBe(false);
      expect(player.replaceUpcoming('missing', track('z'))).toBe(false);
      expect(player.queue().map((t) => t.id)).toEqual(['a', 'x', 'b', 'c']);
    });
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

    it('retries an unsupported remote source after the 2s floor, then plays', async () => {
      vi.useFakeTimers();
      try {
        const { player, ids, fake } = setup({
          resolve: async (t) => ({
            url: `/remote/${t.id}.mp3`,
            kind: 'remote',
          }),
        });
        fake.failOn.add('a');
        fake.failCode = 'unsupported';

        await player.setQueue(tracks.slice(0, 2));
        expect(fake.loaded).toEqual(['a']);
        expect(player.status()).toBe('loading');
        expect(player.retrying()).toBe(true);

        fake.failOn.delete('a');
        // The 2s floor wins over the shorter default backoff.
        await wait(UNSUPPORTED_REMOTE_RETRY_DELAYS_MS[0] - 1);
        expect(fake.loaded).toEqual(['a']);
        await wait(1);
        expect(fake.loaded).toEqual(['a', 'a']);
        expect(ids()).toBe('a');
        expect(player.status()).toBe('playing');
        expect(player.retrying()).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    it('gives a cold remote link the full ~10s warm-up window', async () => {
      vi.useFakeTimers();
      try {
        const { player, fake } = setup({
          resolve: async (t) => ({
            url: `/remote/${t.id}.mp3`,
            kind: 'remote',
          }),
        });
        fake.failOn.add('a');
        fake.failCode = 'unsupported';

        await player.setQueue([track('a')]);
        expect(fake.loaded).toHaveLength(1);
        expect(player.retrying()).toBe(true);

        await wait(UNSUPPORTED_REMOTE_RETRY_DELAYS_MS[0]);
        expect(fake.loaded).toHaveLength(2);
        await wait(UNSUPPORTED_REMOTE_RETRY_DELAYS_MS[1]);
        expect(fake.loaded).toHaveLength(3);
        await wait(UNSUPPORTED_REMOTE_RETRY_DELAYS_MS[2]);
        expect(fake.loaded).toHaveLength(4);
        expect(player.status()).toBe('error');
        expect(player.retrying()).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    it('keeps an unsupported local source terminal (no retry)', async () => {
      vi.useFakeTimers();
      try {
        for (const kind of ['bundled', 'file'] as const) {
          const { player, fake } = setup({
            resolve: async (t) => ({ url: `/${t.id}.mp3`, kind }),
          });
          fake.failOn.add('a');
          fake.failCode = 'unsupported';

          await player.setQueue([track('a')]);
          expect(player.status()).toBe('error');
          expect(player.retrying()).toBe(false);
          expect(player.error()).toMatchObject({
            trackId: 'a',
            code: 'unsupported',
          });

          await wait(10_000);
          expect(fake.loaded).toEqual(['a']);
        }
      } finally {
        vi.useRealTimers();
      }
    });

    it('retries an unsupported resume of a remote source, then plays', async () => {
      vi.useFakeTimers();
      try {
        const { player, ids, fake } = setup({
          resolve: async (t) => ({
            url: `/remote/${t.id}.mp3`,
            kind: 'remote',
          }),
        });
        await player.setQueue(tracks.slice(0, 2), { autoplay: false });
        expect(player.status()).toBe('paused');
        expect(fake.loaded).toEqual(['a']);

        fake.rejectPlayWith = { code: 'unsupported', message: 'not ready' };
        await player.play();
        expect(player.status()).toBe('loading');
        expect(player.retrying()).toBe(true);
        expect(player.error()).toBeNull();

        fake.rejectPlayWith = null;
        await wait(UNSUPPORTED_REMOTE_RETRY_DELAYS_MS[0] - 1);
        expect(fake.loaded).toEqual(['a']);
        await wait(1);
        expect(fake.loaded).toEqual(['a', 'a']);
        expect(ids()).toBe('a');
        expect(player.status()).toBe('playing');
        expect(player.retrying()).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    it('lets a slow load finish when play is pressed again', async () => {
      let release!: (source: PlayableSource) => void;
      const { player, fake } = setup({
        resolve: () =>
          new Promise<PlayableSource>((resolve) => {
            release = resolve;
          }),
      });
      const started = player.setQueue([track('a')]);
      await flush();
      expect(player.status()).toBe('loading');

      // The control shows Play while loading: a second press must not cancel
      // the in-flight load (e.g. a cold remote link).
      await player.togglePlay();
      expect(player.status()).toBe('loading');
      expect(player.error()).toBeNull();
      expect(fake.loaded).toEqual([]);

      release({ url: '/a.mp3', kind: 'bundled' });
      await started;
      expect(player.status()).toBe('playing');
      expect(fake.loaded).toEqual(['a']);
    });

    it('retries a resume after playback had started', async () => {
      vi.useFakeTimers();
      try {
        const { player, fake } = setup({
          resolve: async (t) => ({
            url: `/remote/${t.id}.mp3`,
            kind: 'remote',
          }),
        });
        await player.setQueue(tracks.slice(0, 2));
        expect(player.status()).toBe('playing');
        await player.pause();
        expect(player.status()).toBe('paused');

        fake.rejectPlayWith = { code: 'unsupported', message: 'not ready' };
        await player.play();
        expect(player.status()).toBe('loading');
        expect(player.retrying()).toBe(true);

        fake.rejectPlayWith = null;
        await wait(UNSUPPORTED_REMOTE_RETRY_DELAYS_MS[0]);
        expect(player.status()).toBe('playing');
        expect(player.error()).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });

    it('keeps an unsupported resume of a local source terminal (no retry)', async () => {
      vi.useFakeTimers();
      try {
        for (const kind of ['bundled', 'file'] as const) {
          const { player, ids, fake } = setup({
            resolve: async (t) => ({ url: `/${t.id}.mp3`, kind }),
          });
          await player.setQueue([track('a')], { autoplay: false });
          expect(player.status()).toBe('paused');

          fake.rejectPlayWith = { code: 'unsupported', message: 'bad format' };
          await player.play();
          expect(player.status()).toBe('error');
          expect(player.retrying()).toBe(false);
          expect(ids()).toBe('a');
          expect(player.error()).toMatchObject({
            trackId: 'a',
            code: 'unsupported',
          });

          await wait(10_000);
          expect(fake.loaded).toEqual(['a']);
        }
      } finally {
        vi.useRealTimers();
      }
    });

    it('keeps a mid-track unsupported error terminal, even for a remote source', async () => {
      vi.useFakeTimers();
      try {
        const { player, fake } = setup({
          resolve: async (t) => ({
            url: `/remote/${t.id}.mp3`,
            kind: 'remote',
          }),
        });
        await player.setQueue(tracks.slice(0, 2));
        expect(player.status()).toBe('playing');

        fake.listener?.onError({ code: 'unsupported', message: 'dropped' });
        expect(player.status()).toBe('error');
        expect(player.retrying()).toBe(false);

        await wait(10_000);
        expect(fake.loaded).toEqual(['a']);
      } finally {
        vi.useRealTimers();
      }
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
            // Only `a` counts: a playing `a` also resolves neighbour `b` (preload).
            if (t.id === 'a') {
              resolves++;
              if (resolves <= 3) throw networkError();
            }
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

    it('does not pause a native engine on a skip', async () => {
      const { player, fake } = setup({ wantsNeighbours: true });
      await player.setQueue(timedTracks(), { startIndex: 0 });
      await flush();

      nativeSkip(fake, 'next', 'b');
      await flush();

      expect(player.current()?.id).toBe('b');
      expect(fake.pauses).toBe(0);
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

    it('clears pending Your Stack entries when a session order is applied', async () => {
      const { player } = setup();
      await player.setQueue(tracks.slice(0, 3), { startIndex: 0 });
      player.playNext(track('x'));
      expect(player.stackEntries().length).toBe(1);

      await player.applyOrder(tracks.slice(0, 2), 0);

      expect(player.stackEntries()).toEqual([]);
      expect(player.queue().map((t) => t.id)).toEqual(['a', 'b']);
      expect(player.upcoming().map((t) => t.id)).toEqual(['b']);
    });

    it('restores session stack entry ids as slots right after the cursor', async () => {
      const { player } = setup();
      await player.setQueue(tracks.slice(0, 1), { startIndex: 0 });

      await player.applyOrder([track('a'), track('x'), track('y'), track('b')], 0, {
        stackEntryIds: ['e1', 'e2'],
      });

      expect(player.stackEntries().map((s) => [s.entryId, s.track.id])).toEqual([
        ['e1', 'x'],
        ['e2', 'y'],
      ]);
      expect(player.upcoming().map((t) => t.id)).toEqual(['x', 'y', 'b']);
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

  describe('web preload', () => {
    it('preloads both neighbours once the current track plays', async () => {
      const { player, fake } = setup();
      await player.setQueue(tracks.slice(0, 3), { startIndex: 1 });
      await flush();

      expect(fake.preloads.at(-1)?.previous?.id).toBe('a');
      expect(fake.preloads.at(-1)?.next?.id).toBe('c');
    });

    it('re-preloads the window after moving on, and drops next in repeat one', async () => {
      const { player, fake } = setup();
      await player.setQueue(tracks.slice(0, 3), { startIndex: 0 });
      await flush();

      await player.next();
      await flush();
      expect(fake.preloads.at(-1)?.previous?.id).toBe('a');
      expect(fake.preloads.at(-1)?.next?.id).toBe('c');

      player.setRepeat('one');
      await flush();
      expect(fake.preloads.at(-1)?.previous?.id).toBe('a');
      expect(fake.preloads.at(-1)?.next).toBeUndefined();
    });

    it('does not re-preload on pause and resume of the same window', async () => {
      const { player, fake } = setup();
      await player.setQueue(tracks.slice(0, 3), { startIndex: 1 });
      await flush();
      const count = fake.preloads.length;

      await player.pause();
      await player.play();
      await flush();

      expect(fake.preloads.length).toBe(count);
    });

    it('does not re-resolve a track it already holds when it becomes a neighbour again', async () => {
      const resolved: string[] = [];
      const { player, fake } = setup({
        resolve: async (t) => {
          resolved.push(t.id);
          return { url: `/${t.id}.mp3`, kind: 'bundled' };
        },
      });
      await player.setQueue(tracks.slice(0, 4), { startIndex: 1 });
      await flush();
      await player.next();
      await flush();

      // `b` (the track we left) is now the previous neighbour: reused, not resolved.
      expect(fake.preloads.at(-1)?.previous?.id).toBe('b');
      expect(resolved.filter((id) => id === 'b')).toHaveLength(1);
    });

    it('re-preloads when the queue changes under it (play next, remove, add, shuffle, new queue)', async () => {
      const { player, fake } = setup();
      await player.setQueue(tracks.slice(0, 3), { startIndex: 1 });
      await flush();
      expect(fake.preloads.at(-1)?.next?.id).toBe('c');

      // "Play next" puts a new track straight after the current one.
      player.playNext(track('z'));
      await flush();
      expect(fake.preloads.at(-1)?.next?.id).toBe('z');

      // Removing it brings the old next track back.
      player.removeUpcoming(player.upcomingEntries()[0].queueIndex);
      await flush();
      expect(fake.preloads.at(-1)?.next?.id).toBe('c');

      // Appending past the end of a one-track-after window fills the gap.
      await player.next();
      await player.next();
      await flush();
      expect(fake.preloads.at(-1)?.next).toBeUndefined();
      player.add([track('y')]);
      await flush();
      expect(fake.preloads.at(-1)?.next?.id).toBe('y');

      // Shuffle changes what is next; the window follows the new order.
      player.setShuffle(true);
      await flush();
      const shuffledNext = player.upcoming()[0]?.id;
      expect(fake.preloads.at(-1)?.next?.id).toBe(shuffledNext);
      player.setShuffle(false);
      await flush();
      expect(fake.preloads.at(-1)?.next?.id).toBe(player.upcoming()[0]?.id);

      // A whole new queue (new playlist) starts a fresh window.
      await player.setQueue(tracks.slice(0, 3), { startIndex: 0 });
      await flush();
      expect(fake.preloads.at(-1)?.previous).toBeUndefined();
      expect(fake.preloads.at(-1)?.next?.id).toBe('b');
    });

    it('never preloads for a native engine', async () => {
      const { player, fake } = setup({ wantsNeighbours: true });
      await player.setQueue(tracks.slice(0, 3), { startIndex: 1 });
      await flush();
      player.setRepeat('all');
      await flush();

      expect(fake.preloads).toEqual([]);
    });

    it('drops a preload whose window went stale while resolving', async () => {
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      let held = false;
      const { player, fake } = setup({
        resolve: async (t) => {
          // Hold only the first resolve of `c`: the preload for `b`'s window.
          if (t.id === 'c' && !held) {
            held = true;
            await gate;
          }
          return { url: `/${t.id}.mp3`, kind: 'bundled' };
        },
      });
      await player.setQueue(tracks.slice(0, 4), { startIndex: 1 });
      await flush();
      await player.next();
      release();
      await flush();

      // The `b` window (previous a) was resolved while the token moved on.
      expect(fake.preloads.some((p) => p.previous?.id === 'a')).toBe(false);
      expect(fake.preloads.at(-1)?.previous?.id).toBe('b');
    });

    it('hands next to preload before a slow previous resolves', async () => {
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const { player, fake } = setup({
        resolve: async (t) => {
          // The previous neighbour (`a`) is slow; next (`c`) is not.
          if (t.id === 'a') await gate;
          return { url: `/${t.id}.mp3`, kind: 'bundled' };
        },
      });
      await player.setQueue(tracks.slice(0, 4), { startIndex: 1 });
      await flush();

      // next arrives while previous is still resolving, with previous absent.
      expect(fake.preloads).toHaveLength(1);
      expect(fake.preloads[0]?.next?.id).toBe('c');
      expect(fake.preloads[0]?.previous).toBeUndefined();

      release();
      await flush();
      expect(fake.preloads.at(-1)?.previous?.id).toBe('a');
      expect(fake.preloads.at(-1)?.next?.id).toBe('c');
    });

    it('resolves a cached neighbour again when its art changed', async () => {
      const resolved: string[] = [];
      const { player, fake } = setup({
        resolve: async (t) => {
          resolved.push(t.id);
          return { url: `/${t.id}.mp3`, kind: 'bundled' };
        },
      });
      await player.setQueue(tracks.slice(0, 4), { startIndex: 1 });
      await flush();
      await player.next();
      await flush();
      resolved.length = 0;

      player.replaceUpcoming('b', { ...track('b'), artUrl: 'art.jpg' });
      await flush();

      expect(resolved).toContain('b');
      expect(fake.preloads.at(-1)?.previous?.artUrl).toBe('art.jpg');
    });

    it('retries a neighbour that failed to resolve on the next play', async () => {
      let failC = true;
      const { player, fake } = setup({
        resolve: async (t) => {
          if (t.id === 'c' && failC) throw networkError();
          return { url: `/${t.id}.mp3`, kind: 'bundled' };
        },
      });
      await player.setQueue(tracks.slice(0, 3), { startIndex: 1 });
      await flush();
      expect(fake.preloads.at(-1)?.next).toBeUndefined();

      failC = false;
      await player.pause();
      await player.play();
      await flush();
      expect(fake.preloads.at(-1)?.next?.id).toBe('c');
    });

    it('resolves neighbours one at a time, next before previous', async () => {
      const started: string[] = [];
      let inFlight = 0;
      let peak = 0;
      const { player, fake } = setup({
        resolveNeighbour: async (t) => {
          started.push(t.id);
          inFlight++;
          peak = Math.max(peak, inFlight);
          await flush();
          inFlight--;
          return { url: `/${t.id}.mp3`, kind: 'remote' };
        },
      });
      await player.setQueue(tracks.slice(0, 3), { startIndex: 1 });
      await flush();
      await flush();

      expect(started).toEqual(['c', 'a']);
      expect(peak).toBe(1);
      expect(fake.preloads.at(-1)?.next?.id).toBe('c');
      expect(fake.preloads.at(-1)?.previous?.id).toBe('a');
    });

    it('leaves a gap for a neighbour that fails to resolve', async () => {
      const { player, fake } = setup({
        resolve: async (t) => {
          if (t.id === 'a') throw new Error('offline');
          return { url: `/${t.id}.mp3`, kind: 'bundled' };
        },
      });
      await player.setQueue(tracks.slice(0, 3), { startIndex: 1 });
      await flush();

      expect(fake.preloads.at(-1)?.previous).toBeUndefined();
      expect(fake.preloads.at(-1)?.next?.id).toBe('c');
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

    it('does not move the audio while the next track is still loading', async () => {
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const { player, fake } = setup({
        resolve: async (t) => {
          if (t.id === 'b') await gate;
          return { url: `/${t.id}.mp3`, kind: 'bundled' };
        },
      });
      await player.setQueue([track('a'), track('b')]);
      fake.listener?.onTime(10);

      const pending = player.next();
      expect(player.status()).toBe('loading');
      // A session anchor near 0 for the new track must not seek the old audio.
      await player.seekIfDrifted(0);
      expect(fake.seeks).toEqual([]);

      release();
      await pending;
      expect(player.status()).toBe('playing');
      await player.seekIfDrifted(40);
      expect(fake.seeks.at(-1)).toBe(40);
    });

    it('ignores an anchor for a track that is not the current one', async () => {
      const { player, fake } = setup();
      await player.setQueue([track('a'), track('b')]);
      await player.seekIfDrifted(30, 2, 'b');
      expect(fake.seeks).toEqual([]);
      await player.seekIfDrifted(30, 2, 'a');
      expect(fake.seeks.at(-1)).toBe(30);
    });
  });

  it('keeps the outgoing track ticks out of a slow non-neighbour jump', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { player, fake } = setup({
      resolve: async (t) => {
        if (t.id === 'c') await gate;
        return { url: `/${t.id}.mp3`, kind: 'bundled' };
      },
    });
    await player.setQueue(tracks.slice(0, 4)); // a, b, c, d
    fake.listener?.onTime(92); // a is playing at 1:32

    // c resolves slowly, so the jump stays in 'loading' for a while.
    const jump = player.playAt(2);
    expect(player.status()).toBe('loading');
    expect(player.mediaLoaded).toBe(false);
    // The old element keeps ticking until the new source is swapped in.
    fake.listener?.onTime(92.5);
    expect(player.position()).toBe(0);

    release();
    await jump;
    expect(player.mediaLoaded).toBe(true);
    expect(player.current()?.id).toBe('c');
    expect(player.status()).toBe('playing');
    expect(player.position()).toBe(0);

    // Once the new media is loaded, its own ticks are accepted again.
    fake.listener?.onTime(1);
    expect(player.position()).toBe(1);
  });

  it('pauses the outgoing track at once on a web engine jump', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { player, fake } = setup({
      resolve: async (t) => {
        if (t.id === 'c') await gate;
        return { url: `/${t.id}.mp3`, kind: 'bundled' };
      },
    });
    await player.setQueue(tracks.slice(0, 4));
    // setQueue pauses too while loading `a`; count only the jump's pause.
    fake.pauses = 0;

    const jump = player.playAt(2);
    expect(fake.pauses).toBe(1);

    release();
    await jump;
  });

  it('keeps the outgoing track playing during an overlapping load', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { player, fake } = setup({
      overlapsLoad: true,
      resolve: async (t) => {
        if (t.id === 'c') await gate;
        return { url: `/${t.id}.mp3`, kind: 'bundled' };
      },
    });
    await player.setQueue(tracks.slice(0, 4));
    fake.pauses = 0;

    const jump = player.playAt(2);
    expect(fake.pauses).toBe(0);

    release();
    await jump;
    expect(player.status()).toBe('playing');
  });

  it('stays paused when paused during an overlapping load', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { player, fake } = setup({
      overlapsLoad: true,
      resolve: async (t) => {
        if (t.id === 'c') await gate;
        return { url: `/${t.id}.mp3`, kind: 'bundled' };
      },
    });
    await player.setQueue(tracks.slice(0, 4));

    const jump = player.playAt(2);
    await player.pause();
    // The outgoing track is silenced at once, not left playing to the swap.
    expect(fake.pauses).toBeGreaterThan(0);

    release();
    await jump;
    expect(fake.loaded.at(-1)).toBe('c');
    expect(player.status()).toBe('paused');
    expect(player.intendsToPlay).toBe(false);
  });

  it('shows paused when paused after the load finished but before play started', async () => {
    const { player, fake } = setup();
    let release!: () => void;
    fake.playGate = new Promise<void>((r) => (release = r));

    const started = player.setQueue([track('a')]);
    await flush();
    expect(fake.loaded).toEqual(['a']);
    expect(player.status()).toBe('loading');

    await player.pause();
    expect(player.status()).toBe('paused');

    release();
    await started;
  });

  it('pauses an overlapping load on a play press instead of ignoring it', async () => {
    let release!: (source: PlayableSource) => void;
    const { player, fake } = setup({
      overlapsLoad: true,
      resolve: () =>
        new Promise<PlayableSource>((resolve) => {
          release = resolve;
        }),
    });
    const started = player.setQueue([track('a')]);
    await flush();
    expect(player.status()).toBe('loading');

    // The old audio is still playing: a press that means "pause" silences it.
    await player.togglePlay();
    expect(fake.pauses).toBe(1);

    release({ url: '/a.mp3', kind: 'bundled' });
    await started;
    expect(player.status()).toBe('paused');
  });

  it('ignores the outgoing track ended event during an overlapping load', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { player, fake, ids } = setup({
      overlapsLoad: true,
      resolve: async (t) => {
        if (t.id === 'c') await gate;
        return { url: `/${t.id}.mp3`, kind: 'bundled' };
      },
    });
    await player.setQueue([timed('a', 200), timed('b', 200), timed('c', 200), timed('d', 200)]);
    const before = player.lastPlay();

    const jump = player.playAt(2);
    // The outgoing track ends while the slow load for `c` is still in flight.
    fake.listener?.onEnded();

    release();
    await jump;
    expect(fake.loaded).not.toContain('d');
    expect(ids()).toBe('c');
    expect(player.lastPlay()).toEqual(before);
    expect(player.status()).toBe('playing');
  });

  it('forwards the crossfade length to the engine', () => {
    const { player, fake } = setup({ overlapsLoad: true });
    player.setCrossfadeSec(3);
    expect(fake.crossfades).toEqual([3]);
  });

  it('silences an overlapping engine when a final error stops playback', async () => {
    const { player, fake } = setup({ overlapsLoad: true });
    fake.failOn.add('a');
    fake.failCode = 'unsupported';

    await player.setQueue([track('a')]);
    expect(player.status()).toBe('error');
    // The overlap path skips the start pause, so this one pause is the fail's.
    expect(fake.pauses).toBe(1);
  });

  it('does not pause a non-overlapping engine on a final error', async () => {
    const { player, fake } = setup();
    fake.failOn.add('a');
    fake.failCode = 'unsupported';

    await player.setQueue([track('a')]);
    expect(player.status()).toBe('error');
    // Only the start-of-load pause: the error itself adds none.
    expect(fake.pauses).toBe(1);
  });

  it('does not pause on a retryable failure that schedules a retry', async () => {
    vi.useFakeTimers();
    try {
      const { player, fake } = setup({ overlapsLoad: true });
      fake.failOn.add('a');
      fake.failCode = 'network';

      await player.setQueue([track('a')]);
      expect(player.retrying()).toBe(true);
      expect(fake.pauses).toBe(0);
    } finally {
      vi.useRealTimers();
    }
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
      await player.setQueue(tracks, { startIndex: 0 });
      for (let i = 0; i < 4; i++) await player.next(); // a..d played; now e
      player.playNext(track('x'));
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
      expect(player.stackEntries().map((e) => e.track.id)).toEqual(['x']);
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
      expect(player.stackEntries().map((e) => e.track.id)).toEqual(['x']);
    });

    it('never drops tracks that were jumped over, only played history', async () => {
      const { player } = setup();
      await player.setQueue(tracks, { startIndex: 2 }); // c; a and b unplayed
      await player.next();
      await player.next(); // now e; c and d played
      player.dropPlayed(1);
      expect(player.queue().map((t) => t.id)).toEqual(['a', 'b', 'd', 'e']);
      expect(player.current()?.id).toBe('e');
    });

    it('under shuffle drops only played tracks and keeps the current one', async () => {
      const { player } = setup();
      await player.setQueue(tracks, { startIndex: 0 });
      player.setShuffle(true);
      const played = [player.current()?.id ?? ''];
      for (let i = 0; i < 3; i++) {
        await player.next();
        played.push(player.current()?.id ?? '');
      }
      // The last entry is current; the first two are older than `keep`.
      const current = player.current()?.id;
      const upcoming = player.upcoming().map((t) => t.id);

      player.dropPlayed(1);

      expect(player.current()?.id).toBe(current);
      expect(player.upcoming().map((t) => t.id)).toEqual(upcoming);
      expect(player.queue().map((t) => t.id)).toEqual(
        tracks.map((t) => t.id).filter((id) => !played.slice(0, 2).includes(id)),
      );
      // The kept history is still reachable.
      await player.previous();
      expect(player.current()?.id).toBe(played[2]);
    });

    it('bounds seeded history across dropPlayed when the queue starts mid-list', async () => {
      const { player } = setup();
      const many = Array.from({ length: 40 }, (_, i) => track(`t${i}`));
      await player.setQueue(many, { startIndex: 30, history: 'before-start' });

      // The 30 entries before the cursor are history: keep 20, drop 10.
      player.dropPlayed(20);
      expect(player.queue().length).toBe(30);
      expect(player.currentIndex()).toBe(20);
      expect(player.current()?.id).toBe('t30');

      // Advancing adds history; dropping again keeps it bounded at 20.
      for (let i = 0; i < 5; i++) await player.next();
      player.dropPlayed(20);
      expect(player.queue().length).toBe(25);
      expect(player.currentIndex()).toBe(20);
      expect(player.current()?.id).toBe('t35');
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

  describe('Keep Spinning exclusion events', () => {
    /** Attach a listener that records `kind:trackId` in order; `drain` reads and clears it. */
    function recorder(player: PlayerEngine) {
      const events: string[] = [];
      player.setExclusionListener((e) => events.push(`${e.kind}:${e.trackId}`));
      return { drain: () => events.splice(0) };
    }

    it('reports a track as played once it starts, not again on resume', async () => {
      const { player } = setup();
      const { drain } = recorder(player);
      await player.setQueue(tracks.slice(0, 2), { startIndex: 0 });
      expect(drain()).toEqual(['played:a']);

      await player.pause();
      await player.play();
      expect(drain()).toEqual([]);
    });

    it('reports the track left by next, previous or a row tap as skipped', async () => {
      const { player } = setup();
      const { drain } = recorder(player);
      await player.setQueue(tracks.slice(0, 4), { startIndex: 0 });
      drain();

      await player.next();
      expect(drain()).toEqual(['skipped:a', 'played:b']);

      await player.previous();
      expect(drain()).toEqual(['skipped:b', 'played:a']);

      await player.playAt(2);
      expect(drain()).toEqual(['skipped:a', 'played:c']);
    });

    it('does not report a track as skipped when it finishes', async () => {
      const { fake, player } = setup();
      const { drain } = recorder(player);
      await player.setQueue(tracks.slice(0, 3), { startIndex: 0 });
      drain();

      fake.listener?.onEnded();
      await flush();
      expect(drain()).toEqual(['played:b']);
    });

    it('reports Keep Spinning entries jumped over without playing, not the ones already played', async () => {
      const { player } = setup();
      const { drain } = recorder(player);
      await player.setQueue(tracks, { startIndex: 0 });
      drain();

      await player.playAt(3);
      expect(drain()).toEqual(['skipped:a', 'jumped:b', 'jumped:c', 'played:d']);
    });

    it('does not report Your Stack entries passed over', async () => {
      const { player } = setup();
      const { drain } = recorder(player);
      await player.setQueue(tracks, { startIndex: 0 });
      player.playNext(track('x'));
      drain();

      // Queue is now a, x (stack), b, c, d, e: x is passed over, b and c are not.
      await player.playAt(4);
      expect(drain()).toEqual(['skipped:a', 'jumped:b', 'jumped:c', 'played:d']);
    });

    it('reports a single Keep Spinning removal only; enqueue, Your Stack and clears report nothing', async () => {
      const { player } = setup();
      const { drain } = recorder(player);
      await player.setQueue(tracks, { startIndex: 0 });
      drain();

      expect(player.removeUpcoming(2)).toBe(true); // c, Keep Spinning
      expect(drain()).toEqual(['removed:c']);

      player.playNext(track('x'));
      expect(player.removeUpcoming(1)).toBe(true); // x, Your Stack
      expect(drain()).toEqual([]);

      player.add([track('f')]);
      expect(drain()).toEqual([]);

      player.clearKeepSpinning();
      expect(drain()).toEqual([]);

      await player.clear();
      expect(drain()).toEqual([]);
    });

    it('does not report the queue as jumped when repeat-all wraps', async () => {
      const { player } = setup();
      const { drain } = recorder(player);
      player.setRepeat('all');
      await player.setQueue(tracks.slice(0, 4), { startIndex: 0 });
      drain();

      await player.previous(); // a -> d (wrap back to the end)
      expect(drain()).toEqual(['skipped:a', 'played:d']);

      await player.next(); // d -> a (wrap to the start)
      expect(drain()).toEqual(['skipped:d', 'played:a']);
    });

    it('reports nothing jumped on a backward move over unplayed entries', async () => {
      const { player } = setup();
      const { drain } = recorder(player);
      await player.setQueue(tracks, { startIndex: 3 });
      drain();

      await player.playAt(0);
      expect(drain()).toEqual(['skipped:d', 'played:a']);
    });

    it('does not report played again when a resumed play is retried', async () => {
      vi.useFakeTimers();
      try {
        const { player, fake } = setup({
          resolve: async (t) => ({ url: `/remote/${t.id}.mp3`, kind: 'remote' }),
        });
        const { drain } = recorder(player);
        await player.setQueue(tracks.slice(0, 2), { startIndex: 0 });
        expect(drain()).toEqual(['played:a']);

        await player.pause();
        fake.rejectPlayWith = { code: 'unsupported', message: 'not ready' };
        await player.play();
        expect(player.retrying()).toBe(true);

        fake.rejectPlayWith = null;
        await wait(UNSUPPORTED_REMOTE_RETRY_DELAYS_MS[0]);
        expect(player.status()).toBe('playing');
        expect(drain()).toEqual([]);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
