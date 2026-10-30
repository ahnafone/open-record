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
import { newEntryId } from '@open-record/models';
import { PlayerService } from '@open-record/player';
import type { PlayerError, RepeatMode, UpcomingEntry } from '@open-record/player';
import { StoragePort } from '@open-record/storage';
import type { QueueState } from '@open-record/storage';
import { LibraryStore } from './library.store';
import { PlayCountsStore } from './play-counts.store';
import { PlaylistsStore } from './playlists.store';
import {
  AUTO_QUEUE_AHEAD,
  QUEUE_HISTORY_KEEP,
  buildQueueWindow,
  restoreQueueWindow,
  type QueueKind,
  type QueueWindow,
} from './queue-window';
import { SessionStore } from './session.store';
import { toSessionTrack } from './session-track';

/** localStorage key for the per-device volume and mute (a convenience, not synced). */
const VOLUME_KEY = 'or.volume';

/** Minimum gap between queue-state writes while playing. */
export const QUEUE_SAVE_INTERVAL_MS = 2000;

export interface PlayOptions {
  /** Start with shuffle on (true) or off (false). Leaves it unchanged if omitted. */
  shuffle?: boolean;
  /** Start playing immediately. Default true. */
  autoplay?: boolean;
  /**
   * How much of `tracks` becomes the queue: `auto` keeps 50 upcoming,
   * `playlist` keeps 100; both extend from the context as playback advances.
   * Default `auto`.
   */
  queue?: 'auto' | 'playlist';
}

/**
 * The bounded queue this client started: the unplayed pool to draw from as
 * the queue drains, its ahead size kind, and the entry ids this client wrote
 * to the shared session (empty for local playback). The ids are never
 * pruned; they identify the queue this client started, so losing all of them
 * means another client replaced it.
 */
interface QueueSource {
  window: QueueWindow;
  kind: QueueKind;
  createdIds: Set<string>;
}

/**
 * Screen-facing facade over the shared session and the local `PlayerService`.
 * Every screen injects this store; it delegates reads and writes to
 * `SessionStore` while a session owns playback, and to the local engine
 * otherwise. It also persists the local queue (including position) so it is
 * restored, paused, on the next launch.
 */
@Injectable({ providedIn: 'root' })
export class PlayerStore {
  private readonly engine = inject(PlayerService).engine;
  private readonly storage = inject(StoragePort);
  private readonly library = inject(LibraryStore);
  private readonly playlists = inject(PlaylistsStore);
  private readonly playCounts = inject(PlayCountsStore);
  private readonly session = inject(SessionStore);
  private readonly document = inject(DOCUMENT, { optional: true });

