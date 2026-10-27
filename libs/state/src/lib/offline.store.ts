import { Injectable, Injector, computed, inject, signal } from '@angular/core';
import { lookupMetadata, type MetadataFetch } from '@open-record/metadata-lookup';
import type { DownloadLocation, Track } from '@open-record/models';
import { type ImportedTrack } from '@open-record/storage';
import { LOCAL_PROVIDER_ID, LibraryStore } from './library.store';
import { PlaylistsStore } from './playlists.store';
import { DeviceStoragePort, LocalMediaPort, METADATA_FETCH, StreamResolverPort } from './ports';
import {
  busyRetryAfterSec,
  failureKind,
  isAbort,
  isBusy,
  remoteErrorMessage,
} from './remote-errors';
import { SettingsStore } from './settings.store';

/** Saves that download at once. */
export const OFFLINE_CONCURRENCY = 2;

/** Wait when the server is busy / rate limited without a Retry-After hint. */
export const BUSY_WAIT_MS = 20_000;
/** Longest wait after a busy / rate-limited reply, whatever the hint says. */
export const MAX_BUSY_WAIT_MS = 60_000;

/**
 * Failure text of an auto-download paused because the connection does not
 * allow it. Such records are left to the auto-downloader (not retried at launch).
 */
export const WAITING_FOR_WIFI = 'Waiting for Wi-Fi.';

/**
 * Progress ticks are coalesced and published at most this often (all tracks
 * together), so lists that read download state do not re-render per tick.
 */
export const PROGRESS_INTERVAL_MS = 250;

/** What the UI shows for a remote track's offline copy. */
export type OfflineStatus = 'queued' | 'saving' | 'saved' | 'failed';

type LiveStatus = 'queued' | 'saving';

/**
 * Keeps device copies of remote tracks. A track keeps one id (`remote:<url>`)
 * for its whole life; its stored record (`ImportedTrack`) moves
 * `saving` -> `saved` (or `failed`, retryable). Saves run `OFFLINE_CONCURRENCY`
 * at a time. Files are only kept while the track is bookmarked or in a
 * playlist: `reconcile()` deletes the rest. Local `local:` imports are never
 * touched here.
 *
 * Needs `StreamResolverPort` to save (without it saves fail with a message).
 * `METADATA_FETCH` is optional; without it no metadata lookup runs.
 */
@Injectable({ providedIn: 'root' })
export class OfflineStore {
  private readonly library = inject(LibraryStore);
  private readonly resolver = inject(StreamResolverPort, { optional: true });
  private readonly media = inject(LocalMediaPort, { optional: true });
  private readonly metadataFetch = inject(METADATA_FETCH, { optional: true });
  private readonly settings = inject(SettingsStore);
  private readonly device = inject(DeviceStoragePort, { optional: true });
  // PlaylistsStore injects this store: resolve it lazily.
  private readonly injector = inject(Injector);

  /**
   * Live saves by track id. Changes only on status transitions (queued,
   * saving, done), never on progress ticks, so `status()` reads stay quiet.
   */
  private readonly _jobs = signal<ReadonlyMap<string, LiveStatus>>(new Map());
  /** 0-1 progress of running saves, published at most every `PROGRESS_INTERVAL_MS`. */
  private readonly _progress = signal<ReadonlyMap<string, number>>(new Map());
  /** Progress ticks not yet published to `_progress`. */
  private readonly pendingProgress = new Map<string, number>();
  private progressTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly queue: string[] = [];
  private readonly running = new Map<string, AbortController>();
  private readonly _busyUntil = signal<number | null>(null);
  private busyTimer: ReturnType<typeof setTimeout> | undefined;
  /** Why the last save of a track failed this session (see `failureKind`). */
  private readonly failKinds = new Map<string, 'systemic' | 'track'>();

  /**
   * Epoch ms until which no save starts because the server said it is busy or
   * rate limited (HTTP 503/429), or null. Saves that hit it stay queued.
   */
  readonly busyUntil = this._busyUntil.asReadonly();

  /** Tracks queued or saving right now. */
  readonly pendingCount = computed(() => this._jobs().size);

  /** The chosen location when this device supports it, else app data. */
  private downloadLocation(): DownloadLocation {
    const chosen = this.settings.downloadLocation();
    return this.device?.locations.includes(chosen) ? chosen : 'data';
  }

  /** Reactive: the offline state of a track, or undefined when it has no record. */
  status(trackId: string): OfflineStatus | undefined {
    const job = this._jobs().get(trackId);
    if (job) return job;
    const record = this.library.storedRecord(trackId);
    if (!record) return undefined;
    switch (record.status ?? 'saved') {
      case 'saving':
        return 'queued';
      case 'failed':
        return 'failed';
      default:
        return 'saved';
    }
  }

