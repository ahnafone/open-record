import {
  DOCUMENT,
  DestroyRef,
  Injectable,
  computed,
  effect,
  type Signal,
  inject,
  signal,
  untracked,
} from '@angular/core';
import type { Track } from '@open-record/models';
import { LibraryStore } from './library.store';
import {
  OfflineStore,
  STALLED_MESSAGE,
  WAITING_FOR_WIFI,
  isSavable,
  type OfflineStatus,
} from './offline.store';
import { PlaylistsStore } from './playlists.store';
import { BackgroundWorkHold } from './background-work';
import {
  DownloadWatchdog,
  WATCHDOG_STALL_MS,
  WATCHDOG_STALLED_REASON,
} from './download-watchdog';
import {
  BackgroundWorkPort,
  NetworkStatusPort,
  type NetworkState,
} from './ports';
import { SettingsStore } from './settings.store';

/**
 * Whether background downloads may run on this connection. Offline never;
 * mobile data only when allowed; Wi-Fi, Ethernet and unknown connections
 * (e.g. browsers that cannot tell) always. `null` = no network port: allowed.
 */
export function autoDownloadAllowed(
  state: NetworkState | null,
  allowMobileData: boolean,
): boolean {
  if (!state) return true;
  if (!state.connected || state.connectionType === 'none') return false;
  if (state.connectionType === 'cellular') return allowMobileData;
  return true;
}

export interface AutoDownloadInfo {
  track: Track | undefined;
  status: OfflineStatus | undefined;
  error: string | undefined;
}

/** Systemic failures in a row (server unreachable, 5xx, signed out) that pause auto-download. */
export const MAX_SYSTEMIC_STREAK = 3;
/** First automatic retry after a systemic pause; doubles per pause up to `MAX_PAUSE_RETRY_MS`. */
export const PAUSE_RETRY_MS = 2 * 60_000;
export const MAX_PAUSE_RETRY_MS = 30 * 60_000;

/** How an auto-save ended, for {@link AutoDownloadBreaker}. */
export type AutoSaveOutcome = 'saved' | 'systemic' | 'track';

/**
 * Circuit breaker for the auto-download run. Only systemic failures (the
 * server or network is down, sign-in needed) count toward a quick pause; a
 * track that cannot be downloaded just fails and the run moves on to the
 * next song, however many fail. `reason` is the user-facing pause text,
 * null while running.
 */
export class AutoDownloadBreaker {
  private systemic = 0;
  /** Systemic pauses since the last successful save (drives the retry delay). */
  private pauses = 0;
  reason: string | null = null;

  get paused(): boolean {
    return this.reason !== null;
  }

  /** Record an auto-save outcome; returns true when this pauses the run. */
  record(outcome: AutoSaveOutcome, message?: string): boolean {
    if (outcome === 'saved') {
      this.systemic = this.pauses = 0;
      return false;
    }
    if (outcome === 'track') {
      // The server answered: the path works, only this track failed.
      this.systemic = 0;
      return false;
    }
    this.systemic += 1;
    if (this.systemic < MAX_SYSTEMIC_STREAK || this.paused) return false;
    this.pauses += 1;
    this.reason = `Paused: ${pauseText(message)}`;
    return true;
  }

  /** Delay before retrying by itself after a pause, or null while running. */
  retryDelayMs(): number | null {
    if (!this.paused) return null;
    return Math.min(MAX_PAUSE_RETRY_MS, PAUSE_RETRY_MS * 2 ** (this.pauses - 1));
  }

  /** Pause for `reason` with no retry scheduled (the download watchdog gave up). */
  pauseFor(reason: string): void {
    this.reason = reason;
  }

  /** Clear the streaks and the pause (the retry backoff is kept). */
  reset(): void {
    this.systemic = 0;
    this.reason = null;
  }
}

function pauseText(message: string | undefined): string {
  if (!message) return 'the download server is not responding.';
  return message.charAt(0).toLowerCase() + message.slice(1);
}

/** Failed saves the auto-downloader may try again (not user cancels or Wi-Fi waits). */
function isRetryableFailure(
  status: OfflineStatus | undefined,
  error: string | undefined,
): boolean {
  return (
    status === 'failed' && error !== 'Cancelled.' && error !== WAITING_FOR_WIFI
  );
}

/**
 * The first track id in `wanted` the auto-downloader should save next:
 * savable, not attempted this session, and either never saved or failed for
 * a reason other than a user cancel. Saved, queued and saving tracks are
 * skipped (they are handled by the manual flow).
 */
