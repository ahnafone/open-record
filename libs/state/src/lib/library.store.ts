import { Injectable, Injector, computed, inject, signal } from '@angular/core';
import type { EditableTrackField, Track } from '@open-record/models';
import { MusicSourceRegistry } from '@open-record/music-source';
import {
  SETTINGS_KEYS,
  StoragePort,
  type ImportedTrack,
  type JsonValue,
} from '@open-record/storage';
// Circular with these stores; only used at call time, never at module load.
import { PlayerStore } from './player.store';
import { PlaylistsStore } from './playlists.store';
import { LocalMediaPort, type LocalImportFailure } from './ports';
import { SettingsStore } from './settings.store';
import { OfflineStore } from './offline.store';

export type LoadStatus = 'loading' | 'ready' | 'error';

/** Provider id of user-imported tracks (track ids are `local:<key>`). */
export const LOCAL_PROVIDER_ID = 'local';
/** Provider id of server-backed (stream server) tracks. */
export const REMOTE_PROVIDER_ID = 'remote';

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
  /** Stored file records by track id: a track is "imported" iff it has one. */
  private readonly _stored = signal<ReadonlyMap<string, ImportedTrack>>(new Map());
  /** Tracks persisted by metadata only (no file record), e.g. Spotify imports. */
  private readonly _metadata = signal<ReadonlyMap<string, Track>>(new Map());
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
  /**
   * Tracks that have a stored file record (user imports, and remote tracks
   * that are saving, saved or failed to save), in index order.
   */
  readonly importedTracks = computed(() => {
    const stored = this._stored();
    return this._tracks().filter((t) => stored.has(t.id));
  });
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

  /** True when the track has a stored file record (editable, removable). Reactive. */
  isImported(track: Pick<Track, 'id'>): boolean {
    return this._stored().has(track.id);
  }

  /** The stored file record for a track, if any. Reactive. */
  storedRecord(trackId: string): ImportedTrack | undefined {
    return this._stored().get(trackId);
  }

  /** Bookmark or un-bookmark a record. Resolves to the new saved state. */
  async toggleSaved(trackId: string): Promise<boolean> {
    await this.loaded;
    const save = !this.isSaved(trackId);
    await this.setSaved(trackId, save);
    return save;
  }

  /**
   * Bookmark or un-bookmark a record. Bookmarking never downloads by itself:
   * saving to the device is left to Auto-download (`AutoDownloadStore`) or an
   * explicit download. Un-bookmarking reconciles stored files.
   */
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
    if (!saved) await this.offline().reconcile();
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

  /**
   * Add tracks to the known-track index (first occurrence of an id wins).
   * In-memory only: streamed tracks are never persisted by this call.
   */
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

  // ---- Metadata-only tracks -------------------------------------------------

  /**
   * Persist tracks by metadata only: they join the index and survive
   * restarts, but nothing is saved to the device (e.g. Spotify imports and
   * their matches). Same-id entries are replaced; a stored file record still
   * wins in the index.
   */
  async addMetadataTracks(tracks: readonly Track[]): Promise<void> {
    await this.loaded;
    if (!tracks.length) return;
    const next = new Map(this._metadata());
    for (const t of tracks) next.set(t.id, t);
    await this.writeMetadata(next);
    for (const t of tracks) if (!this._stored().has(t.id)) this.upsert(t);
  }

  /** Forget metadata-only tracks (index entries of tracks with a file record stay). */
  async removeMetadataTracks(ids: readonly string[]): Promise<void> {
    await this.loaded;
    const gone = new Set(ids.filter((id) => this._metadata().has(id)));
    if (!gone.size) return;
    const next = new Map(this._metadata());
    for (const id of gone) next.delete(id);
    await this.writeMetadata(next);
    const stored = this._stored();
    this._tracks.update((all) =>
      all.filter((t) => !gone.has(t.id) || stored.has(t.id)),
    );
  }

  /** Ids of every metadata-only persisted track (account sync reads these). */
  readonly metadataIds = computed(() => [...this._metadata().keys()]);

  /** True when the track is persisted by metadata only. Reactive. */
  isMetadataOnly(trackId: string): boolean {
    return this._metadata().has(trackId) && !this._stored().has(trackId);
  }

  /**
   * Bookmark tracks without saving them to the device (imports). `savedAt`
   * (epoch ms) sets their place in the most-recent-first order; ids already
   * saved are left alone.
   */
  async bookmarkWithoutSaving(
    entries: readonly { id: string; savedAt?: number }[],
  ): Promise<void> {
    await this.loaded;
    const seen = new Set(this._savedIds());
    const fresh = entries.filter((e) => !seen.has(e.id) && !!seen.add(e.id));
    if (!fresh.length) return;
    try {
      for (const e of fresh)
        await this.storage.savedRecords.add(e.id, e.savedAt);
    } finally {
      this._savedIds.set(await this.storage.savedRecords.list());
    }
  }

  /** Move a bookmark to another track id, keeping its position. Never saves to the device. */
  async replaceSaved(oldId: string, newId: string): Promise<void> {
    await this.loaded;
    if (oldId === newId || !this.isSaved(oldId)) return;
    await this.storage.savedRecords.replace(oldId, newId);
    this._savedIds.update((ids) => {
      const seen = new Set<string>();
      return ids
        .map((id) => (id === oldId ? newId : id))
        .filter((id) => !seen.has(id) && !!seen.add(id));
    });
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
        await this.storeRecord({
          track,
          filePath: track.sourceFile ?? '',
          importedAt,
        });
        imported.push(track);
      } catch (error) {
        await this.media.remove(track).catch(() => 0);
        failures.push({ fileName: track.sourceFile ?? track.title, error });
      }
    }
    return { imported, failures };
  }

  /**
   * Persist a stored file record (creates or replaces it) and update the
   * index and record map. Throws if the write fails; nothing changes then.
   */
  async storeRecord(record: ImportedTrack): Promise<void> {
    await this.storage.importedTracks.save(record);
    this._stored.update((m) => new Map(m).set(record.track.id, record));
    this.upsert(record.track);
  }

  /**
   * Delete a stored file record. Does not touch files, the index, saved
   * records or playlists: callers decide what else goes.
   */
  async dropRecord(trackId: string): Promise<void> {
    await this.storage.importedTracks.delete(trackId);
    this._stored.update((m) => {
      const next = new Map(m);
      next.delete(trackId);
      return next;
    });
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
      await this.storeRecord({ ...record, track: next });
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
    this.offline().forget([id]);
    await this.detach([id]);
    await this.dropRecord(id);
    this._tracks.update((all) => all.filter((t) => t.id !== id));
    await this.media?.remove(track).catch(() => 0);
  }

  /** Delete every imported track (records, files and references). */
  async clearImported(): Promise<void> {
    await this.loaded;
    const ids = new Set([
      ...this.importedTracks().map((t) => t.id),
      ...(await this.storage.importedTracks.list()).map((i) => i.track.id),
    ]);
    this.offline().forget([...ids]);
    await this.detach([...ids]);
    await this.storage.importedTracks.clear();
    this._stored.set(new Map());
    this._tracks.update((all) => all.filter((t) => !ids.has(t.id)));
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
    this.offline().forgetAll();
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

  private async writeMetadata(next: ReadonlyMap<string, Track>): Promise<void> {
    await this.storage.settings.set(
      SETTINGS_KEYS.metadataTracks,
      [...next.values()] as unknown as JsonValue,
    );
    this._metadata.set(next);
  }

  private replaceTrack(track: Track): void {
    this._tracks.update((all) =>
      all.map((t) => (t.id === track.id ? track : t)),
    );
  }

  /** Replace the index entry for a track, or add it. */
  private upsert(track: Track): void {
    this._tracks.update((all) =>
      all.some((t) => t.id === track.id)
        ? all.map((t) => (t.id === track.id ? track : t))
        : [...all, track],
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

  private offline() {
    return this.injector.get(OfflineStore);
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
    const bundled = this._tracks().filter((t) => !this.isImported(t) && !t.source);
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
      const [listed, imported, savedIds, metadata] = await Promise.all([
        this.registry.listAll(),
        this.storage.importedTracks.list(),
        this.storage.savedRecords.list(),
        this.storage.settings.get<JsonValue>(SETTINGS_KEYS.metadataTracks),
      ]);
      const metaTracks = Array.isArray(metadata)
        ? (metadata as unknown as Track[]).filter((t) => t && t.id)
        : [];
      this._tracks.set(
        dedupe([...listed, ...imported.map((i) => i.track), ...metaTracks]),
      );
      this._stored.set(new Map(imported.map((i) => [i.track.id, i])));
      this._metadata.set(new Map(metaTracks.map((t) => [t.id, t])));
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
