import {
  DOCUMENT,
  DestroyRef,
  Injectable,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import type { Track } from '@open-record/models';
import { PlayerService } from '@open-record/player';
import type { RepeatMode } from '@open-record/player';
import { StoragePort } from '@open-record/storage';
import type { QueueState } from '@open-record/storage';
import { LibraryStore } from './library.store';
import { PlaylistsStore } from './playlists.store';

/** localStorage key for the per-device volume and mute (a convenience, not synced). */
const VOLUME_KEY = 'or.volume';

/** Minimum gap between queue-state writes while playing. */
export const QUEUE_SAVE_INTERVAL_MS = 2000;

export interface PlayOptions {
  /** Start with shuffle on (true) or off (false). Leaves it unchanged if omitted. */
  shuffle?: boolean;
  /** Start playing immediately. Default true. */
  autoplay?: boolean;
}

/**
 * Screen-facing facade over `PlayerService`. Exposes the engine's signals,
 * starts playback from tracks or playlists, and persists the queue (including
 * position) so it is restored, paused, on the next launch.
 */
@Injectable({ providedIn: 'root' })
export class PlayerStore {
  private readonly engine = inject(PlayerService).engine;
  private readonly storage = inject(StoragePort);
  private readonly library = inject(LibraryStore);
  private readonly playlists = inject(PlaylistsStore);
  private readonly document = inject(DOCUMENT, { optional: true });

  readonly queue = this.engine.queue;
  readonly upcoming = this.engine.upcoming;
  /** Upcoming tracks with queue indices and the "Play next" flag. */
  readonly upcomingEntries = this.engine.upcomingEntries;
  readonly current = this.engine.current;
  readonly currentIndex = this.engine.currentIndex;
  readonly status = this.engine.status;
  readonly isPlaying = this.engine.isPlaying;
  readonly isLoading = computed(() => this.engine.status() === 'loading');
  readonly position = this.engine.position;
  readonly duration = this.engine.duration;
  /** 0..1 for progress bars; 0 when the duration is unknown. */
  readonly progress = computed(() => {
    const d = this.engine.duration();
    return d > 0 ? Math.min(1, Math.max(0, this.engine.position() / d)) : 0;
  });
  readonly shuffle = this.engine.shuffle;
  readonly repeat = this.engine.repeat;
  readonly error = this.engine.error;
  readonly hasNext = this.engine.hasNext;
  readonly hasPrevious = this.engine.hasPrevious;
  /** Output volume 0..1 (independent of mute). */
  readonly volume = this.engine.volume;
  readonly muted = this.engine.muted;
  /** False on native engines, where the OS owns volume. */
  readonly canSetVolume = this.engine.canSetVolume;

  private readonly _restored = signal(false);
  /** True once the saved queue has been restored (or there was none). */
  readonly restored = this._restored.asReadonly();

  private restoring?: Promise<void>;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private lastSaved = '';

  constructor() {
    // Persist whenever queue, current track, modes or position change.
    effect(() => {
      if (!this._restored()) return;
      this.snapshot();
      untracked(() => this.scheduleSave());
    });

    this.restoreVolume();

    const onHidden = () => {
      if (this.document?.visibilityState === 'hidden') void this.flush();
    };
    this.document?.addEventListener('visibilitychange', onHidden);
    inject(DestroyRef).onDestroy(() => {
      this.document?.removeEventListener('visibilitychange', onHidden);
      if (this.saveTimer) clearTimeout(this.saveTimer);
    });
  }

  /** Reactive: whether `trackId` is the loaded track. */
  isCurrent(trackId: string): boolean {
    return this.engine.current()?.id === trackId;
  }

  // ---- Starting playback ----------------------------------------------

  /** Play `track`, using `context` (e.g. the list it was tapped in) as the queue. */
  playTrack(
    track: Track,
    context: readonly Track[] = [track],
    opts: PlayOptions = {},
  ): Promise<void> {
    const index = context.findIndex((t) => t.id === track.id);
    return index < 0
      ? this.playTracks([track], 0, opts)
      : this.playTracks(context, index, opts);
  }

  /** Replace the queue with `tracks` and start at `startIndex`. */
  async playTracks(
    tracks: readonly Track[],
    startIndex = 0,
    opts: PlayOptions = {},
  ): Promise<void> {
    this.library.remember(tracks);
    if (opts.shuffle !== undefined) this.engine.setShuffle(opts.shuffle);
    await this.engine.setQueue(tracks, {
      startIndex,
      autoplay: opts.autoplay ?? true,
    });
  }

  /** Play a playlist from the top (or `startIndex`). No-op for empty playlists. */
  async playPlaylist(
    playlistId: string,
    opts: PlayOptions & { startIndex?: number } = {},
  ): Promise<void> {
    await this.playlists.ready();
    await this.library.ready();
    const tracks = this.playlists.tracksOf(playlistId);
    if (!tracks.length) return;
    const start = opts.shuffle
      ? Math.floor(Math.random() * tracks.length)
      : (opts.startIndex ?? 0);
    await this.playTracks(tracks, start, opts);
  }

  /** Append to the end of the queue; starts playback if the queue was empty. */
  async enqueue(tracks: readonly Track[]): Promise<void> {
    if (!tracks.length) return;
    this.library.remember(tracks);
    if (!this.engine.queue().length) {
      await this.playTracks(tracks);
      return;
    }
    this.engine.add(tracks);
  }

  /**
   * Play `tracks` after the current record, before the rest of the queue
   * (appending to earlier "Play next" picks). Starts playback if the queue
   * was empty.
   */
  async playNext(tracks: readonly Track[]): Promise<void> {
    if (!tracks.length) return;
    this.library.remember(tracks);
    if (!this.engine.queue().length) {
      await this.playTracks(tracks);
      return;
    }
    this.engine.playNext(tracks);
  }

  /** Drop an upcoming entry by queue index (never the current record). */
  removeUpcoming(queueIndex: number): boolean {
    return this.engine.removeUpcoming(queueIndex);
  }

  /** Jump to a queue index (as in `queue()`). */
  playAt(queueIndex: number): Promise<void> {
    return this.engine.playAt(queueIndex);
  }

  // ---- Transport -------------------------------------------------------

  play(): Promise<void> {
    return this.engine.play();
  }
  pause(): Promise<void> {
    return this.engine.pause();
  }
  togglePlay(): Promise<void> {
    return this.engine.togglePlay();
  }
  next(): Promise<boolean> {
    return this.engine.next();
  }
  previous(): Promise<void> {
    return this.engine.previous();
  }
  seek(positionSec: number): Promise<void> {
    return this.engine.seek(positionSec);
  }
  /** Seek relative to the current position (clamped by the engine). */
  seekBy(deltaSec: number): Promise<void> {
    return this.engine.seek(this.engine.position() + deltaSec);
  }
  setVolume(volume: number): void {
    this.engine.setVolume(volume);
    this.saveVolume();
  }
  toggleMute(): void {
    this.engine.toggleMute();
    this.saveVolume();
  }
  toggleShuffle(): void {
    this.engine.toggleShuffle();
  }
  setRepeat(mode: RepeatMode): void {
    this.engine.setRepeat(mode);
  }
  cycleRepeat(): void {
    this.engine.cycleRepeat();
  }
  async clear(): Promise<void> {
    await this.engine.clear();
  }

  /**
   * Drop tracks from the queue (e.g. deleted imports). Keeps the current
   * track and position when it survives; otherwise loads the next survivor
   * paused. Clears the queue when nothing is left.
   */
  async removeTracks(trackIds: Iterable<string>): Promise<void> {
    const gone = new Set(trackIds);
    const queue = this.engine.queue();
    if (!queue.some((t) => gone.has(t.id))) return;
    const remaining = queue.filter((t) => !gone.has(t.id));
    if (!remaining.length) {
      await this.engine.clear();
      return;
    }
    const current = this.engine.current();
    const kept = !!current && !gone.has(current.id);
    const position = this.engine.position();
    const wasPlaying = this.engine.isPlaying();
    const playNextIds = this.engine
      .playNextIndices()
      .map((i) => queue[i].id)
      .filter((id) => !gone.has(id));
    let startIndex = kept ? remaining.findIndex((t) => t.id === current.id) : 0;
    if (!kept) {
      // First survivor after the removed current track, in queue order.
      const after = queue
        .slice(this.engine.currentIndex() + 1)
        .find((t) => !gone.has(t.id));
      startIndex = after ? remaining.indexOf(after) : 0;
    }
    await this.engine.setQueue(remaining, {
      startIndex,
      autoplay: kept && wasPlaying,
    });
    this.restorePlayNext(playNextIds);
    if (kept && position > 0) await this.engine.seek(position);
  }

  /**
   * Swap every queue entry of `oldId` for `next` (its source link changed),
   * keeping order, the current index and "Play next" marks. Playback carries
   * on when the current track is untouched; a replaced current track is
   * reloaded paused at the start.
   */
  async replaceTrack(oldId: string, next: Track): Promise<void> {
    const queue = this.engine.queue();
    if (oldId === next.id || !queue.some((t) => t.id === oldId)) return;
    const current = this.engine.current();
    const replacedCurrent = current?.id === oldId;
    const position = this.engine.position();
    const wasPlaying = this.engine.isPlaying();
    const playNextIds = this.engine
      .playNextIndices()
      .map((i) => (queue[i].id === oldId ? next.id : queue[i].id));
    await this.engine.setQueue(
      queue.map((t) => (t.id === oldId ? next : t)),
      { startIndex: Math.max(0, this.engine.currentIndex()), autoplay: !replacedCurrent && wasPlaying },
    );
    this.restorePlayNext(playNextIds);
    if (!replacedCurrent && position > 0) await this.engine.seek(position);
  }

  /**
   * Re-mark "Play next" entries by id after the queue was rebuilt. Each id
   * claims the first unclaimed match after the current track (then any).
   */
  private restorePlayNext(ids: readonly string[] | undefined): void {
    if (!Array.isArray(ids) || !ids.length) return;
    const queue = this.engine.queue();
    const current = this.engine.currentIndex();
    const claimed = new Set<number>([current]);
    const indices: number[] = [];
    for (const id of ids) {
      const free = (i: number) => queue[i]?.id === id && !claimed.has(i);
      let i = queue.findIndex((_, k) => k > current && free(k));
      if (i < 0) i = queue.findIndex((_, k) => free(k));
      if (i < 0) continue;
      claimed.add(i);
      indices.push(i);
    }
    this.engine.markPlayNext(indices);
  }

  // ---- Persistence -----------------------------------------------------

  private restoreVolume(): void {
    if (!this.engine.canSetVolume) return;
    try {
      const raw = globalThis.localStorage?.getItem(VOLUME_KEY);
      if (!raw) return;
      const saved = JSON.parse(raw) as { volume?: unknown; muted?: unknown };
      if (typeof saved.volume === 'number') this.engine.setVolume(saved.volume);
      if (saved.muted === true) this.engine.setMuted(true);
    } catch {
      // Storage blocked or corrupt: keep full volume.
    }
  }

  private saveVolume(): void {
    try {
      globalThis.localStorage?.setItem(
        VOLUME_KEY,
        JSON.stringify({
          volume: this.engine.volume(),
          muted: this.engine.muted(),
        }),
      );
    } catch {
      // Best effort.
    }
  }

  /**
   * Load the saved queue, paused at the saved position. Safe to call more
   * than once; later calls share the first. Never autoplays and never throws.
   */
  restore(): Promise<void> {
    this.restoring ??= this.doRestore();
    return this.restoring;
  }

  /** Write the current queue state now. */
  async flush(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (!this._restored()) return;
    const state = untracked(() => this.snapshot());
    const key = JSON.stringify(state);
    if (key === this.lastSaved) return;
    try {
      if (state.trackIds.length) await this.storage.queueState.save(state);
      else await this.storage.queueState.clear();
      this.lastSaved = key;
    } catch {
      // Best effort; the next change retries.
    }
  }

  private async doRestore(): Promise<void> {
    try {
      const [saved] = await Promise.all([
        this.storage.queueState.get(),
        this.library.ready(),
      ]);
      // Ignore a saved queue if the user already started something.
      if (saved && !this.engine.queue().length) await this.apply(saved);
    } catch {
      // A broken saved queue must not block the app.
    } finally {
      this.lastSaved = JSON.stringify(untracked(() => this.snapshot()));
      this._restored.set(true);
    }
  }

  private async apply(saved: QueueState): Promise<void> {
    const currentId = saved.trackIds[saved.index];
    const tracks = this.library.resolveIds(saved.trackIds);
    if (!tracks.length) return;
    let index = tracks.findIndex((t) => t.id === currentId);
    const position = index < 0 ? 0 : saved.positionSec;
    if (index < 0) index = 0;

    this.engine.setRepeat(saved.repeat);
    this.engine.setShuffle(saved.shuffle);
    await this.engine.setQueue(tracks, { startIndex: index, autoplay: false });
    this.restorePlayNext(saved.playNextIds);
    if (position > 0 && this.engine.status() === 'paused')
      await this.engine.seek(position);
  }

  /** Reads the persisted signals (tracked when called inside the effect). */
  private snapshot(): QueueState {
    const status = this.engine.status();
    const queue = this.engine.queue();
    const playNext = this.engine.playNextIndices();
    return {
      trackIds: queue.map((t) => t.id),
      index: this.engine.currentIndex(),
      positionSec: status === 'ended' ? 0 : Math.floor(this.engine.position()),
      shuffle: this.engine.shuffle(),
      repeat: this.engine.repeat(),
      // Only when non-empty, so older snapshots compare (and load) unchanged.
      ...(playNext.length
        ? { playNextIds: playNext.map((i) => queue[i].id) }
        : {}),
    };
  }

  /** Throttled: at most one write per interval, always with the latest state. */
  private scheduleSave(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.flush();
    }, QUEUE_SAVE_INTERVAL_MS);
  }
}