export function nextAutoDownload(
  wanted: readonly string[],
  info: (trackId: string) => AutoDownloadInfo,
  attempted: ReadonlySet<string>,
): string | undefined {
  for (const id of wanted) {
    if (attempted.has(id)) continue;
    const { track, status, error } = info(id);
    if (!track || !isSavable(track)) continue;
    if (status === undefined) return id;
    if (status === 'failed' && error !== 'Cancelled.') return id;
  }
  return undefined;
}

/**
 * Whether a download progress bar for a set of tracks stays up. True while
 * anything in the set is queued or saving, and also between two auto-saves of
 * one run: the finished song is already saved and the next is not queued yet.
 * `runTrackInSet` is whether the run's current track is in the set; `pending`
 * counts wanted tracks in the set that the run has yet to attempt. False once
 * the run has ended or paused.
 */
export function isDownloadSessionActive(input: {
  downloading: number;
  runActive: boolean;
  runTrackInSet: boolean;
  pending: number;
}): boolean {
  if (input.downloading > 0) return true;
  return input.runActive && (input.runTrackInSet || input.pending > 0);
}

/** Live download state for a set of tracks (see `AutoDownloadStore.progressFor`). */
export interface DownloadProgress {
  /** Tracks that are, or can be, kept on the device. */
  total: number;
  /** Already on the device. */
  saved: number;
  /** Queued or saving right now. */
  downloading: number;
  failed: number;
  /** 0-1: saved plus the partial progress of running saves, over `total`. */
  fraction: number;
  /**
   * A download session is running for the set (see `DownloadCounts.active`):
   * show the progress; hide when false.
   */
  active: boolean;
}

/** Status counts behind `DownloadProgress` (see `AutoDownloadStore.countsFor`). */
export interface DownloadCounts {
  total: number;
  saved: number;
  downloading: number;
  failed: number;
  /**
   * A download session is running for the set: something is queued or saving,
   * or an auto-download run is in progress with tracks in the set left to go.
   * Stays true between one song and the next, so a progress bar keyed on it
   * does not unmount mid-session.
   */
  active: boolean;
  /** `ids` as a set. */
  set: ReadonlySet<string>;
}

/**
 * Keeps bookmarked library tracks (when the Library switch is on) and tracks
 * of playlists with auto-download on saved on the device. Saves run one at a
 * time through `OfflineStore`, only while the connection allows it
 * (`autoDownloadAllowed`); a running auto-save is paused (failed with
 * `WAITING_FOR_WIFI`) when it stops being allowed and resumes later. Each
 * track is tried once per session, so failures never loop; a track that
 * cannot be downloaded is skipped, while a run of systemic failures (server
 * unreachable, 5xx, signed out) pauses the run (`pauseReason`) and retries it
 * later. Failed tracks are tried again when a switch is turned on, the
 * network changes, or the user asks (`retryFailed`). A busy or rate-limited
 * server is not a failure: `OfflineStore` keeps the save queued and backs off
 * (`busyUntil`), so the next track waits for it.
 */
@Injectable({ providedIn: 'root' })
export class AutoDownloadStore {
  private readonly settings = inject(SettingsStore);
  private readonly library = inject(LibraryStore);
  private readonly playlists = inject(PlaylistsStore);
  private readonly offline = inject(OfflineStore);
  private readonly network = inject(NetworkStatusPort, { optional: true });
  private readonly backgroundWork = inject(BackgroundWorkPort, {
    optional: true,
  });

  private readonly _started = signal(false);
  private readonly _network = signal<NetworkState | null>(null);
  /** An `ensureSaved` call is still writing its record. */
  private readonly _starting = signal(false);
  private readonly attempted = new Set<string>();
  /** Bumped on every change to `attempted`, so reads of it stay reactive. */
  private readonly _attempts = signal(0);
  /** The auto-save in progress (queued or saving in OfflineStore). */
  private active: string | null = null;
  /**
   * Mirrors `active` for the background-work hold. Only written by the run
   * effect (never read there), so it stays set between one auto-save ending
   * and the next one being queued and the hold does not flap.
   */
  private readonly _activeId = signal<string | null>(null);
  /** Stops the run on a streak of failures so it cannot hammer the server. */
  private readonly breaker = new AutoDownloadBreaker();
  private readonly _pauseReason = signal<string | null>(null);
  /** Bumped to re-run the download loop after a reset. */
  private readonly _kick = signal(0);
  /** The current pause came from stalled saves (the watchdog may lift it). */
  private readonly _stallPaused = signal(false);
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private unsubscribe?: () => void;
  /** Keeps the foreground hold in step with `downloadsLeft`. */
  private hold: BackgroundWorkHold | undefined;
  /**
   * Notices downloads that stopped moving (screen off, throttled JS) and
   * restarts them. Only runs while downloads are wanted.
   */
  private readonly watchdog = new DownloadWatchdog({
    wanted: () => this.stallWatchWanted(),
    marker: () => this.progressMarker(),
    completed: () => this.offline.finishedCount(),
    restart: () => this.restartStalled(),
    giveUp: () => this.giveUpStalled(),
  });

