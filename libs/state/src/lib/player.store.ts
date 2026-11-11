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
import type { CommandResult, Track } from '@open-record/models';
import { newEntryId } from '@open-record/models';
import { PlayerService } from '@open-record/player';
import type {
  PlayerError,
  RepeatMode,
  SetQueueOptions,
  StackEntry,
  UpcomingEntry,
} from '@open-record/player';
import { StoragePort } from '@open-record/storage';
import type { JsonValue, QueueState } from '@open-record/storage';
import { LibraryStore } from './library.store';
import { PlayCountsStore } from './play-counts.store';
import { PlaylistsStore } from './playlists.store';
import {
  AUTO_QUEUE_AHEAD,
  QUEUE_HISTORY_KEEP,
  buildQueueWindow,
  isRecentlyQueued,
  parseRecentlyQueued,
  pruneRecentlyQueued,
  restoreQueueWindow,
  type EligibleFn,
  type QueueKind,
  type QueueWindow,
  type RecentlyQueued,
} from './queue-window';
import { SessionStore, isAmbiguousCommandFailure } from './session.store';
import { toSessionTrack } from './session-track';

/** localStorage key for the per-device volume and mute (a convenience, not synced). */
const VOLUME_KEY = 'or.volume';

/**
 * A session refused (or could not take) a Play next / Add to Stack change.
 * `message` is a short sentence the UI shows as its toast. `ambiguous` means
 * the session may still have applied the change, so it must not be retried
 * or re-enqueued by the caller.
 */
export class SessionRefusedError extends Error {
  constructor(
    message: string,
    readonly ambiguous = false,
  ) {
    super(message);
  }
}

/** Short toast text for a refused or failed session command, by its error code. */
function sessionRefusalMessage(error: string | undefined): string {
  if (error === 'offline' || error === 'unavailable' || error === 'unknown-client') {
    return 'Could not queue that record: the playback session is unavailable.';
  }
  if (
    error === 'timeout' ||
    error === 'superseded' ||
    error === 'invalid-response' ||
    error?.startsWith('http-')
  ) {
    return 'Could not queue that record: the playback session did not answer, so it may not have been queued.';
  }
  if (error === 'queue-too-large') {
    return 'Could not queue that record: the session queue is full.';
  }
  return 'Could not queue that record: the session refused the change.';
}

/**
 * Per-device settings key for the recently-queued record (song id -> epoch ms).
 * Lives in local storage only, never synced.
 */
export const RECENTLY_QUEUED_KEY = 'queue.recentlyQueued';

/** Wait before writing the recently-queued record (bursts write once). */
const RECENTLY_QUEUED_SAVE_MS = 1_000;

/** Minimum gap between queue-state writes while playing. */
export const QUEUE_SAVE_INTERVAL_MS = 2000;

/**
 * Pick the queue positions of legacy "Play next" song ids (pre-stack saves,
 * where they were queue entries). Each id claims the first unclaimed match
 * after `current`, else any unclaimed match; the current track is never taken.
 */