  /** Reactive: 0-1 progress of the save (1 once saved, 0 otherwise). */
  progress(trackId: string): number {
    if (this._jobs().has(trackId)) return this._progress().get(trackId) ?? 0;
    return this.status(trackId) === 'saved' ? 1 : 0;
  }

  /**
   * Reactive: summed progress of the live saves among `ids`. O(live saves),
   * not O(ids), so it is cheap to read on every progress tick.
   */
  liveProgressOf(ids: ReadonlySet<string>): number {
    const progress = this._progress();
    let sum = 0;
    for (const id of this._jobs().keys())
      if (ids.has(id)) sum += progress.get(id) ?? 0;
    return sum;
  }

  /** Reactive: the failure text when `status` is `failed`. */
  error(trackId: string): string | undefined {
    return this.status(trackId) === 'failed'
      ? this.library.storedRecord(trackId)?.error
      : undefined;
  }

  /**
   * Whether the track's last failure this session was systemic (server,
   * network, sign-in) or about the track itself. Undefined when it has not
   * failed this session.
   */
  failureKind(trackId: string): 'systemic' | 'track' | undefined {
    return this.failKinds.get(trackId);
  }

  /**
   * Persist a `saving` record for a remote track and queue its download.
   * Resolves once the record is stored (not when the file is). No-op for
   * local tracks, tracks without a source link, and tracks already saved.
   */
  async ensureSaved(track: Track): Promise<void> {
    return this.save(track);
  }

  /**
   * `ensureSaved`, optionally storing `interrupted` attempts/cooldown on the
   * `saving` record (an interrupted save resumed at launch).
   */
  private async save(
    track: Track,
    interrupted?: { attempts: number; retryAt: number },
  ): Promise<void> {
    if (!isSavable(track)) return;
    await this.library.ready();
    const existing = this.library.storedRecord(track.id);
    if (existing && (existing.status ?? 'saved') === 'saved') return;
    if (this._jobs().has(track.id)) return;

    const record: ImportedTrack = {
      track: existing?.track ?? track,
      filePath: '',
      importedAt: existing?.importedAt ?? Date.now(),
      status: 'saving',
      ...(interrupted ??
        (existing?.attempts ? { attempts: existing.attempts } : {})),
    };
    await this.library.storeRecord(record);
    this.failKinds.delete(track.id);
    if (!this.resolver) {
      this.failKinds.set(track.id, 'systemic');
      await this.fail(track.id, 'Saving is not available in this build.');
      return;
    }
    this.enqueue(track.id);
  }

  /** Save again after a failure (or after a cancel). */
  async retry(trackId: string): Promise<void> {
    const record = this.library.storedRecord(trackId);
    if (!record?.track.source?.url) return;
    await this.ensureSaved(record.track);
  }

  /** Stop a queued or running save and mark it failed ("Cancelled."), keeping the track. */
  cancel(trackId: string): void {
    this.dropLive(trackId);
    void this.fail(trackId, 'Cancelled.');
    this.pump();
  }

  /**
   * Stop a queued or running save and mark it failed with `message` (used to
   * pause auto-downloads). Unlike `cancel`, the auto-downloader retries it.
   */
  defer(trackId: string, message = WAITING_FOR_WIFI): void {
    if (!this._jobs().has(trackId)) return;
    this.dropLive(trackId);
    void this.fail(trackId, message);
    this.pump();
  }

  /**
   * Stop saves for these tracks without writing anything. Used just before
   * their records are deleted.
   */
  forget(trackIds: readonly string[]): void {
    for (const id of trackIds) this.dropLive(id);
    this.pump();
  }

  /** Stop every queued and running save without writing anything (app reset). */
  forgetAll(): void {
    this.forget([...this._jobs().keys()]);
  }

  /**
   * Delete the files and records of remote tracks that are neither
   * bookmarked nor in any playlist, limited to `trackIds` when given (e.g. the
   * tracks just un-bookmarked). Resolves to the number of records removed.
   * Skipped until the library and playlists have loaded (never on a failed load).
   */
  async reconcile(trackIds?: readonly string[]): Promise<number> {
    const playlists = this.playlists();
    await Promise.all([this.library.ready(), playlists.ready()]);
    if (this.library.status() !== 'ready' || playlists.status() !== 'ready')
      return 0;

    const referenced = new Set<string>([
      ...this.library.savedIds(),
      ...playlists.playlists().flatMap((p) => p.trackIds),
    ]);
    const target = trackIds ? new Set(trackIds) : null;
    let removed = 0;
    for (const { track } of this.library.storedRecords()) {
      if (target && !target.has(track.id)) continue;
      if (track.providerId === LOCAL_PROVIDER_ID || referenced.has(track.id))
        continue;
      this.dropLive(track.id);
      try {
        await this.media?.remove(track);
        await this.library.dropRecord(track.id);
        removed++;
      } catch {
        // Kept for the next reconcile.
      }
    }
    this.pump();
    return removed;
  }

