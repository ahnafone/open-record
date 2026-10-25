import { Injectable, Injector, computed, inject, signal } from '@angular/core';
import type { EditableTrackField, Track } from '@open-record/models';
import { MusicSourceRegistry } from '@open-record/music-source';
import { StoragePort, type ImportedTrack } from '@open-record/storage';
// Circular with these stores; only used at call time, never at module load.
import { PlayerStore } from './player.store';
import { PlaylistsStore } from './playlists.store';
import { LocalMediaPort, type LocalImportFailure } from './ports';
import { SettingsStore } from './settings.store';

export type LoadStatus = 'loading' | 'ready' | 'error';

/** Provider id of user-imported tracks (track ids are `local:<key>`). */
export const LOCAL_PROVIDER_ID = 'local';

/**
 * Hand edits to an imported track. Only provided keys are considered; a
 * field that actually changes is marked as user-edited. `null` (or an empty string) clears an
 * optional field.
 */
export interface TrackEdit {
  title?: string;
  artist?: string;
  album?: string | null;
  year?: number | null;
  genre?: string | null;
}

export interface ImportOutcome {
  /** Newly imported (and persisted) tracks. */
  imported: Track[];
  /** Files that could not be imported or saved. */
  failures: LocalImportFailure[];
}

export interface StorageUsage {
  /** Imported audio files. */
  importedAudioBytes: number;
  /** Cover art for imported tracks. */
  artBytes: number;
  /** Approximate size of imported-track metadata records. */
  metadataBytes: number;
  /** Bundled catalogue audio + art (read-only); null if it could not be measured. */
  catalogBytes: number | null;
  /** Bytes the user can free: imported audio + art + metadata. */
  removableBytes: number;
}

/**
 * Known tracks (provider catalogues plus imported files) and the user's saved
 * records. Hydrates from storage on construction; mutations persist
 * optimistically and roll back if the write fails. Also owns imported-file
 * management.
 */
@Injectable({ providedIn: 'root' })
export class LibraryStore {
  private readonly storage = inject(StoragePort);
  private readonly registry = inject(MusicSourceRegistry);
  private readonly settings = inject(SettingsStore);
  private readonly media = inject(LocalMediaPort, { optional: true });
  // PlaylistsStore and PlayerStore inject this store: resolve them lazily.
  private readonly injector = inject(Injector);

  private readonly _tracks = signal<readonly Track[]>([]);
  private readonly _savedIds = signal<readonly string[]>([]);
  private readonly _status = signal<LoadStatus>('loading');
  private readonly _error = signal<string | null>(null);

  /** Every known track: listable provider tracks, then imported tracks. */
  readonly tracks = this._tracks.asReadonly();
  /** Saved (bookmarked) track ids, most recently saved first. */
  readonly savedIds = this._savedIds.asReadonly();
  readonly status = this._status.asReadonly();
  readonly error = this._error.asReadonly();

  readonly trackMap = computed(
    () => new Map(this._tracks().map((t) => [t.id, t])),
  );
  private readonly savedSet = computed(() => new Set(this._savedIds()));
  /** Saved records that resolve to a known track, most recent first. */
  readonly savedRecords = computed(() => this.resolveIds(this._savedIds()));
  /** User-imported tracks, oldest import first. */
  readonly importedTracks = computed(() => this._tracks().filter(isLocal));
  /** Importing is possible (a LocalMediaPort is provided). */
  readonly canImport = !!this.media;

  private loaded: Promise<void>;
  private catalogBytes?: Promise<number | null>;

  constructor() {
    this.loaded = this.hydrate();
  }

  /** Resolves once hydration has finished (successfully or not). */
  ready(): Promise<void> {
    return this.loaded;
  }

  /** Reload tracks and saved records from providers and storage. */
  async reload(): Promise<void> {
    this.loaded = this.hydrate();
    await this.loaded;
  }