export function claimLegacyStack(
  tracks: readonly Track[],
  current: number,
  ids: readonly string[],
): number[] {
  // Returned in `ids` order, which is the stack's play order.
  const claimed: number[] = [];
  const taken = new Set<number>();
  const pick = (id: string) => {
    for (let i = current + 1; i < tracks.length; i++) {
      if (tracks[i].id === id && !taken.has(i)) return i;
    }
    for (let i = 0; i < tracks.length; i++) {
      if (i !== current && tracks[i].id === id && !taken.has(i)) return i;
    }
    return -1;
  };
  for (const id of ids) {
    const at = pick(id);
    if (at >= 0) {
      claimed.push(at);
      taken.add(at);
    }
  }
  return claimed;
}

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
  /** Upcoming tracks with queue indices; Your Stack entries carry their entry id. */
  readonly upcomingEntries = computed<readonly UpcomingEntry[]>(() => {
    if (!this.session.mirroring()) return this.engine.upcomingEntries();
    const next = this.session.remoteCursor() + 1;
    return this.session
      .remoteEntries()
      .slice(next)
      .map((entry, i) => ({
        track: entry.track,
        queueIndex: next + i,
        stackEntryId: null,
      }));
  });
  readonly upcoming = computed(() =>
    this.upcomingEntries().map((entry) => entry.track),
  );
  /** Your Stack: user-added entries, in play order. Empty while a session owns playback. */
  readonly stackEntries = computed<readonly StackEntry[]>(() =>
    this.session.ownsPlayback() ? [] : this.engine.stackEntries(),
  );
  /**
   * This device's Your Stack, ignoring any session. Only the stack sync reads
   * it, and it checks session ownership itself before it writes anything.
   */
  readonly deviceStackEntries = computed<readonly StackEntry[]>(() =>
    this.engine.stackEntries(),
  );
  /** The Keep Spinning window (autoplay), excluding Your Stack entries. */
  readonly keepSpinningEntries = computed<readonly UpcomingEntry[]>(() =>
    this.upcomingEntries().filter((entry) => entry.stackEntryId === null),
  );
  /**
   * True while a session (Cast or another device) owns playback. Add to Stack
   * then appends to the session queue, which is a queue, not Your Stack, so
   * toasts say "added to queue" instead.
   */
  readonly addGoesToQueue = computed(() => this.session.ownsPlayback());
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
    const notice = this.fallbackNotice();
    return notice ? { trackId: '', code: 'unknown', message: notice } : null;
  });
  /**
   * A local playback failure the user can retry. Excludes a remote/session
   * notice, so only a real engine error offers "Try again". Transient failures
   * are surfaced through `retrying()` instead, once the engine gives up.
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
  /** Songs that recently entered a Keep Spinning window (per device). */
  private recentlyQueued: RecentlyQueued = {};
  /** Set once the stored record is merged in; no write happens before that. */
  private recentlyQueuedLoaded = false;
  private recentlyQueuedSaveTimer: ReturnType<typeof setTimeout> | null = null;
  /** Set when the queue started locally because the server refused it. */
  private readonly fallbackNotice = signal<string | null>(null);
  /** The bounded queue this client started, or null while none is active. */
  private readonly queueSource = signal<QueueSource | null>(null);
  /**
   * Bumped by each queue-replacing action (play, clear). An async action only
   * assigns `queueSource` while its generation is still the latest, so a
   * superseded play cannot leave its window behind.
   */
  private queueGeneration = 0;
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
      this.engine.stackEntries();
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

  /**
   * Replace the Keep Spinning queue with `tracks`. Your Stack carries over, as
   * on Spotify: its entries are re-added after the new current track.
   */
  private async replaceEngineQueue(
    tracks: readonly Track[],
    opts: SetQueueOptions,
  ): Promise<void> {
    const keep = this.engine.stackEntries();
    await this.engine.setQueue(tracks, keep.length ? { ...opts, keepStack: keep } : opts);
  }

  /** Replace the queue with `tracks` and start at `startIndex`. */
  async playTracks(
    tracks: readonly Track[],
    startIndex = 0,
    opts: PlayOptions = {},
  ): Promise<void> {
    const generation = ++this.queueGeneration;
    this.queueSource.set(null);
    this.fallbackNotice.set(null);
    const kind: QueueKind = opts.queue ?? 'auto';
    const shuffle = opts.shuffle ?? this.shuffle();
    const now = Date.now();
    // Shuffled fills skip songs queued within 12h. The tapped track is never filtered.
    const built = buildQueueWindow(tracks, startIndex, kind, {
      shuffle,
      eligible: this.autoplayEligible(now, shuffle),
    });
    this.library.remember(tracks);
    // The new window's tracks (tapped one and what follows it) are queued now.
    this.markQueued(built.tracks.slice(Math.max(built.cursor, 0)), now);
    const autoplay = opts.autoplay ?? true;

    // An empty context clears the queue rather than opening a session with
    // no entries; `setQueue([])` is the engine's clear path.
    if (built.cursor < 0) {
      await this.replaceEngineQueue(built.tracks, { startIndex: 0, autoplay });
      return;
    }

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
      // A newer play started while the session call was in flight. Stop here:
      // this superseded play must not set the source, fall back to the engine,
      // or write the engine over the newer queue.
      if (generation !== this.queueGeneration) return;
      if (ids) {
        this.queueSource.set({ window: built.window, kind, createdIds: new Set(ids) });
        this.fallbackNotice.set(null);
        return;
      }
      // A failed command path (offline, refused, retrying) must never block
      // local playback: the queue simply plays here.
      this.fallbackNotice.set(
        this.session.error()
          ? 'Playing on this device — the server could not start synced playback.'
          : null,
      );
    }
    if (opts.shuffle !== undefined) this.engine.setShuffle(shuffle);
    await this.replaceEngineQueue(built.tracks, {
      startIndex: built.cursor,
      autoplay,
      history: 'before-start',
    });
    if (generation === this.queueGeneration) {
      this.queueSource.set({ window: built.window, kind, createdIds: new Set() });
    }
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
    if (this.engine.currentIndex() < 0) {
      await this.playTracks(tracks);
      return;
    }
    this.engine.add(tracks);
  }

  /**
   * Put `track` at the front of Your Stack: it plays next, before the Keep
   * Spinning window. Each call adds a new entry, even for a song already there.
   * While a session owns playback it is enqueued next on the session queue
   * instead. Starts playback when nothing is loaded. Throws
   * `SessionRefusedError` when the session does not apply the change.
   */
  async playNext(track: Track): Promise<void> {
    this.library.remember([track]);
    if (this.session.ownsPlayback()) {
      await this.enqueueSessionOrThrow([track], true);
      return;
    }
    if (this.nothingToStartFrom()) {
      await this.playTracks([track]);
      return;
    }
    this.engine.playNext(track);
    await this.startIfIdle();
  }

  /**
   * Append `track` to the end of Your Stack. Same rules as `playNext`, but the
   * entry plays after the stack entries already queued. While a session owns
   * playback there is no Your Stack: the track is appended to the session's
   * queue (`addGoesToQueue`), after the entries already queued there.
   */
  async addToStack(track: Track): Promise<void> {
    this.library.remember([track]);
    if (this.session.ownsPlayback()) {
      await this.enqueueSessionOrThrow([track], false);
      return;
    }
    if (this.nothingToStartFrom()) {
      await this.playTracks([track]);
      return;
    }
    this.engine.addToStack(track);
    await this.startIfIdle();
  }

  /** Nothing is loaded and Your Stack is empty: a new track must start playback. */
  private nothingToStartFrom(): boolean {
    return this.engine.currentIndex() < 0 && !this.engine.stackEntries().length;
  }

  /** Stack entries added while nothing is loaded start with the first one. */
  private async startIfIdle(): Promise<void> {
    if (this.engine.currentIndex() < 0) await this.engine.startStack();
  }

  /** Remove one Your Stack entry by its entry id. Returns whether it existed. */
  removeStackEntry(entryId: string): boolean {
    // The device's stack is hidden while a session owns playback: leave it be.
    if (this.session.ownsPlayback()) return false;
    return this.engine.removeStackEntry(entryId);
  }

  /** Empty Your Stack. The Keep Spinning window is not touched. */
  clearStack(): void {
    if (this.session.ownsPlayback()) return;
    this.engine.clearStack();
  }

  /**
   * Empty Your Stack even while a session owns playback. Sign-out only: the
   * stack must not outlive the account it was synced with.
   */
  discardStack(): void {
    this.engine.clearStack();
  }

  /**
   * Empty the Keep Spinning window and stop it refilling. Playback stops when
   * the queue (including Your Stack) runs out. A new play action starts a new
   * window, which re-enables autoplay. While a session owns playback, the
   * server's upcoming entries are removed instead.
   */
  async clearKeepSpinning(): Promise<void> {
    this.queueSource.set(null);
    if (!this.session.ownsPlayback()) {
      this.engine.clearKeepSpinning();
      return;
    }
    const cursor = this.session.remoteCursor();
    const upcoming = this.session.remoteEntries().slice(cursor + 1);
    for (const entry of upcoming) {
      const result = await this.session.command({ type: 'remove', entryId: entry.entryId });
      if (!result.ok) {
        // Stop at the first refusal so the caller does not toast success.
        const ambiguous = isAmbiguousCommandFailure(result.error);
        throw new SessionRefusedError(
          ambiguous
            ? 'Could not clear Keep Spinning: the playback session did not answer, so it may be partly cleared.'
            : 'Could not clear Keep Spinning: the playback session refused the change.',
          ambiguous,
        );
      }
    }
  }

  /**
   * Apply a Your Stack replacement from a sync layer (e.g. another device).
   * Replaces every pending stack entry with `entries`, keeping their ids.
   */
  setStackFromRemote(entries: readonly StackEntry[]): void {
    this.engine.setStack(entries);
  }

  /**
   * The 12h dedupe for shuffled autoplay fills. Undefined (no filter) when
   * shuffle is off, so in-order fills follow the list, and on repeat-all.
   */
  private autoplayEligible(now: number, shuffle: boolean): EligibleFn | undefined {
    if (!shuffle || this.repeat() === 'all') return undefined;
    return (track) => !isRecentlyQueued(this.recentlyQueued, track.id, now);
  }

  /** Note songs that just entered a Keep Spinning window; persisted per device. */
  private markQueued(tracks: readonly Track[], now = Date.now()): void {
    if (!tracks.length) return;
    const next = pruneRecentlyQueued(this.recentlyQueued, now);
    for (const track of tracks) next[track.id] = now;
    this.recentlyQueued = next;
    this.saveRecentlyQueued();
  }

  /** Drop expired records; saves only when something expired. */
  private pruneRecent(now: number): void {
    const pruned = pruneRecentlyQueued(this.recentlyQueued, now);
    if (Object.keys(pruned).length === Object.keys(this.recentlyQueued).length) {
      return;
    }
    this.recentlyQueued = pruned;
    this.saveRecentlyQueued();
  }

  private saveRecentlyQueued(): void {
    // Never write before the stored record was merged in (it would replace it).
    if (!this.recentlyQueuedLoaded) return;
    // Debounced: a burst of Keep Spinning fills writes once, with the latest record.
    if (this.recentlyQueuedSaveTimer) clearTimeout(this.recentlyQueuedSaveTimer);
    this.recentlyQueuedSaveTimer = setTimeout(() => {
      this.recentlyQueuedSaveTimer = null;
      void this.storage.settings
        .set(RECENTLY_QUEUED_KEY, { ...this.recentlyQueued })
        .catch(() => undefined);
    }, RECENTLY_QUEUED_SAVE_MS);
  }

  /** Send an `enqueue` command, remembering the entry ids this client wrote. */
  private async enqueueSession(
    tracks: readonly Track[],
    next: boolean,
  ): Promise<CommandResult> {
    const entries = tracks.map((track) => toSessionTrack(track, newEntryId()));
    const result = await this.session.command({ type: 'enqueue', tracks: entries, next });
    const source = this.queueSource();
    if (source) {
      for (const entry of entries) source.createdIds.add(entry.entryId);
    }
    return result;
  }

  /** `enqueueSession` for a user action: a refused change throws, for the toast. */
  private async enqueueSessionOrThrow(
    tracks: readonly Track[],
    next: boolean,
  ): Promise<void> {
    const result = await this.enqueueSession(tracks, next);
    if (!result.ok) {
      throw new SessionRefusedError(
        sessionRefusalMessage(result.error),
        isAmbiguousCommandFailure(result.error),
      );
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
    else void this.session.publishLocal();
  }

  // ---- Transport -------------------------------------------------------

  /**
   * Starting playback of a local-only queue publishes it to the session, so
   * other devices see it (`publishLocal` is a no-op when nothing is playing
   * here or a session target already exists).
   */
  async play(): Promise<void> {
    if (this.session.mirroring()) {
      await this.session.command({ type: 'play' });
      return;
    }
    await this.engine.play();
    if (this.session.isTarget()) this.session.report('playing');
    else void this.session.publishLocal();
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
    else void this.session.publishLocal();
  }

  async next(): Promise<boolean> {
    if (this.session.mirroring()) {
      const result = await this.session.command({ type: 'next' });
      return result.ok;
    }
    const moved = await this.engine.next();
    if (!this.session.isTarget()) {
      void this.session.publishLocal();
      return moved;
    }
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
    if (!this.session.isTarget()) {
      void this.session.publishLocal();
      return;
    }
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
    if (this.session.isTarget()) this.session.reportSeek();
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
    if (this.session.isTarget()) this.session.reportSeek();
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
    this.queueGeneration++;
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
    // Unplayed pool entries too, or topUp would enqueue them again.
    this.queueSource()?.window.remove(gone);
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
    const current = this.engine.current();
    // The engine drops the other copies in place: no reload, position kept.
    if (!current || !gone.has(current.id)) {
      this.engine.removeTracks(gone);
      return;
    }
    // The current track is removed: play the first survivor, paused, the way
    // the queue reads from here (Your Stack first, then Keep Spinning).
    this.engine.removeTracks(gone);
    const survivor =
      this.engine.upcomingEntries()[0]?.queueIndex ??
      this.engine.queue().findIndex((t, i) => i !== this.engine.currentIndex() && !gone.has(t.id));
    if (survivor < 0) {
      await this.engine.clear();
      return;
    }
    await this.engine.playAt(survivor, false);
    this.engine.removeTracks(gone);
  }

  /**
   * Swap every queue entry of `oldId` for `next` (its source link changed),
   * keeping order, the current index and "Play next" marks. Playback carries
   * on when the current track is untouched; a replaced current track is
   * reloaded paused at the start unless `playCurrent` restarts it from zero.
   *
   * With a shared session the queue lives on the server: every captured entry
   * is replaced by its id, then a target asks the server to start the new
   * current entry. Returns whether the current entry was replaced and, when
   * requested, started.
   */
  async replaceTrack(
    oldId: string,
    next: Track,
    opts: { playCurrent?: boolean } = {},
  ): Promise<boolean> {
    if (oldId === next.id) return false;
    // Unplayed pool entries too, or topUp would enqueue the old record again.
    this.queueSource()?.window.replace(oldId, next);
    const playCurrent = opts.playCurrent === true;
    if (this.session.ownsPlayback()) {
      const entries = this.session.remoteEntries();
      const cursor = this.session.remoteCursor();
      const currentEntryId =
        this.session.currentEntryId() ??
        (cursor >= 0 ? entries[cursor]?.entryId : undefined);
      const currentReplaced =
        !!currentEntryId &&
        entries.some(
          (entry) =>
            entry.entryId === currentEntryId && entry.track.id === oldId,
        );
      const matches = entries.filter((entry) => entry.track.id === oldId);
      if (matches.length) {
        let failed = false;
        for (const entry of matches) {
          const result = await this.session.command({
            type: 'replace',
            entryId: entry.entryId,
            track: toSessionTrack(next, entry.entryId),
          });
          if (!result.ok) failed = true;
        }
        if (failed) {
          if (playCurrent) {
            throw new Error('Could not update the playback queue. Try again.');
          }
          return false;
        }
        if (!currentReplaced) return false;
        if (!playCurrent) return true;
        // Only the output device can start a session entry; a controller
        // (mirroring) must leave transport to the target. The server starts
        // the new entry at position zero.
        if (!this.session.isTarget() || !currentEntryId) return false;
        const played = await this.session.command({
          type: 'playEntry',
          entryId: currentEntryId,
        });
        return played.ok;
      }
    }
    // No session entry to replace (or local playback): rebuild locally.
    const queue = this.engine.queue();
    if (!queue.some((t) => t.id === oldId)) return false;
    const current = this.engine.current();
    const replacedCurrent = current?.id === oldId;
    if (!replacedCurrent) {
      // Only upcoming entries change: no reload, no cursor/order movement.
      this.engine.replaceUpcoming(oldId, next);
      return false;
    }
    // Rebuild without Your Stack entries, then re-add them under their ids.
    const replace = (t: Track) => (t.id === oldId ? next : t);
    const { tracks, index } = this.queueSansStack();
    const stack = this.engine
      .stackEntries()
      .map((entry) => ({ entryId: entry.entryId, track: replace(entry.track) }));
    await this.engine.setQueue(tracks.map(replace), {
      startIndex: Math.max(0, index),
      autoplay: playCurrent,
      history: 'before-start',
      ...(stack.length ? { keepStack: stack } : {}),
    });
    return replacedCurrent;
  }

  /**
   * The engine's queue without its Your Stack entries, and the current index
   * within that list. Stack entries are kept apart so a rebuild can re-add
   * them under their own entry ids.
   */
  private queueSansStack(): { tracks: Track[]; index: number } {
    const queue = this.engine.queue();
    const cursor = this.engine.currentIndex();
    const stacked = this.engine
      .upcomingEntries()
      .filter((entry) => entry.stackEntryId !== null)
      .map((entry) => entry.queueIndex);
    const drop = new Set(stacked);
    return {
      tracks: queue.filter((_, i) => !drop.has(i)),
      index: cursor - stacked.filter((i) => i < cursor).length,
    };
  }

  // ---- Queue window ----------------------------------------------------

  /**
   * Top the bounded queue up from its window, pruning played history. Guarded
   * so concurrent effect runs cannot enqueue the same tracks twice.
   */
  private async topUp(): Promise<void> {
    const source = this.queueSource();
    if (!source || this.toppingUp) return;
    const generation = this.queueGeneration;
    const now = Date.now();
    this.pruneRecent(now);
    // The window's shuffle state is the one its draws use; toggling shuffle
    // keeps it in step, so the dedupe follows the mode at top-up time.
    const eligible = this.autoplayEligible(now, source.window.shuffle);
    this.toppingUp = true;
    try {
      if (this.session.ownsPlayback()) {
        await this.topUpSession(source, generation, eligible);
      } else {
        this.topUpLocal(source, eligible);
      }
    } finally {
      this.toppingUp = false;
    }
  }

  private async topUpSession(
    source: QueueSource,
    generation: number,
    eligible: EligibleFn | undefined,
  ): Promise<void> {
    // A newer play or restore replaced the queue (or its source) while this
    // top-up awaited. Its window no longer describes the queue.
    const superseded = () =>
      generation !== this.queueGeneration || this.queueSource() !== source;
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
        if (superseded()) return;
      }
    }
    const upcoming = entries.length - 1 - cursor;
    if (upcoming >= source.window.limit || superseded()) return;
    // Reserve, don't consume: a refused enqueue must not lose these tracks.
    const reserved = source.window.reserve(
      source.window.limit - upcoming,
      eligible,
    );
    const add = reserved.tracks;
    if (!add.length) {
      reserved.commit();
      return;
    }
    this.library.remember(add);
    const tracks = add.map((track) => toSessionTrack(track, newEntryId()));
    const result = await this.session.command({
      type: 'enqueue',
      tracks,
      next: false,
    });
    // A timeout or unavailable result may still have been applied by the
    // server, so those tracks count as sent (releasing them would duplicate
    // them on the next top-up). Only an explicit refusal puts them back.
    const applied = result.ok || isAmbiguousCommandFailure(result.error);
    if (superseded()) {
      // The enqueue landed on a queue that was replaced meanwhile. Take the
      // tracks back out of it, best effort. Removing an absent id is a no-op.
      // Not awaited: the removes address entry ids (not positions) and nothing
      // else waits on them, so `toppingUp` is not held for up to 50 round trips.
      if (applied) {
        void Promise.allSettled(
          tracks.map((track) =>
            this.session.command({ type: 'remove', entryId: track.entryId }),
          ),
        );
      }
      return;
    }
    if (applied) {
      reserved.commit();
      this.markQueued(add);
      for (const track of tracks) source.createdIds.add(track.entryId);
    } else {
      reserved.release();
    }
  }

  private topUpLocal(source: QueueSource, eligible: EligibleFn | undefined): void {
    if (this.engine.currentIndex() < 0) return;
    // Keep Spinning only: Your Stack entries do not count against the window.
    const upcoming = this.engine.keepSpinningEntries().length;
    if (upcoming < source.window.limit) {
      const add = source.window.take(source.window.limit - upcoming, eligible);
      if (add.length) {
        this.library.remember(add);
        this.markQueued(add);
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
      if (state.trackIds.length || state.stack?.length)
        await this.storage.queueState.save(state);
      else await this.storage.queueState.clear();
      this.lastSaved = key;
    } catch {
      // Best effort; the next change retries.
    }
  }

  private async doRestore(): Promise<void> {
    try {
      const started = this.queueGeneration;
      const [saved] = await Promise.all([
        this.storage.queueState.get(),
        this.library.ready(),
        this.loadRecentlyQueued(),
      ]);
      // Ignore a saved queue if the user started or cleared something while it
      // loaded, the engine already has a queue, or a session owns playback
      // (the session queue wins).
      if (
        saved &&
        started === this.queueGeneration &&
        !this.engine.queue().length &&
        !this.session.ownsPlayback()
      ) {
        await this.apply(saved);
      }
    } catch {
      // A broken saved queue must not block the app.
    } finally {
      this.lastSaved = JSON.stringify(untracked(() => this.snapshot()));
      this._restored.set(true);
    }
  }

  /** Merge the stored per-device record (max timestamp wins), then prune it. */
  private async loadRecentlyQueued(): Promise<void> {
    try {
      const stored = parseRecentlyQueued(
        await this.storage.settings.get<JsonValue>(RECENTLY_QUEUED_KEY),
      );
      const merged: RecentlyQueued = { ...stored };
      for (const [id, at] of Object.entries(this.recentlyQueued)) {
        merged[id] = Math.max(at, merged[id] ?? 0);
      }
      this.recentlyQueued = pruneRecentlyQueued(merged, Date.now());
    } catch {
      // Unreadable record: keep what this session queued so far.
    } finally {
      this.recentlyQueuedLoaded = true;
      this.saveRecentlyQueued();
    }
  }

  private async apply(saved: QueueState): Promise<void> {
    this.queueSource.set(null);
    const queueGen = this.queueGeneration;
    const currentId = saved.trackIds[saved.index];
    const resolved = this.library.resolveIds(saved.trackIds);
    if (!resolved.length) {
      // Only Your Stack was saved (nothing loaded): restore it, idle.
      if (saved.stack?.length) {
        this.engine.setStack(
          saved.stack.map((entry) => ({ entryId: entry.entryId, track: entry.track })),
        );
      }
      return;
    }
    let current = resolved.findIndex((t) => t.id === currentId);
    const position = current < 0 ? 0 : saved.positionSec;
    if (current < 0) current = 0;
    // Pre-stack saves kept "Play next" as queue entries: move them out of the
    // queue and into the stack under new entry ids.
    const claimed =
      saved.stack === undefined
        ? claimLegacyStack(resolved, current, saved.playNextIds ?? [])
        : [];
    const drop = new Set(claimed);
    const tracks = resolved.filter((_, i) => !drop.has(i));
    const index = current - claimed.filter((i) => i < current).length;
    const stack: StackEntry[] =
      saved.stack?.map((entry) => ({ entryId: entry.entryId, track: entry.track })) ??
      claimed.map((i) => ({ entryId: newEntryId(), track: resolved[i] }));

    this.engine.setRepeat(saved.repeat);
    this.engine.setShuffle(saved.shuffle);
    // Restoring is one load. If the user starts something else while it is
    // still resolving, the generation moves past that and the old saved
    // position must not seek over the new play.
    const generation = this.engine.loadSeq();
    await this.engine.setQueue(tracks, {
      startIndex: index,
      autoplay: false,
      history: 'before-start',
      ...(stack.length ? { keepStack: stack } : {}),
    });
    const sameLoad = this.engine.loadSeq() === generation + 1;
    if (
      position > 0 &&
      sameLoad &&
      this.engine.current()?.id === tracks[index]?.id &&
      this.engine.status() === 'paused'
    )
      await this.engine.seek(position);
    if (queueGen === this.queueGeneration) {
      this.queueSource.set(this.restoreSource(saved));
    }
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
    const { tracks, index } = this.queueSansStack();
    const stack = this.engine.stackEntries();
    const source = this.queueSource();
    return {
      trackIds: tracks.map((t) => t.id),
      index,
      positionSec: status === 'ended' ? 0 : Math.floor(this.engine.position()),
      shuffle: this.engine.shuffle(),
      repeat: this.engine.repeat(),
      // Only when non-empty, so older snapshots compare (and load) unchanged.
      ...(stack.length
        ? {
            stack: stack.map((entry) => ({
              entryId: entry.entryId,
              track: entry.track,
            })),
          }
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