  /**
   * Startup: reconcile, then (off the boot path, once the app is idle) resume
   * saves left `saving` or `failed`. A failed save waits out its `retryAt`
   * cooldown; cancel or unbookmark to stop it.
   */
  async start(): Promise<void> {
    await this.reconcile();
    const retry = () => void this.retryInterrupted();
    if (typeof requestIdleCallback === 'function') {
      requestIdleCallback(retry, { timeout: 8000 });
    } else {
      setTimeout(retry, 4000);
    }
  }

  private async retryInterrupted(): Promise<void> {
    const now = Date.now();
    for (const record of this.library.storedRecords()) {
      if (record.track.providerId === LOCAL_PROVIDER_ID) continue;
      const status = record.status ?? 'saved';
      if (status !== 'saving' && status !== 'failed') continue;
      if (status === 'failed' && record.error === WAITING_FOR_WIFI) continue;
      // Failed saves and interrupted saves share the cooldown.
      if ((record.retryAt ?? 0) > now) continue;
      // An interrupted save counts as an attempt, like a real failure in `fail()`.
      const attempts = (record.attempts ?? 0) + 1;
      const interrupted =
        status === 'saving'
          ? { attempts, retryAt: now + retryDelayMs(attempts) }
          : undefined;
      try {
        await this.save(record.track, interrupted);
      } catch {
        // Left as it is; retried on a later launch.
      }
    }
  }

  // ---- Internals -----------------------------------------------------------

  private enqueue(trackId: string): void {
    this.queue.push(trackId);
    this.setJob(trackId, 'queued');
    this.pump();
  }

  private pump(): void {
    const resolver = this.resolver;
    if (!resolver || this._busyUntil() !== null) return;
    while (this.running.size < OFFLINE_CONCURRENCY && this.queue.length) {
      const trackId = this.queue.shift() as string;
      if (!this._jobs().has(trackId) || this.running.has(trackId)) continue;
      void this.run(trackId, resolver);
    }
  }

  /** Remove a track from the queue and abort it if running. Writes nothing. */
  private dropLive(trackId: string): void {
    const at = this.queue.indexOf(trackId);
    if (at >= 0) this.queue.splice(at, 1);
    this.running.get(trackId)?.abort();
    this.running.delete(trackId);
    this.clearJob(trackId);
  }

  private async run(trackId: string, resolver: StreamResolverPort): Promise<void> {
    const abort = new AbortController();
    this.running.set(trackId, abort);
    this.setJob(trackId, 'saving');
    let sourceFile: string | undefined;
    try {
      const record = this.library.storedRecord(trackId);
      const url = record?.track.source?.url;
      if (!record || !url) throw new Error('This track has no download link.');

      await this.settings.ready();
      const out = await resolver.saveToDevice(url, {
        id: trackId,
        signal: abort.signal,
        quality: this.settings.downloadQuality(),
        location: this.downloadLocation(),
        onProgress: (fraction) => {
          if (this.running.get(trackId) === abort)
            this.setProgress(trackId, clamp(fraction));
        },
      });
      sourceFile = out.sourceFile;
      if (abort.signal.aborted) {
        await this.removeFile(trackId, sourceFile);
        return;
      }
      const current = this.library.storedRecord(trackId);
      if (!current) {
        // Forgotten while downloading.
        await this.removeFile(trackId, sourceFile);
        return;
      }
      await this.library.storeRecord({
        track: { ...current.track, sourceFile: out.sourceFile, sizeBytes: out.sizeBytes },
        filePath: out.sourceFile,
        importedAt: current.importedAt,
        status: 'saved',
      });
      this.clearJob(trackId);
      void this.enrich(trackId);
    } catch (err) {
      if (abort.signal.aborted) {
        if (sourceFile) await this.removeFile(trackId, sourceFile);
        return; // cancel() or forget() already decided the outcome
      }
      if (sourceFile) await this.removeFile(trackId, sourceFile);
      if (isBusy(err)) {
        // Server busy / rate limited: keep it queued and back off (no failure).
        this.running.delete(trackId);
        this.queue.unshift(trackId);
        this.setJob(trackId, 'queued');
        this.backOff(err);
        return;
      }
      if (!isAbort(err)) {
        this.failKinds.set(trackId, failureKind(err));
        await this.fail(trackId, remoteErrorMessage(err));
      } else await this.fail(trackId, 'Cancelled.');
    } finally {
      if (this.running.get(trackId) === abort) {
        this.running.delete(trackId);
        this.clearJob(trackId);
      }
      this.pump();
    }
  }

