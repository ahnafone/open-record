import { Injectable, Injector, computed, inject, signal } from '@angular/core';
import { lookupMetadata, type MetadataFetch } from '@open-record/metadata-lookup';
import type { Track } from '@open-record/models';
import { StoragePort, type ImportedTrack } from '@open-record/storage';
import { LOCAL_PROVIDER_ID, LibraryStore } from './library.store';
import { PlaylistsStore } from './playlists.store';
import { LocalMediaPort, METADATA_FETCH, StreamResolverPort } from './ports';
import { isAbort, remoteErrorMessage } from './remote-errors';

/** Saves that download at once. */
export const OFFLINE_CONCURRENCY = 2;

/** What the UI shows for a remote track's offline copy. */
export type OfflineStatus = 'queued' | 'saving' | 'saved' | 'failed';

interface LiveJob {
  status: 'queued' | 'saving';
  /** 0-1 while saving. */
  progress: number;
}

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
  private readonly storage = inject(StoragePort);
  private readonly resolver = inject(StreamResolverPort, { optional: true });
  private readonly media = inject(LocalMediaPort, { optional: true });
  private readonly metadataFetch = inject(METADATA_FETCH, { optional: true });
  // PlaylistsStore injects this store: resolve it lazily.
  private readonly injector = inject(Injector);

  private readonly _jobs = signal<ReadonlyMap<string, LiveJob>>(new Map());
  private readonly queue: string[] = [];
  private readonly running = new Map<string, AbortController>();

  /** Tracks queued or saving right now. */
  readonly pendingCount = computed(() => this._jobs().size);

  /** Reactive: the offline state of a track, or undefined when it has no record. */
  status(trackId: string): OfflineStatus | undefined {
    const job = this._jobs().get(trackId);
    if (job) return job.status;
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
    const job = this._jobs().get(trackId);
    if (job) return job.progress;
    return this.status(trackId) === 'saved' ? 1 : 0;
  }

  /** Reactive: the failure text when `status` is `failed`. */
  error(trackId: string): string | undefined {
    return this.status(trackId) === 'failed'
      ? this.library.storedRecord(trackId)?.error
      : undefined;
  }

  /**
   * Persist a `saving` record for a remote track and queue its download.
   * Resolves once the record is stored (not when the file is). No-op for
   * local tracks, tracks without a source link, and tracks already saved.
   */
  async ensureSaved(track: Track): Promise<void> {
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
    };
    await this.library.storeRecord(record);
    if (!this.resolver) {
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
   * bookmarked nor in any playlist. Resolves to the number of records removed.
   * Skipped until the library and playlists have loaded (never on a failed load).
   */
  async reconcile(): Promise<number> {
    const playlists = this.playlists();
    await Promise.all([this.library.ready(), playlists.ready()]);
    if (this.library.status() !== 'ready' || playlists.status() !== 'ready')
      return 0;

    const referenced = new Set<string>([
      ...this.library.savedIds(),
      ...playlists.playlists().flatMap((p) => p.trackIds),
    ]);
    let removed = 0;
    for (const record of await this.storage.importedTracks.list()) {
      const { track } = record;
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
   * Startup: reconcile, then resume saves left `saving` or `failed` (a failed
   * save is retried on every launch; cancel or unbookmark to stop it).
   */
  async start(): Promise<void> {
    await this.reconcile();
    for (const record of await this.storage.importedTracks.list()) {
      if (record.track.providerId === LOCAL_PROVIDER_ID) continue;
      const status = record.status ?? 'saved';
      if (status === 'saving' || status === 'failed') {
        await this.ensureSaved(record.track);
      }
    }
  }

  // ---- Internals -----------------------------------------------------------

  private enqueue(trackId: string): void {
    this.queue.push(trackId);
    this.setJob(trackId, { status: 'queued', progress: 0 });
    this.pump();
  }

  private pump(): void {
    const resolver = this.resolver;
    if (!resolver) return;
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
    this.setJob(trackId, { status: 'saving', progress: 0 });
    let sourceFile: string | undefined;
    try {
      const record = this.library.storedRecord(trackId);
      const url = record?.track.source?.url;
      if (!record || !url) throw new Error('This track has no download link.');

      const out = await resolver.saveToDevice(url, {
        id: trackId,
        signal: abort.signal,
        onProgress: (fraction) => {
          if (this.running.get(trackId) === abort)
            this.setJob(trackId, { status: 'saving', progress: clamp(fraction) });
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
      if (!isAbort(err)) await this.fail(trackId, remoteErrorMessage(err));
      else await this.fail(trackId, 'Cancelled.');
    } finally {
      if (this.running.get(trackId) === abort) {
        this.running.delete(trackId);
        this.clearJob(trackId);
      }
      this.pump();
    }
  }

  private async fail(trackId: string, message: string): Promise<void> {
    const record = this.library.storedRecord(trackId);
    if (!record) return;
    try {
      await this.library.storeRecord({
        track: record.track,
        filePath: '',
        importedAt: record.importedAt,
        status: 'failed',
        error: message,
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

  private setJob(trackId: string, job: LiveJob): void {
    this._jobs.update((m) => new Map(m).set(trackId, job));
  }

  private clearJob(trackId: string): void {
    if (!this._jobs().has(trackId)) return;
    this._jobs.update((m) => {
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
function isSavable(track: Track): boolean {
  return track.providerId !== LOCAL_PROVIDER_ID && !!track.source?.url;
}

function clamp(fraction: number): number {
  return Number.isFinite(fraction) ? Math.max(0, Math.min(1, fraction)) : 0;
}
