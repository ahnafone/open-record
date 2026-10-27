import {
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
  WAITING_FOR_WIFI,
  isSavable,
  type OfflineStatus,
} from './offline.store';
import { PlaylistsStore } from './playlists.store';
import { BackgroundWorkHold } from './background-work';
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
  /** Something is downloading (show the progress; hide when false). */
  active: boolean;
}

/** Status counts behind `DownloadProgress` (see `AutoDownloadStore.countsFor`). */
export interface DownloadCounts {
  total: number;
  saved: number;
  downloading: number;
  failed: number;
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
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private unsubscribe?: () => void;

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
    const { total, saved, downloading, failed, set } = this.countsFor(ids);
    // Only this part follows progress ticks, and it is O(live saves).
    const partial = downloading ? this.offline.liveProgressOf(set) : 0;
    return {
      total,
      saved,
      downloading,
      failed,
      fraction: total ? Math.min(1, (saved + partial) / total) : 0,
      active: downloading > 0,
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
        const set = new Set(ids);
        let total = 0;
        let saved = 0;
        let downloading = 0;
        let failed = 0;
        for (const id of set) {
          const status = this.offline.status(id);
          if (status === undefined) {
            const track = this.library.track(id);
            if (!track || !isSavable(track)) continue;
          }
          total += 1;
          if (status === 'saved') saved += 1;
          else if (status === 'failed') failed += 1;
          else if (status === 'queued' || status === 'saving') downloading += 1;
        }
        return { total, saved, downloading, failed, set };
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
   * downloads"; also run when a switch turns on or the network changes).
   */
  retryFailed(): void {
    for (const id of [...this.attempted]) {
      if (id === this.active) continue;
      if (isRetryableFailure(this.offline.status(id), this.offline.error(id)))
        this.attempted.delete(id);
    }
    clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    this.breaker.reset();
    this._pauseReason.set(null);
    this._kick.update((n) => n + 1);
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
        if (!allowed) this.attempted.delete(active);
        else if (status === 'saved') this.breaker.record('saved');
        else if (status === 'failed') {
          const error = this.offline.error(active);
          if (isRetryableFailure(status, error)) {
            const kind = this.offline.failureKind(active) ?? 'track';
            if (this.breaker.record(kind, error))
              untracked(() => this.onPaused());
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
    let hold: BackgroundWorkHold | undefined;
    if (backgroundWork) {
      hold = new BackgroundWorkHold(backgroundWork);
      effect(() => hold?.sync(this.downloadsLeft()));
    }

    inject(DestroyRef).onDestroy(() => {
      clearTimeout(this.retryTimer);
      this.unsubscribe?.();
      hold?.sync(0);
    });
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
          this.retryFailed();
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
      delay === null ? undefined : setTimeout(() => this.retryFailed(), delay);
  }

  private begin(trackId: string): void {
    const track =
      this.library.storedRecord(trackId)?.track ?? this.library.track(trackId);
    if (!track) return;
    this.attempted.add(trackId);
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