  readonly queue = computed(() =>
    this.session.mirroring()
      ? this.session.remoteTracks()
      : this.engine.queue(),
  );
  /** Upcoming tracks with queue indices and the "Play next" flag. */
  readonly upcomingEntries = computed<readonly UpcomingEntry[]>(() => {
    if (!this.session.mirroring()) return this.engine.upcomingEntries();
    const next = this.session.remoteCursor() + 1;
    return this.session
      .remoteEntries()
      .slice(next)
      .map((entry, i) => ({
        track: entry.track,
        queueIndex: next + i,
        playNext: false,
      }));
  });
  readonly upcoming = computed(() =>
    this.upcomingEntries().map((entry) => entry.track),
  );
  readonly current = computed(() =>
    this.session.mirroring()
      ? this.session.remoteCurrent()
      : this.engine.current(),
  );
  readonly currentIndex = computed(() =>
    this.session.mirroring()
      ? this.session.remoteCursor()
      : this.engine.currentIndex(),
  );
  /** Session entry for the current row; null while playback is local. */
  readonly currentEntryId = computed<string | null>(() =>
    this.session.ownsPlayback()
      ? (this.session.currentEntryId() ?? null)
      : null,
  );
  readonly status = computed(() =>
    this.session.mirroring()
      ? this.session.remoteStatus()
      : this.engine.status(),
  );
  readonly isPlaying = computed(() =>
    this.session.mirroring()
      ? this.session.remotePlaying()
      : this.engine.isPlaying(),
  );
  /** Last counted play from the engine; `seq` increments once per play. */
  readonly lastPlay = this.engine.lastPlay;
  readonly isLoading = computed(() =>
    this.session.mirroring()
      ? this.session.remoteStatus() === 'loading'
      : this.engine.status() === 'loading',
  );
  readonly position = computed(() =>
    this.session.mirroring()
      ? this.session.remotePosition()
      : this.engine.position(),
  );
  readonly duration = computed(() =>
    this.session.mirroring()
      ? this.session.remoteDuration()
      : this.engine.duration(),
  );
  /** 0..1 for progress bars; 0 when the duration is unknown. */
  readonly progress = computed(() => {
    const duration = this.duration();
    if (duration <= 0) return 0;
    return Math.min(1, Math.max(0, this.position() / duration));
  });
  readonly shuffle = computed(() =>
    this.session.ownsPlayback()
      ? this.session.remoteShuffle()
      : this.engine.shuffle(),
  );
  readonly repeat = computed(() =>
    this.session.ownsPlayback()
      ? this.session.remoteRepeat()
      : this.engine.repeat(),
  );
  readonly error = computed<PlayerError | null>(() => {
    if (this.session.mirroring()) {
      // Screens render `error()?.message`, so the remote banner keeps the
      // local engine error's shape instead of leaking a bare string.
      const message = this.session.remoteError();
      return message ? { trackId: '', code: 'unknown', message } : null;
    }
    const engineError = this.engine.error();
    if (engineError) return engineError;
    const fallback = this.fallbackError();
    return fallback
      ? {
          trackId: '',
          code: 'unknown',
          message: 'Playing on this device only — ' + fallback,
        }
      : null;
  });
  /**
   * A local playback failure the user can retry. Excludes the fallback notice
   * ("Playing on this device only") and a remote/session error, so only a real
   * engine error offers "Try again". Transient failures are surfaced through
   * `retrying()` instead, once the engine gives up.
   */
  readonly playbackError = computed<PlayerError | null>(() => {
    if (this.session.mirroring()) return null;
    return this.engine.error();
  });
  /** The engine is retrying a transient failure (never while mirroring). */
  readonly retrying = computed(() =>
    this.session.mirroring() ? false : this.engine.retrying(),
  );
  readonly hasNext = computed(() =>
    this.session.mirroring()
      ? this.session.remoteCursor() < this.session.remoteTracks().length - 1
      : this.engine.hasNext(),
  );
  readonly hasPrevious = computed(() =>
    this.session.mirroring()
      ? this.session.remoteCursor() > 0
      : this.engine.hasPrevious(),
  );
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
  /** `seq` of the last play handed to the counts store. */
  private seenPlaySeq = 0;
  private lastSaved = '';
  /** Set when a session start failed and playback fell back to this device. */
  private readonly fallbackError = signal<string | null>(null);
  /** The bounded queue this client started, or null while none is active. */
  private readonly queueSource = signal<QueueSource | null>(null);
  /** A top-up is in flight: concurrent effect runs must not enqueue twice. */
  private toppingUp = false;
  /** `loadSeq` of the last load considered for Recently Played. */
  private lastRecordedSeq = 0;

  /**
   * Position at 10 s granularity: the persistence effect's position
   * dependency. A computed only notifies when its output changes, so position
   * ticks wake the effect about once per 10 s instead of every tick.
   */
  private readonly savedPosition = computed(
    () => Math.floor(this.engine.position() / 10) * 10,
  );