  /** Why auto-download is paused (e.g. server unreachable), or null while it runs. */
  readonly pauseReason = this._pauseReason.asReadonly();

  /** The connection allows auto-downloads right now. */
  readonly allowed = computed(() =>
    autoDownloadAllowed(
      this._network(),
      this.settings.autoDownloadOnMobileData(),
    ),
  );

  /** Track ids that should be kept on the device, in priority order. */
  readonly wanted = computed<readonly string[]>(() => {
    const ids = new Set<string>();
    if (this.settings.autoDownloadLibrary())
      for (const id of this.library.savedIds()) ids.add(id);
    for (const p of this.playlists.playlists())
      if (p.autoDownload) for (const id of p.trackIds) ids.add(id);
    return [...ids];
  });

  /** Download progress across everything auto-download keeps on the device. */
  readonly progress = computed(() => this.progressFor(this.wanted()));

  /**
   * Reactive: download progress for `ids` (e.g. a playlist's tracks), from
   * the offline states in `OfflineStore`. Tracks that cannot be saved and
   * have no stored copy are left out.
   */
  progressFor(ids: readonly string[]): DownloadProgress {
    const { total, saved, downloading, failed, active, set } = this.countsFor(ids);
    // Only this part follows progress ticks, and it is O(live saves).
    const partial = downloading ? this.offline.liveProgressOf(set) : 0;
    return {
      total,
      saved,
      downloading,
      failed,
      fraction: total ? Math.min(1, (saved + partial) / total) : 0,
      active,
    };
  }

  /**
   * Reactive: the status counts behind `progressFor(ids)`. Memoized per id
   * array (store arrays such as `savedIds()` and `trackIds` are replaced, not
   * mutated); unlike `progressFor`, it changes only on status transitions,
   * never on progress ticks.
   */
  countsFor(ids: readonly string[]): DownloadCounts {
    return this.countsSignal(ids)();
  }

  private readonly counts = new WeakMap<readonly string[], Signal<DownloadCounts>>();

  private countsSignal(ids: readonly string[]): Signal<DownloadCounts> {
    let counts = this.counts.get(ids);
    if (!counts) {
      counts = computed(() => {
        // `attempted` is read through this version so 'pending' follows it.
        this._attempts();
        const set = new Set(ids);
        // Read only while a run is going: the wanted tracks it still has to attempt.
        const runId = this._activeId();
        const wanted = runId !== null ? new Set(this.wanted()) : null;
        let total = 0;
        let saved = 0;
        let downloading = 0;
        let failed = 0;
        let pending = 0;
        for (const id of set) {
          const status = this.offline.status(id);
          if (status === undefined) {
            const track = this.library.track(id);
            if (!track || !isSavable(track)) continue;
            if (wanted?.has(id) && !this.attempted.has(id)) pending += 1;
          }
          total += 1;
          if (status === 'saved') saved += 1;
          else if (status === 'failed') failed += 1;
          else if (status === 'queued' || status === 'saving') downloading += 1;
        }
        const active = isDownloadSessionActive({
          downloading,
          runActive: runId !== null,
          runTrackInSet: runId !== null && set.has(runId),
          pending,
        });
        return { total, saved, downloading, failed, active, set };
      });
      this.counts.set(ids, counts);
    }
    return counts;
  }

  /**
   * Downloads still to go while something is downloading (manual saves or an
   * auto-download run), else 0. Drives the background-work hold.
   */
  readonly downloadsLeft = computed(() => {
    const pending = this.offline.pendingCount();
    const autoRunning = this._activeId() !== null;
    if (!pending && !autoRunning) return 0;
    let left = pending;
    if (autoRunning) {
      const p = this.progress();
      left = Math.max(left, p.total - p.saved - p.failed);
    }
    return Math.max(1, left);
  });

