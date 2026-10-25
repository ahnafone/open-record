import { computed, signal } from '@angular/core';
import type { PlayableSource, Track } from '@open-record/models';
import { PlaybackBlockedError } from './audio-engine';
import type {
  AudioEngine,
  EngineError,
  EngineMedia,
  EngineNeighbours,
  SkipDirection,
} from './audio-engine';

export type TrackResolver = (track: Track) => Promise<PlayableSource>;

/** Loadable cover URL for a track (e.g. an imported file's stored cover). */
export type ArtResolver = (track: Track) => Promise<string | undefined>;

export type RepeatMode = 'off' | 'all' | 'one';

export type PlayerStatus =
  'idle' | 'loading' | 'playing' | 'paused' | 'ended' | 'error';

export interface PlayerError {
  trackId: string;
  code: EngineError['code'] | 'resolve';
  message: string;
}

export interface PlayerEngineOptions {
  /** Move on to the next track when one fails. Default true. */
  skipOnError?: boolean;
  /** Random source for shuffle, injectable for tests. Default Math.random. */
  random?: () => number;
  /**
   * Cover URL for OS media controls when `track.artUrl` is empty (imported
   * covers). Default: `track.artUrl` only.
   */
  resolveArt?: ArtResolver;
  /**
   * Source for the neighbour window (native prefetch). Return `undefined` to
   * leave that neighbour out (no pre-resolve, e.g. an unsaved remote track).
   * Default: the same resolver as the current track.
   */
  resolveNeighbour?: (track: Track) => Promise<PlayableSource | undefined>;
}

export interface SetQueueOptions {
  /** Index into `tracks` to start from. Default 0. */
  startIndex?: number;
  /** Start playing once loaded. Default true. */
  autoplay?: boolean;
}

/** Seconds into a track after which "previous" restarts it instead. */
export const RESTART_THRESHOLD_SEC = 3;

/**
 * Queue and transport logic on top of an AudioEngine. Framework-light: only
 * Angular signals, no DI, so it runs in plain unit tests with a fake engine.
 */
export class PlayerEngine {
  private readonly _queue = signal<readonly Track[]>([]);
  /** Play order as indices into the queue (identity unless shuffled). */
  private readonly _order = signal<readonly number[]>([]);
  /** Position within `_order`; -1 when nothing is loaded. */
  private readonly _cursor = signal(-1);
  private readonly _status = signal<PlayerStatus>('idle');
  private readonly _position = signal(0);
  private readonly _duration = signal(0);
  private readonly _shuffle = signal(false);
  private readonly _repeat = signal<RepeatMode>('off');
  private readonly _error = signal<PlayerError | null>(null);
  private readonly _skipOnError = signal(true);

  readonly queue = this._queue.asReadonly();
  readonly status = this._status.asReadonly();
  readonly position = this._position.asReadonly();
  readonly duration = this._duration.asReadonly();
  readonly shuffle = this._shuffle.asReadonly();
  readonly repeat = this._repeat.asReadonly();
  readonly error = this._error.asReadonly();
  readonly skipOnError = this._skipOnError.asReadonly();

  /** Queue index of the current track, or -1. */
  readonly currentIndex = computed(() => {
    const cursor = this._cursor();
    return cursor < 0 ? -1 : (this._order()[cursor] ?? -1);
  });
  readonly current = computed<Track | null>(
    () => this._queue()[this.currentIndex()] ?? null,
  );
  /** Tracks in the order they will play. */
  readonly upcoming = computed(() =>
    this._order()
      .slice(this._cursor() + 1)
      .map((i) => this._queue()[i]),
  );
  readonly isPlaying = computed(() => this._status() === 'playing');
  readonly hasNext = computed(() => this.peek(1) !== -1);
  readonly hasPrevious = computed(() => this.peek(-1) !== -1);

  private readonly random: () => number;
  private readonly artResolver?: ArtResolver;
  private readonly neighbourResolver?: (track: Track) => Promise<PlayableSource | undefined>;
  /** Bumped on every load; stale async work compares against it. */
  private loadToken = 0;
  /** Consecutive failures, so skip-on-error cannot loop forever. */
  private failures = 0;
  /** Whether the user wants sound once the current load finishes. */
  private playIntent = false;
  /** Load token that already reported a failure (avoid double handling). */
  private failedToken = -1;

  constructor(
    private readonly engine: AudioEngine,
    private readonly resolve: TrackResolver,
    options: PlayerEngineOptions = {},
  ) {
    this.random = options.random ?? Math.random;
    this.artResolver = options.resolveArt;
    this.neighbourResolver = options.resolveNeighbour;
    this._skipOnError.set(options.skipOnError ?? true);
    engine.setListener({
      onPlaying: () => {
        this.failures = 0;
        this._status.set('playing');
      },
      onPaused: () => {
        if (this._status() === 'playing') this._status.set('paused');
      },
      onTime: (sec) => this._position.set(sec),
      onDuration: (sec) => this._duration.set(sec),
      onEnded: () => void this.handleEnded(),
      onError: (err) =>
        this.fail({ code: err.code, message: err.message }, this.loadToken),
      onSkipped: (dir) => void this.handleSkipped(dir),
    });
  }

