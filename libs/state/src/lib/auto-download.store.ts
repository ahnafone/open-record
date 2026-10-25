import {
  DestroyRef,
  Injectable,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import type { Track } from '@open-record/models';
import { LibraryStore } from './library.store';
import {
  OfflineStore,
  isSavable,
  type OfflineStatus,
} from './offline.store';
import { PlaylistsStore } from './playlists.store';
import { NetworkStatusPort, type NetworkState } from './ports';
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
 * Keeps bookmarked library tracks (when the Library switch is on) and tracks
 * of playlists with auto-download on saved on the device. Saves run one at a
 * time through `OfflineStore`, only while the connection allows it
 * (`autoDownloadAllowed`); a running auto-save is paused (failed with
 * `WAITING_FOR_WIFI`) when it stops being allowed and resumes later. Each
 * track is tried at most once per session, so failures never loop.
 */
@Injectable({ providedIn: 'root' })
export class AutoDownloadStore {
  private readonly settings = inject(SettingsStore);
  private readonly library = inject(LibraryStore);
  private readonly playlists = inject(PlaylistsStore);
  private readonly offline = inject(OfflineStore);
  private readonly network = inject(NetworkStatusPort, { optional: true });

  private readonly _started = signal(false);
  private readonly _network = signal<NetworkState | null>(null);
  /** An `ensureSaved` call is still writing its record. */
  private readonly _starting = signal(false);
  private readonly attempted = new Set<string>();
  /** The auto-save in progress (queued or saving in OfflineStore). */
  private active: string | null = null;
  private unsubscribe?: () => void;

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

  /** Auto-downloads are on somewhere but paused by the connection. */
  readonly waitingForWifi = computed(
    () => this.wanted().length > 0 && !this.allowed(),
  );

  constructor() {
    effect(() => {
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
        this.active = null;
      }
      if (!allowed) return;
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

    inject(DestroyRef).onDestroy(() => this.unsubscribe?.());
  }

  /** Start watching the connection and the wanted tracks. Safe to call twice. */
  async start(): Promise<void> {
    if (this._started()) return;
    if (this.network) {
      this.unsubscribe = this.network.onChange((s) => this._network.set(s));
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

  private begin(trackId: string): void {
    const track =
      this.library.storedRecord(trackId)?.track ?? this.library.track(trackId);
    if (!track) return;
    this.attempted.add(trackId);
    this.active = trackId;
    this._starting.set(true);
    void this.offline
      .ensureSaved(track)
      .catch(() => {
        // Storage failure: leave it for the next session.
        if (this.active === trackId) this.active = null;
      })
      .finally(() => this._starting.set(false));
  }
}