  /** Hold every new save until the server's Retry-After (capped) has passed. */
  private backOff(err: unknown): void {
    const sec = busyRetryAfterSec(err);
    const wait = Math.min(MAX_BUSY_WAIT_MS, sec ? sec * 1000 : BUSY_WAIT_MS);
    const until = Date.now() + wait;
    if ((this._busyUntil() ?? 0) >= until) return;
    clearTimeout(this.busyTimer);
    this._busyUntil.set(until);
    this.busyTimer = setTimeout(() => {
      this._busyUntil.set(null);
      this.pump();
    }, wait);
  }

  private async fail(trackId: string, message: string): Promise<void> {
    const record = this.library.storedRecord(trackId);
    if (!record) return;
    // Cancels and Wi-Fi waits are not real attempts: no cooldown for them.
    const counts = message !== 'Cancelled.' && message !== WAITING_FOR_WIFI;
    const attempts = (record.attempts ?? 0) + (counts ? 1 : 0);
    try {
      await this.library.storeRecord({
        track: record.track,
        filePath: '',
        importedAt: record.importedAt,
        status: 'failed',
        error: message,
        ...(attempts ? { attempts } : {}),
        ...(counts ? { retryAt: Date.now() + retryDelayMs(attempts) } : {}),
      });
    } catch {
      // The record stays as it was; the UI shows the pre-failure state.
    }
    this.clearJob(trackId);
  }

  private async removeFile(trackId: string, sourceFile: string): Promise<void> {
    await this.media
      ?.remove({ id: trackId, sourceFile })
      .catch(() => 0);
  }

  /**
   * Best-effort iTunes/Deezer lookup after a save: fills art, album, year and
   * genre unless the user edited the field. Never fails the save.
   */
  private async enrich(trackId: string): Promise<void> {
    const fetchFn: MetadataFetch | null = this.metadataFetch;
    if (!fetchFn) return;
    try {
      const record = this.library.storedRecord(trackId);
      if (!record) return;
      const { match } = await lookupMetadata(
        {
          title: record.track.title,
          artist: record.track.artist,
          durationSec: record.track.durationSec,
        },
        fetchFn,
      );
      const current = this.library.storedRecord(trackId);
      if (!match || !current || (current.status ?? 'saved') !== 'saved') return;
      const edited = new Set<string>(current.track.userEdited ?? []);
      const track: Track = { ...current.track };
      if (match.artworkUrl) track.artUrl = match.artworkUrl;
      if (match.album && !edited.has('album')) track.album = match.album;
      if (match.year && !edited.has('year')) track.year = match.year;
      if (match.genre && !edited.has('genre')) track.genre = match.genre;
      await this.library.storeRecord({ ...current, track });
    } catch {
      // Best effort: keep the track as it is.
    }
  }

  /** Set a live save's status; its progress restarts at 0. */
  private setJob(trackId: string, status: LiveStatus): void {
    this.dropProgress(trackId);
    if (this._jobs().get(trackId) === status) return;
    this._jobs.update((m) => new Map(m).set(trackId, status));
  }

  private clearJob(trackId: string): void {
    this.dropProgress(trackId);
    if (!this._jobs().has(trackId)) return;
    this._jobs.update((m) => {
      const next = new Map(m);
      next.delete(trackId);
      return next;
    });
  }

  /** Buffer a progress tick; published with the others on the next flush. */
  private setProgress(trackId: string, fraction: number): void {
    this.pendingProgress.set(trackId, fraction);
    this.progressTimer ??= setTimeout(() => {
      this.progressTimer = undefined;
      this.flushProgress();
    }, PROGRESS_INTERVAL_MS);
  }

  private flushProgress(): void {
    if (!this.pendingProgress.size) return;
    const jobs = this._jobs();
    const next = new Map(this._progress());
    for (const [id, fraction] of this.pendingProgress)
      if (jobs.has(id)) next.set(id, fraction);
    this.pendingProgress.clear();
    this._progress.set(next);
  }

  private dropProgress(trackId: string): void {
    this.pendingProgress.delete(trackId);
    if (!this._progress().has(trackId)) return;
    this._progress.update((m) => {
      const next = new Map(m);
      next.delete(trackId);
      return next;
    });
  }

  private playlists(): PlaylistsStore {
    return this.injector.get(PlaylistsStore);
  }
}

/** Remote tracks with a page link can be saved; local imports and catalogue tracks cannot. */
export function isSavable(track: Track): boolean {
  return track.providerId !== LOCAL_PROVIDER_ID && !!track.source?.url;
}

/** Cooldown before a failed save is retried at launch: 1 min, 5 min, 30 min, then 2 h. */
const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 60 * 60_000];

function retryDelayMs(attempts: number): number {
  return RETRY_DELAYS_MS[Math.min(attempts, RETRY_DELAYS_MS.length) - 1];
}

function clamp(fraction: number): number {
  return Number.isFinite(fraction) ? Math.max(0, Math.min(1, fraction)) : 0;
}