  /** Reactive lookup; returns undefined for unknown ids. */
  track(id: string): Track | undefined {
    return this.trackMap().get(id);
  }

  /** Map ids to known tracks, keeping order and skipping unknown ids. */
  resolveIds(ids: readonly string[]): Track[] {
    const map = this.trackMap();
    return ids.flatMap((id) => {
      const track = map.get(id);
      return track ? [track] : [];
    });
  }

  /** Reactive: safe to call from templates and computed signals. */
  isSaved(trackId: string): boolean {
    return this.savedSet().has(trackId);
  }

  /** True for user-imported tracks (editable, removable). */
  isImported(track: Pick<Track, 'providerId'>): boolean {
    return track.providerId === LOCAL_PROVIDER_ID;
  }

  /** Bookmark or un-bookmark a record. Resolves to the new saved state. */
  async toggleSaved(trackId: string): Promise<boolean> {
    await this.loaded;
    const save = !this.isSaved(trackId);
    await this.setSaved(trackId, save);
    return save;
  }

  async setSaved(trackId: string, saved: boolean): Promise<void> {
    // Hydration would otherwise overwrite an early optimistic change.
    await this.loaded;
    if (this.isSaved(trackId) === saved) return;
    const apply = (on: boolean) =>
      this._savedIds.update((ids) =>
        on
          ? [trackId, ...ids.filter((id) => id !== trackId)]
          : ids.filter((id) => id !== trackId),
      );
    apply(saved);
    try {
      if (saved) await this.storage.savedRecords.add(trackId);
      else await this.storage.savedRecords.remove(trackId);
    } catch (err) {
      apply(!saved);
      throw err;
    }
  }

  /**
   * Search every searchable provider plus imported tracks (matched locally on
   * title, artist, album, genre and year). A blank query returns all known
   * tracks. Results are merged into the known-track index so they can be
   * saved, added to playlists and restored in the queue.
   */
  async search(query: string): Promise<Track[]> {
    if (!query.trim()) return [...this._tracks()];
    await this.loaded;
    const [remote, local] = [
      this.registry.searchAll(query),
      this.importedTracks().filter(matches(query)),
    ];
    const results = dedupe([...local, ...(await remote)]);
    this.remember(results);
    return results;
  }

  /** Add tracks to the known-track index (first occurrence of an id wins). */
  remember(tracks: readonly Track[]): void {
    const map = this.trackMap();
    const fresh = tracks.filter((t) => !map.has(t.id));
    if (fresh.length) this._tracks.update((all) => [...all, ...dedupe(fresh)]);
  }

  /**
   * Loadable cover URL: the provider's `artUrl`, else the stored cover of an
   * imported track. Not stable across launches: never persist it.
   */
  async artUrl(track: Track): Promise<string | undefined> {
    if (track.artUrl) return track.artUrl;
    if (!track.coverPath || !this.media) return undefined;
    return this.media.artUrl(track);
  }

  // ---- Imported files ------------------------------------------------------

  /**
   * Open the system file picker and import the chosen audio files. Resolves
   * with the persisted tracks and per-file failures (empty if dismissed).
   * Throws if importing is unavailable.
   */
  async importFiles(): Promise<ImportOutcome> {
    if (!this.media) throw new Error('Importing files is not available.');
    await this.loaded;
    const result = await this.media.pickAndImport();
    const failures = [...result.failures];
    const imported: Track[] = [];
    const importedAt = Date.now();
    for (const track of result.tracks) {
      try {
        await this.storage.importedTracks.save({
          track,
          filePath: track.sourceFile ?? '',
          importedAt,
        });
        imported.push(track);
      } catch (error) {
        await this.media.remove(track.id).catch(() => 0);
        failures.push({ fileName: track.sourceFile ?? track.title, error });
      }
    }
    if (imported.length)
      this._tracks.update((all) => dedupe([...all, ...imported]));
    return { imported, failures };
  }