  // ---- Queue -------------------------------------------------------------

  /** Replace the queue and load `startIndex`. */
  async setQueue(
    tracks: readonly Track[],
    opts: SetQueueOptions = {},
  ): Promise<void> {
    const start = Math.min(
      Math.max(opts.startIndex ?? 0, 0),
      tracks.length - 1,
    );
    this._queue.set([...tracks]);
    if (!tracks.length) {
      await this.clear();
      return;
    }
    this.rebuildOrder(start);
    await this.loadCurrent(opts.autoplay ?? true);
  }

  /** Append tracks to the end of the queue (and of the shuffle order). */
  add(tracks: readonly Track[]): void {
    if (!tracks.length) return;
    const base = this._queue().length;
    this._queue.update((q) => [...q, ...tracks]);
    const added = tracks.map((_, i) => base + i);
    this._order.update((o) =>
      this._shuffle() ? [...o, ...this.shuffled(added)] : [...o, ...added],
    );
  }

  /** Jump to a queue index (not order position) and play it. */
  async playAt(queueIndex: number, autoplay = true): Promise<void> {
    const cursor = this._order().indexOf(queueIndex);
    if (cursor < 0) return;
    this._cursor.set(cursor);
    await this.loadCurrent(autoplay);
  }

  async clear(): Promise<void> {
    this.loadToken++;
    this._queue.set([]);
    this._order.set([]);
    this._cursor.set(-1);
    this._status.set('idle');
    this._position.set(0);
    this._duration.set(0);
    this._error.set(null);
    await this.engine.stop();
  }

  // ---- Transport ---------------------------------------------------------

  async play(): Promise<void> {
    if (this._cursor() < 0) return;
    const status = this._status();
    if (status === 'loading') {
      this.playIntent = true;
      return;
    }
    if (status === 'error' || status === 'idle') {
      await this.loadCurrent(true);
      return;
    }
    if (status === 'ended') await this.engine.seek(0);
    await this.startEngine();
  }

  async pause(): Promise<void> {
    const status = this._status();
    if (status === 'loading') {
      this.playIntent = false;
    } else if (status === 'playing') {
      await this.engine.pause();
      this._status.set('paused');
    }
  }

  async togglePlay(): Promise<void> {
    const status = this._status();
    if (status === 'playing' || (status === 'loading' && this.playIntent)) {
      await this.pause();
    } else await this.play();
  }

  /** Go to the next track. Returns false at the end with repeat off. */
  async next(): Promise<boolean> {
    const target = this.peek(1);
    if (target === -1) return false;
    this._cursor.set(target);
    await this.loadCurrent(true);
    return true;
  }

  /** Restart if more than 3s in, else go back (or restart at the start). */
  async previous(): Promise<void> {
    const target = this.peek(-1);
    if (this._position() > RESTART_THRESHOLD_SEC || target === -1) {
      await this.seek(0);
      return;
    }
    this._cursor.set(target);
    await this.loadCurrent(true);
  }

  async seek(positionSec: number): Promise<void> {
    if (this._cursor() < 0) return;
    const max = this._duration() || Number.POSITIVE_INFINITY;
    const clamped = Math.min(Math.max(0, positionSec), max);
    this._position.set(clamped);
    await this.engine.seek(clamped);
  }

  // ---- Modes ------------------------------------------------------------

  /** Shuffle keeps the current track first and the rest in a stable order. */
  setShuffle(on: boolean): void {
    if (on === this._shuffle()) return;
    this._shuffle.set(on);
    const current = this.currentIndex();
    this.rebuildOrder(current < 0 ? 0 : current);
    if (current < 0) this._cursor.set(-1);
    this.refreshNeighbours();
  }

  toggleShuffle(): void {
    this.setShuffle(!this._shuffle());
  }

  setRepeat(mode: RepeatMode): void {
    this._repeat.set(mode);
    this.refreshNeighbours();
  }

  /** off -> all -> one -> off */
  cycleRepeat(): void {
    const next: Record<RepeatMode, RepeatMode> = {
      off: 'all',
      all: 'one',
      one: 'off',
    };
    this.setRepeat(next[this._repeat()]);
  }

  setSkipOnError(on: boolean): void {
    this._skipOnError.set(on);
  }

  async destroy(): Promise<void> {
    this.loadToken++;
    this.engine.setListener(null);
    await this.engine.destroy();
  }

  // ---- Internals -------------------------------------------------------

  /**
   * Order position `step` away from the cursor, honouring repeat-all wrap.
   * Repeat-one only affects natural track end, not manual next/previous.
   */
  private peek(step: 1 | -1): number {
    const len = this._order().length;
    const cursor = this._cursor();
    if (cursor < 0 || !len) return -1;
    const target = cursor + step;
    if (target >= 0 && target < len) return target;
    if (this._repeat() === 'all') return (target + len) % len;
    return -1;
  }