  constructor() {
    // Persist whenever queue, current track, modes, status or (coarsely)
    // position change. Reads the signals directly instead of `snapshot()` so
    // a tick neither allocates the id list nor re-runs this effect; `flush()`
    // still saves the exact position (pause, ended and hide are exact too).
    // While a session owns playback the server owns the queue: never write.
    effect(() => {
      if (this.session.ownsPlayback()) return;
      if (!this._restored()) return;
      this.engine.queue();
      this.engine.currentIndex();
      this.engine.playNextIndices();
      this.engine.shuffle();
      this.engine.repeat();
      this.engine.status();
      this.savedPosition();
      untracked(() => this.scheduleSave());
    });

    // Each play the engine counts (90% listened or the track ended) is saved
    // by the counts store, signed in or not. Counts stay engine-driven: the
    // target counts plays, controllers do not.
    effect(() => {
      const play = this.engine.lastPlay();
      if (!play || play.seq === this.seenPlaySeq) return;
      this.seenPlaySeq = play.seq;
      untracked(() =>
        void this.playCounts
          .recordPlay(play.track, play.at)
          .catch(() => undefined),
      );
    });

    // Recently Played: note each track that starts playing here, once per
    // media load. A mirrored load plays on another device, and a paused
    // restore records nothing until playback actually starts.
    effect(() => {
      const seq = this.engine.loadSeq();
      const track = this.engine.current();
      const status = this.engine.status();
      const mirroring = this.session.mirroring();
      if (seq === this.lastRecordedSeq) return;
      // Wait out the load: autoplay reaches `playing` on the same seq.
      if (status === 'loading') return;
      if (mirroring) {
        this.lastRecordedSeq = seq;
        return;
      }
      if (status !== 'playing' || !track) return;
      this.lastRecordedSeq = seq;
      untracked(() =>
        void this.playCounts.recordStart(track).catch(() => undefined),
      );
    });

    // Keep the bounded queue topped up as it drains, pruning history once a
    // window is active. Reads the active mode's queue and cursor only.
    effect(() => {
      if (this.session.ownsPlayback()) {
        this.session.remoteEntries();
        this.session.remoteCursor();
      } else {
        this.engine.currentIndex();
        this.engine.queue();
      }
      untracked(() => void this.topUp());
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

  /** Reactive: whether `trackId` is the gated current track (all copies). */
  isCurrent(trackId: string): boolean {
    return this.current()?.id === trackId;
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
    this.queueSource.set(null);
    this.fallbackError.set(null);
    const kind: QueueKind = opts.queue ?? 'auto';
    const shuffle = opts.shuffle ?? this.shuffle();
    const built = buildQueueWindow(tracks, startIndex, kind, { shuffle });
    this.library.remember(tracks);
    const autoplay = opts.autoplay ?? true;

    // An empty context clears the queue rather than opening a session with
    // no entries; `setQueue([])` is the engine's clear path.
    if (built.cursor < 0) {
      await this.engine.setQueue(built.tracks, { startIndex: 0, autoplay });
      return;
    }

    let fallback: string | null = null;
    if (this.session.available()) {
      // The queue starts on the current session target; this client becomes
      // the target only when none is active or responding. The server owns
      // queue/modes and shuffles its own order, so the engine modes are never
      // touched.
      const ids = await this.session.startSession(built.tracks, built.cursor, {
        shuffle,
        repeat: this.repeat(),
        autoplay,
      });
      if (ids) {
        this.queueSource.set({ window: built.window, kind, createdIds: new Set(ids) });
        this.fallbackError.set(null);
        return;
      }
      // A failed command path (offline, refused, retrying) must never block
      // local playback: `startSession` leaves a non-null error behind.
      fallback = this.session.error();
    }
    this.fallbackError.set(fallback);
    if (opts.shuffle !== undefined) this.engine.setShuffle(shuffle);
    await this.engine.setQueue(built.tracks, {
      startIndex: built.cursor,
      autoplay,
    });
    this.queueSource.set({ window: built.window, kind, createdIds: new Set() });
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
    await this.playTracks(tracks, start, { ...opts, queue: 'playlist' });
  }

  /** Append to the end of the queue; starts playback if the queue was empty. */
  async enqueue(tracks: readonly Track[]): Promise<void> {
    if (!tracks.length) return;
    this.library.remember(tracks);
    if (this.session.ownsPlayback()) {
      await this.enqueueSession(tracks, false);
      return;
    }
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
    if (this.session.ownsPlayback()) {
      await this.enqueueSession(tracks, true);
      return;
    }
    if (!this.engine.queue().length) {
      await this.playTracks(tracks);
      return;
    }
    this.engine.playNext(tracks);
  }

  /** Send an `enqueue` command, remembering the entry ids this client wrote. */
  private async enqueueSession(
    tracks: readonly Track[],
    next: boolean,
  ): Promise<void> {
    const entries = tracks.map((track) => toSessionTrack(track, newEntryId()));
    await this.session.command({ type: 'enqueue', tracks: entries, next });
    const source = this.queueSource();
    if (source) {
      for (const entry of entries) source.createdIds.add(entry.entryId);
    }
  }

  /**
   * Drop an upcoming entry by display index (never the current record). With
   * a session the index resolves to the entry id; the server owns the queue,
   * so a changed queue reports `entry-not-found` and returns false.
   */
  async removeUpcoming(queueIndex: number): Promise<boolean> {
    if (!this.session.ownsPlayback()) {
      return this.engine.removeUpcoming(queueIndex);
    }
    if (!this.session.entryIdAt(queueIndex)) return false;
    const result = await this.session.removeAt(queueIndex);
    return result.ok;
  }

  /** Jump to a queue index (as in `queue()`). */
  async playAt(queueIndex: number): Promise<void> {
    if (this.session.mirroring()) {
      await this.session.command({ type: 'playIndex', index: queueIndex });
      return;
    }
    await this.engine.playAt(queueIndex);
    if (this.session.isTarget()) this.session.report('native-skip');
  }

  // ---- Transport -------------------------------------------------------

  async play(): Promise<void> {
    if (this.session.mirroring()) {
      await this.session.command({ type: 'play' });
      return;
    }
    await this.engine.play();
    if (this.session.isTarget()) this.session.report('playing');
  }

  async pause(): Promise<void> {
    if (this.session.mirroring()) {
      await this.session.command({ type: 'pause' });
      return;
    }
    await this.engine.pause();
    if (this.session.isTarget()) this.session.report('playing');
  }

  async togglePlay(): Promise<void> {
    if (this.session.mirroring()) {
      await this.session.command({ type: 'toggle' });
      return;
    }
    await this.engine.togglePlay();
    if (this.session.isTarget()) this.session.report('playing');
  }

  async next(): Promise<boolean> {
    if (this.session.mirroring()) {
      const result = await this.session.command({ type: 'next' });
      return result.ok;
    }
    const moved = await this.engine.next();
    if (!this.session.isTarget()) return moved;
    if (moved) {
      this.session.report('native-skip');
      return true;
    }
    // The local engine has no next entry; let the server apply repeat-all.
    if (this.session.remoteRepeat() === 'all') {
      const result = await this.session.command({ type: 'next' });
      return result.ok;
    }
    return false;
  }

  async previous(): Promise<void> {
    if (this.session.mirroring()) {
      await this.session.command({ type: 'previous' });
      return;
    }
    const before = this.engine.currentIndex();
    await this.engine.previous();
    if (!this.session.isTarget()) return;
    // Moving back is an entry change; otherwise `previous` restarted the
    // current record, which the server sees as a position tick.
    this.session.report(
      this.engine.currentIndex() !== before ? 'native-skip' : 'tick',
    );
  }

  async seek(positionSec: number): Promise<void> {
    if (this.session.mirroring()) {
      await this.session.command({ type: 'seek', positionSec });
      return;
    }
    await this.engine.seek(positionSec);
    if (this.session.isTarget()) this.session.report('tick');
  }

  /** Seek relative to the current position (clamped by the engine). */
  async seekBy(deltaSec: number): Promise<void> {
    if (this.session.mirroring()) {
      await this.session.command({
        type: 'seek',
        positionSec: this.position() + deltaSec,
      });
      return;
    }
    await this.engine.seek(this.engine.position() + deltaSec);
    if (this.session.isTarget()) this.session.report('tick');
  }

  setVolume(volume: number): void {
    this.engine.setVolume(volume);
    this.saveVolume();
  }

  toggleMute(): void {
    this.engine.toggleMute();
    this.saveVolume();
  }

  async toggleShuffle(): Promise<void> {
    if (this.session.ownsPlayback()) {
      // The remote signal still has the old mode until the server state
      // arrives, so remember the target mode before sending.
      const next = !this.session.remoteShuffle();
      const result = await this.session.command({
        type: 'setShuffle',
        shuffle: next,
      });
      if (result.ok) this.queueSource()?.window.setShuffle(next);
      return;
    }
    this.engine.toggleShuffle();
    this.queueSource()?.window.setShuffle(this.engine.shuffle());
  }

  async setRepeat(mode: RepeatMode): Promise<void> {
    if (this.session.ownsPlayback()) {
      await this.session.command({ type: 'setRepeat', repeat: mode });
      return;
    }
    this.engine.setRepeat(mode);
  }

  async cycleRepeat(): Promise<void> {
    if (this.session.ownsPlayback()) {
      const next: Record<RepeatMode, RepeatMode> = {
        off: 'all',
        all: 'one',
        one: 'off',
      };
      await this.session.command({
        type: 'setRepeat',
        repeat: next[this.session.remoteRepeat()],
      });
      return;
    }
    this.engine.cycleRepeat();
  }

  async clear(): Promise<void> {
    this.queueSource.set(null);
    if (this.session.ownsPlayback()) {
      await this.session.command({ type: 'clear' });
      return;
    }
    await this.engine.clear();
  }

  /**
   * Drop tracks from the queue (e.g. deleted imports). With a session, send a
   * remove per matching entry id and let the server/target apply the state.
   * Otherwise keep the current track and position when it survives; when
   * nothing is left, clear the queue.
   */
  async removeTracks(trackIds: Iterable<string>): Promise<void> {
    const gone = new Set(trackIds);
    if (this.session.ownsPlayback()) {
      const entries = this.session
        .remoteEntries()
        .filter((entry) => gone.has(entry.track.id));
      for (const entry of entries) {
        await this.session.command({ type: 'remove', entryId: entry.entryId });
      }
      return;
    }
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
    if (oldId === next.id) return;
    if (this.session.ownsPlayback()) {
      const entries = this.session.remoteEntries();
      const matches: number[] = [];
      for (let index = 0; index < entries.length; index++) {
        if (entries[index]?.track.id === oldId) matches.push(index);
      }
      if (matches.length) {
        for (const index of matches) {
          await this.session.replaceAt(index, next);
        }
        return;
      }
    }
    // No session entry to replace (or local playback): rebuild locally.
    const queue = this.engine.queue();
    if (!queue.some((t) => t.id === oldId)) return;
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

  // ---- Queue window ----------------------------------------------------

  /**
   * Top the bounded queue up from its window, pruning played history. Guarded
   * so concurrent effect runs cannot enqueue the same tracks twice.
   */
  private async topUp(): Promise<void> {
    const source = this.queueSource();
    if (!source || this.toppingUp) return;
    this.toppingUp = true;
    try {
      if (this.session.ownsPlayback()) await this.topUpSession(source);
      else this.topUpLocal(source);
    } finally {
      this.toppingUp = false;
    }
  }

  private async topUpSession(source: QueueSource): Promise<void> {
    const entries = this.session.remoteEntries();
    const cursor = this.session.remoteCursor();
    if (!entries.length || cursor < 0) return;
    // None of the entry ids this client wrote survive: another client
    // replaced the queue, so this window no longer describes it.
    if (!entries.some((entry) => source.createdIds.has(entry.entryId))) {
      this.queueSource.set(null);
      return;
    }
    const excess = cursor - QUEUE_HISTORY_KEEP;
    if (excess > 0) {
      // Sequential, before the cursor, so ids and indices stay aligned.
      for (const entry of entries.slice(0, excess)) {
        await this.session.command({ type: 'remove', entryId: entry.entryId });
      }
    }
    const upcoming = entries.length - 1 - cursor;
    if (upcoming >= source.window.limit) return;
    const add = source.window.take(source.window.limit - upcoming);
    if (!add.length) return;
    this.library.remember(add);
    const tracks = add.map((track) => toSessionTrack(track, newEntryId()));
    const result = await this.session.command({
      type: 'enqueue',
      tracks,
      next: false,
    });
    if (result.ok) {
      for (const track of tracks) source.createdIds.add(track.entryId);
    }
  }

  private topUpLocal(source: QueueSource): void {
    const cursor = this.engine.currentIndex();
    const queue = this.engine.queue();
    if (cursor < 0 || !queue.length) return;
    const upcoming = queue.length - 1 - cursor;
    if (upcoming < source.window.limit) {
      const add = source.window.take(source.window.limit - upcoming);
      if (add.length) {
        this.library.remember(add);
        this.engine.add(add);
      }
    }
    this.engine.dropPlayed(QUEUE_HISTORY_KEEP);
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

  /** Write the current queue state now. Never while a session owns it. */
  async flush(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (this.session.ownsPlayback()) return;
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
      // Ignore a saved queue if the user already started something or a
      // session already owns playback (the session queue wins).
      if (saved && !this.engine.queue().length && !this.session.ownsPlayback()) {
        await this.apply(saved);
      }
    } catch {
      // A broken saved queue must not block the app.
    } finally {
      this.lastSaved = JSON.stringify(untracked(() => this.snapshot()));
      this._restored.set(true);
    }
  }

  private async apply(saved: QueueState): Promise<void> {
    this.queueSource.set(null);
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
    this.queueSource.set(this.restoreSource(saved));
  }

  /** Rebuild the unplayed pool from a snapshot; no source if any id is gone. */
  private restoreSource(saved: QueueState): QueueSource | null {
    const ids = saved.sourceIds;
    if (!ids?.length) return null;
    const window = restoreQueueWindow(
      ids,
      (id) => this.library.trackMap().get(id),
      {
        limit: saved.sourceLimit ?? AUTO_QUEUE_AHEAD,
        shuffle: saved.shuffle,
      },
    );
    if (!window) return null;
    return { window, kind: saved.sourceKind ?? 'auto', createdIds: new Set() };
  }

  /** The state to persist, with the exact (floored) position. */
  private snapshot(): QueueState {
    const status = this.engine.status();
    const queue = this.engine.queue();
    const playNext = this.engine.playNextIndices();
    const source = this.queueSource();
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
      ...(source && source.window.remaining
        ? {
            sourceIds: source.window.ids(),
            sourceLimit: source.window.limit,
            sourceKind: source.kind,
          }
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