  /**
   * Persist a track the download server fetched and the local provider
   * imported (see `DownloadsStore`), exactly like `importFiles`. On a failed
   * write the stored file is deleted and the error rethrown.
   */
  async addDownloaded(track: Track): Promise<Track> {
    await this.loaded;
    try {
      await this.storage.importedTracks.save({
        track,
        filePath: track.sourceFile ?? '',
        importedAt: Date.now(),
      });
    } catch (error) {
      await this.media?.remove(track.id).catch(() => 0);
      throw error;
    }
    this._tracks.update((all) => dedupe([...all, track]));
    return track;
  }

  /**
   * Edit an imported track's metadata. Changed fields are marked
   * user-edited. Throws on invalid input
   * (empty title/artist, bad year) or for non-imported tracks.
   */
  async updateTrack(id: string, edit: TrackEdit): Promise<Track> {
    await this.loaded;
    const before = this.track(id);
    const record =
      before && this.isImported(before)
        ? await this.storage.importedTracks.get(id)
        : undefined;
    if (!before || !record)
      throw new Error('Only imported tracks can be edited.');

    const next: Track = { ...before };
    const edited = new Set<EditableTrackField>(before.userEdited ?? []);
    let changed = false;
    const set = <K extends EditableTrackField>(field: K, value: Track[K]) => {
      if (next[field] === value) return;
      if (value === undefined) delete next[field];
      else next[field] = value;
      edited.add(field);
      changed = true;
    };
    if (edit.title !== undefined) set('title', required(edit.title, 'Title'));
    if (edit.artist !== undefined)
      set('artist', required(edit.artist, 'Artist'));
    if (edit.album !== undefined) set('album', optional(edit.album));
    if (edit.genre !== undefined) set('genre', optional(edit.genre));
    if (edit.year !== undefined) set('year', validYear(edit.year));
    if (!changed) return before;
    next.userEdited = [...edited];

    this.replaceTrack(next);
    try {
      await this.storage.importedTracks.save({ ...record, track: next });
    } catch (err) {
      this.replaceTrack(before);
      throw err;
    }
    return next;
  }

  /**
   * Delete an imported track: its record, stored files, and its entries in
   * saved records, playlists and the play queue.
   */
  async removeImported(id: string): Promise<void> {
    await this.loaded;
    const track = this.track(id);
    if (!track || !this.isImported(track)) return;
    await this.detach([id]);
    await this.storage.importedTracks.delete(id);
    this._tracks.update((all) => all.filter((t) => t.id !== id));
    await this.media?.remove(id).catch(() => 0);
  }

  /** Delete every imported track (records, files and references). */
  async clearImported(): Promise<void> {
    await this.loaded;
    const ids = new Set([
      ...this.importedTracks().map((t) => t.id),
      ...(await this.storage.importedTracks.list()).map((i) => i.track.id),
    ]);
    await this.detach([...ids]);
    await this.storage.importedTracks.clear();
    this._tracks.update((all) =>
      all.filter((t) => !ids.has(t.id) && !isLocal(t)),
    );
    await this.media?.cleanup([]).catch(() => 0);
  }

  /**
   * Reset the app: stop playback, delete imported files and every stored
   * collection (playlists, saved records, queue, settings), then reload the
   * stores. Settings return to their defaults.
   */
  async clearAll(): Promise<void> {
    await this.loaded;
    await this.player()?.clear();
    await this.media?.cleanup([]).catch(() => 0);
    await this.storage.clearAll();
    await this.reload();
    await Promise.all([this.playlists().reload(), this.settings.reload()]);
  }