  private rebuildOrder(currentQueueIndex: number): void {
    const all = this._queue().map((_, i) => i);
    if (!this._shuffle()) {
      this._order.set(all);
      this._cursor.set(currentQueueIndex);
      return;
    }
    const rest = this.shuffled(all.filter((i) => i !== currentQueueIndex));
    this._order.set([currentQueueIndex, ...rest]);
    this._cursor.set(0);
  }

  /** Fisher-Yates with the injected random source. */
  private shuffled(items: number[]): number[] {
    const out = [...items];
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(this.random() * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  }

  private async handleEnded(): Promise<void> {
    if (this._repeat() === 'one') {
      await this.engine.seek(0);
      this._position.set(0);
      await this.startEngine();
      return;
    }
    if (!(await this.next())) {
      this._status.set('ended');
      this._position.set(this._duration());
    }
  }

  /** The native layer already moved to a neighbour: follow it. */
  private async handleSkipped(direction: SkipDirection): Promise<void> {
    const target = this.peek(direction === 'next' ? 1 : -1);
    if (target === -1) return;
    this._cursor.set(target);
    await this.loadCurrent(true);
  }

  /** engine.play(), treating an autoplay block as a plain pause. */
  private async startEngine(): Promise<void> {
    try {
      await this.engine.play();
    } catch (err) {
      if (!(err instanceof PlaybackBlockedError)) throw err;
      this.playIntent = false;
      this._status.set('paused');
    }
  }

  private async loadCurrent(autoplay: boolean): Promise<void> {
    const token = ++this.loadToken;
    const track = this.current();
    if (!track) return;
    this.playIntent = autoplay;
    this._status.set('loading');
    this._error.set(null);
    this._position.set(0);
    this._duration.set(track.durationSec ?? 0);

    let media: EngineMedia;
    try {
      media = await this.toMedia(track);
    } catch (err) {
      await this.fail(
        {
          code: 'resolve',
          message: errorMessage(err, 'Could not find this record.'),
        },
        token,
      );
      return;
    }
    if (token !== this.loadToken) return;

    try {
      const neighbours = this.engine.wantsNeighbours
        ? await this.resolveNeighbours()
        : undefined;
      if (token !== this.loadToken) return;
      await this.engine.load(media, neighbours);
      if (token !== this.loadToken) return;
      if (this.playIntent) await this.startEngine();
      else this._status.set('paused');
    } catch (err) {
      await this.fail(
        { code: 'unknown', message: errorMessage(err, 'Playback failed.') },
        token,
      );
    }
  }

  private async fail(
    err: Omit<PlayerError, 'trackId'>,
    token: number,
  ): Promise<void> {
    if (token !== this.loadToken || token === this.failedToken) return;
    const track = this.current();
    if (!track) return;
    this.failedToken = token;
    this._error.set({ trackId: track.id, ...err });
    this._status.set('error');
    this.failures++;
    if (
      this._skipOnError() &&
      this.failures < this._queue().length &&
      this.peek(1) !== -1
    ) {
      await this.next();
    }
  }

  private async toMedia(track: Track): Promise<EngineMedia> {
    return this.mediaFor(track, await this.resolve(track));
  }

  private async mediaFor(track: Track, source: PlayableSource): Promise<EngineMedia> {
    return {
      id: track.id,
      source,
      title: track.title,
      artist: track.artist,
      artUrl: await this.resolveArt(track),
    };
  }

  /** Cover URL for OS media controls; never throws. */
  async resolveArt(track: Track): Promise<string | undefined> {
    if (track.artUrl || !this.artResolver) return track.artUrl;
    try {
      return await this.artResolver(track);
    } catch {
      return undefined;
    }
  }

  /** Neighbours for native engines; failures just leave a gap. */
  private async resolveNeighbours(): Promise<EngineNeighbours> {
    const at = (cursor: number): Track | undefined =>
      cursor === -1 ? undefined : this._queue()[this._order()[cursor]];
    const safe = async (t?: Track) => {
      if (!t) return undefined;
      try {
        const neighbour = this.neighbourResolver ?? ((x: Track) => this.resolve(x));
        const source = await neighbour(t);
        return source ? await this.mediaFor(t, source) : undefined;
      } catch {
        return undefined;
      }
    };
    // In repeat-one the native player must not auto-advance on track end.
    const next = this._repeat() === 'one' ? undefined : at(this.peek(1));
    const [previous, nextMedia] = await Promise.all([
      safe(at(this.peek(-1))),
      safe(next),
    ]);
    return { previous, next: nextMedia };
  }

  /** Re-send the neighbour window after a mode change (native only). */
  private refreshNeighbours(): void {
    const track = this.current();
    if (!this.engine.wantsNeighbours || !track) return;
    const token = this.loadToken;
    void (async () => {
      try {
        const [media, neighbours] = await Promise.all([
          this.toMedia(track),
          this.resolveNeighbours(),
        ]);
        if (token === this.loadToken) await this.engine.load(media, neighbours);
      } catch {
        // Window refresh is best effort; playback is unaffected.
      }
    })();
  }
}

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}