  /** Reactive: tracks among `ids` whose save failed and can be retried. */
  failedCount(ids: readonly string[]): number {
    let n = 0;
    for (const id of new Set(ids))
      if (isRetryableFailure(this.offline.status(id), this.offline.error(id)))
        n += 1;
    return n;
  }

  /**
   * Reactive: the line to show under an auto-download switch for `ids`:
   * the pause reason, else how many songs could not be downloaded, else ''.
   */
  noticeFor(ids: readonly string[]): string {
    const paused = this._pauseReason();
    if (paused) return paused;
    const n = this.failedCount(ids);
    return n ? `${n} song${n === 1 ? '' : 's'} could not be downloaded.` : '';
  }

  /** Something to retry: the run is paused or tracks it wants have failed. */
  readonly canRetry = computed(
    () => this._pauseReason() !== null || this.failedCount(this.wanted()) > 0,
  );

  /**
   * Try failed tracks again and lift a pause (Settings "Retry failed
   * downloads", and a switch turned on). A user retry re-arms the download
   * watchdog: its restart cap starts fresh.
   */
  retryFailed(): void {
    this.watchdog.rearm();
    this.resume();
  }

  /**
   * Try failed tracks again and lift the pause, without resetting the
   * watchdog's restart cap (network change, retry timer, watchdog restart).
   */
  private resume(): void {
    for (const id of [...this.attempted]) {
      if (id === this.active) continue;
      if (isRetryableFailure(this.offline.status(id), this.offline.error(id)))
        this.forgetAttempt(id);
    }
    clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    this.breaker.reset();
    this._pauseReason.set(null);
    this._stallPaused.set(false);
    this.watchdog.reenable();
    this._kick.update((n) => n + 1);
  }

  /** Let a track be tried again by the run. */
  private forgetAttempt(trackId: string): void {
    this.attempted.delete(trackId);
    this._attempts.update((n) => n + 1);
  }

  /**
   * The app came back to the foreground (Capacitor `resume`, or the page
   * becoming visible): judge download progress soon, and restart if it stalled.
   */
  onResume(): void {
    this.watchdog.resumed();
  }

  /** Auto-downloads are on somewhere but paused by the connection. */
  readonly waitingForWifi = computed(
    () => this.wanted().length > 0 && !this.allowed(),
  );

  constructor() {
    effect(() => {
      this._kick();
      if (!this._started() || this._starting()) return;
      if (
        this.library.status() !== 'ready' ||
        this.playlists.status() !== 'ready'
      )
        return;
      const allowed = this.allowed();
      const wanted = this.wanted();
      const active = this.active;
      if (active) {
        const status = this.offline.status(active);
        if (status === 'queued' || status === 'saving') {
          if (!allowed) untracked(() => this.offline.defer(active));
          else return;
        }
        if (!allowed) this.forgetAttempt(active);
        else if (status === 'saved') this.breaker.record('saved');
        else if (status === 'failed') {
          const error = this.offline.error(active);
          if (isRetryableFailure(status, error)) {
            const kind = this.offline.failureKind(active) ?? 'track';
            if (this.breaker.record(kind, error)) {
              this._stallPaused.set(error === STALLED_MESSAGE);
              untracked(() => this.onPaused());
            }
          }
        }
        this.active = null;
        this._activeId.set(null);
      }
      if (!allowed || this.breaker.paused) return;
      const next = nextAutoDownload(
        wanted,
        (id) => ({
          track:
            this.library.storedRecord(id)?.track ?? this.library.track(id),
          status: this.offline.status(id),
          error: this.offline.error(id),
        }),
        this.attempted,
      );
      if (next) untracked(() => this.begin(next));
    });

    // Turning a switch on (Library or a playlist) retries failed tracks.
    let switches: ReadonlySet<string> | null = null;
    effect(() => {
      if (!this._started()) return;
      const on = new Set<string>();
      if (this.settings.autoDownloadLibrary()) on.add('library');
      for (const p of this.playlists.playlists())
        if (p.autoDownload) on.add(p.id);
      const before = switches;
      switches = on;
      if (before && [...on].some((k) => !before.has(k)))
        untracked(() => this.retryFailed());
    });

    // Keep downloading with the screen off (Android foreground service):
    // held while anything downloads, released when idle or paused.
    const backgroundWork = this.backgroundWork;
    if (backgroundWork) {
      this.hold = new BackgroundWorkHold(backgroundWork);
      effect(() => this.hold?.sync(this.downloadsLeft()));
    }

    // The watchdog runs only while downloads are wanted (see `stallWatchWanted`).
    effect(() => {
      const wanted = this.stallWatchWanted();
      untracked(() => (wanted ? this.watchdog.start() : this.watchdog.stop()));
    });

    // Foreground again (the page became visible): judge progress soon.
    const doc = inject(DOCUMENT);
    const onVisible = () => {
      if (doc.visibilityState === 'visible') this.onResume();
    };
    doc.addEventListener('visibilitychange', onVisible);

    inject(DestroyRef).onDestroy(() => {
      clearTimeout(this.retryTimer);
      this.watchdog.stop();
      doc.removeEventListener('visibilitychange', onVisible);
      this.unsubscribe?.();
      this.hold?.sync(0);
    });
  }