  /** Bytes used on device. Catalogue size is measured once and cached. */
  async storageUsage(): Promise<StorageUsage> {
    await this.loaded;
    const [files, records, catalogBytes] = await Promise.all([
      this.media?.usage().catch(() => ({ audioBytes: 0, artBytes: 0 })) ?? {
        audioBytes: 0,
        artBytes: 0,
      },
      this.storage.importedTracks.list().catch(() => [] as ImportedTrack[]),
      (this.catalogBytes ??= this.measureCatalog()),
    ]);
    const metadataBytes = records.length
      ? new TextEncoder().encode(JSON.stringify(records)).length
      : 0;
    return {
      importedAudioBytes: files.audioBytes,
      artBytes: files.artBytes,
      metadataBytes,
      catalogBytes,
      removableBytes: files.audioBytes + files.artBytes + metadataBytes,
    };
  }

  // ---- Internals -----------------------------------------------------------

  private replaceTrack(track: Track): void {
    this._tracks.update((all) =>
      all.map((t) => (t.id === track.id ? track : t)),
    );
  }

  /** Remove tracks from the queue, playlists and saved records. */
  private async detach(ids: readonly string[]): Promise<void> {
    if (!ids.length) return;
    await this.player()?.removeTracks(ids);
    await this.playlists().removeTracksEverywhere(ids);
    for (const id of ids) {
      if (this.isSaved(id)) await this.setSaved(id, false);
    }
  }

  private playlists() {
    return this.injector.get(PlaylistsStore);
  }

  private player() {
    try {
      return this.injector.get(PlayerStore);
    } catch {
      return null;
    }
  }

  /** Best-effort size of bundled (read-only) provider assets via HEAD requests. */
  private async measureCatalog(): Promise<number | null> {
    if (typeof fetch !== 'function') return null;
    const bundled = this._tracks().filter((t) => !isLocal(t));
    const urls = new Set<string>();
    for (const t of bundled) {
      if (t.artUrl) urls.add(t.artUrl);
      try {
        const source = await this.registry.resolve(t);
        if (source.kind === 'bundled') urls.add(source.url);
      } catch {
        // Unresolvable tracks are skipped.
      }
    }
    if (!urls.size) return 0;
    let total = 0;
    let measured = 0;
    await Promise.all(
      [...urls].map(async (url) => {
        try {
          const res = await fetch(url, { method: 'HEAD' });
          const size = Number(res.headers.get('content-length'));
          if (res.ok && Number.isFinite(size) && size > 0) {
            total += size;
            measured++;
          }
        } catch {
          // Not measurable (e.g. offline remote art).
        }
      }),
    );
    return measured ? total : null;
  }

  private async hydrate(): Promise<void> {
    this._status.set('loading');
    this._error.set(null);
    try {
      const [listed, imported, savedIds] = await Promise.all([
        this.registry.listAll(),
        this.storage.importedTracks.list(),
        this.storage.savedRecords.list(),
      ]);
      this._tracks.set(dedupe([...listed, ...imported.map((i) => i.track)]));
      this._savedIds.set(savedIds);
      this._status.set('ready');
    } catch (err) {
      this._error.set(
        err instanceof Error ? err.message : 'Could not load your library.',
      );
      this._status.set('error');
    }
  }
}

function isLocal(track: Pick<Track, 'providerId'>): boolean {
  return track.providerId === LOCAL_PROVIDER_ID;
}

function matches(query: string): (t: Track) => boolean {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  return (t) => {
    const hay = [t.title, t.artist, t.album, t.genre, t.year?.toString()]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    return terms.every((term) => hay.includes(term));
  };
}

function required(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${label} is required.`);
  return trimmed;
}

function optional(value: string | null): string | undefined {
  return value?.trim() || undefined;
}

function validYear(value: number | null): number | undefined {
  if (value === null) return undefined;
  if (!Number.isInteger(value) || value < 1 || value > 9999)
    throw new Error('Year must be a whole number.');
  return value;
}

function dedupe(tracks: readonly Track[]): Track[] {
  const seen = new Set<string>();
  return tracks.filter((t) => {
    if (seen.has(t.id)) return false;
    seen.add(t.id);
    return true;
  });
}