  /**
   * Whether the download watchdog should run: downloads are wanted and the
   * connection allows them now, not busy-backed-off, and the run is either
   * working or paused by stalled saves (the watchdog's own pause).
   */
  private stallWatchWanted(): boolean {
    return (
      this._started() &&
      this.wanted().length > 0 &&
      this.allowed() &&
      this.offline.busyUntil() === null &&
      (this.downloadsLeft() > 0 || this._stallPaused())
    );
  }

  /**
   * Activity marker for the watchdog: the saved count and the progress ticks
   * received. Null when no running save has reported progress (nothing to judge).
   */
  private progressMarker(): string | null {
    if (!this.offline.hasLiveProgress()) return null;
    return `${this.progress().saved}/${this.offline.progressCount()}`;
  }

  /** Watchdog restart: abort the silent saves, lift the pause, kick the run, re-assert the hold. */
  private restartStalled(): void {
    // Only saves that reported progress and went silent are abandoned.
    const abandoned = this.offline.abandonStalled(WATCHDOG_STALL_MS);
    // Abandoned tracks are retried, not treated as attempted (their failure lands later).
    for (const id of abandoned) this.forgetAttempt(id);
    this.resume();
    // Stop then start: the native foreground service is re-asserted even if JS thought it was held.
    this.hold?.sync(0);
    this.hold?.sync(this.downloadsLeft());
  }

  /** Watchdog gave up after repeated restarts without progress: stop, abandon the silent saves, and say so. */
  private giveUpStalled(): void {
    clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    this.breaker.pauseFor(WATCHDOG_STALLED_REASON);
    this._stallPaused.set(true);
    this._pauseReason.set(WATCHDOG_STALLED_REASON);
    this.offline.abandonStalled(WATCHDOG_STALL_MS);
  }

  /** Start watching the connection and the wanted tracks. Safe to call twice. */
  async start(): Promise<void> {
    if (this._started()) return;
    if (this.network) {
      this.unsubscribe = this.network.onChange((s) => {
        const before = this._network();
        this._network.set(s);
        // Back online or on another network: failed tracks get another go.
        if (
          before &&
          s.connected &&
          (!before.connected || before.connectionType !== s.connectionType)
        )
          untracked(() => this.resume());
      });
      try {
        this._network.set(await this.network.current());
      } catch {
        // Unknown connection: treat as allowed (same as without a port).
      }
    }
    await Promise.all([
      this.settings.ready(),
      this.library.ready(),
      this.playlists.ready(),
    ]);
    this._started.set(true);
  }

  /** Show the pause and, for a systemic one, retry by itself later. */
  private onPaused(): void {
    this._pauseReason.set(this.breaker.reason);
    const delay = this.breaker.retryDelayMs();
    clearTimeout(this.retryTimer);
    this.retryTimer =
      delay === null ? undefined : setTimeout(() => this.resume(), delay);
  }

  private begin(trackId: string): void {
    const track =
      this.library.storedRecord(trackId)?.track ?? this.library.track(trackId);
    if (!track) return;
    this.attempted.add(trackId);
    this._attempts.update((n) => n + 1);
    this.active = trackId;
    this._activeId.set(trackId);
    this._starting.set(true);
    void this.offline
      .ensureSaved(track)
      .catch(() => {
        // Storage failure: leave it for the next session.
        if (this.active === trackId) {
          this.active = null;
          this._activeId.set(null);
        }
      })
      .finally(() => this._starting.set(false));
  }
}
