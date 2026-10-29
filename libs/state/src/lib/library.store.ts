import { Injectable, Injector, computed, inject, signal } from '@angular/core';
import type { EditableTrackField, Track } from '@open-record/models';
import { MusicSourceRegistry } from '@open-record/music-source';
import {
  SETTINGS_KEYS,
  StoragePort,
  type ImportedTrack,
  type JsonValue,
  type SavedRecord,
} from '@open-record/storage';
// Circular with these stores; only used at call time, never at module load.
import { PlayCountsStore } from './play-counts.store';
import { PlayerStore } from './player.store';
import { PlaylistsStore } from './playlists.store';
import { LocalMediaPort, type LocalImportFailure } from './ports';
import { SettingsStore } from './settings.store';
import { OfflineStore } from './offline.store';
import { ImportSessionsStore } from './import-sessions.store';

export type LoadStatus = 'loading' | 'ready' | 'error';

/** Provider id of user-imported tracks (track ids are `local:<key>`). */
export const LOCAL_PROVIDER_ID = 'local';
/** Provider id of server-backed (stream server) tracks. */
export const REMOTE_PROVIDER_ID = 'remote';

/** Imported file records written per storage call (a failed write loses at most one batch). */
const IMPORT_BATCH_SIZE = 20;

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
  private readonly sessions = inject(ImportSessionsStore);

  private readonly _tracks = signal<readonly Track[]>([]);
  private readonly _savedIds = signal<readonly string[]>([]);
  /** When each bookmark was made (epoch ms), mirrored from storage. */
  private readonly _savedAt = signal<ReadonlyMap<string, number>>(new Map());
  /** Stored file records by track id: a track is "imported" iff it has one. */
  private readonly _stored = signal<ReadonlyMap<string, ImportedTrack>>(
    new Map(),
  );
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

  /** Rebuilt only when `_tracks` changes (writers skip no-op updates). */
  readonly trackMap = computed(
    () => new Map(this._tracks().map((t) => [t.id, t])),
  );
  private readonly savedSet = computed(() => new Set(this._savedIds()));
  /**
   * The stored-record map, re-emitted only when its set of ids changes: a
   * status or progress write (e.g. every download tick) keeps the old value,
   * so membership-only consumers do not re-run.
   */
  private readonly storedIds = computed(() => this._stored(), {
    equal: sameKeys,
  });
  /** Saved records that resolve to a known track, most recent first. */
  readonly savedRecords = computed(() => this.resolveIds(this._savedIds()), {
    equal: sameItems,
  });
  /**
   * Tracks that have a stored file record (user imports, and remote tracks
   * that are saving, saved or failed to save), in index order.
   */
  readonly importedTracks = computed(
    () => {
      const stored = this.storedIds();
      return this._tracks().filter((t) => stored.has(t.id));
    },
    { equal: sameItems },
  );
  /** Importing is possible (a LocalMediaPort is provided). */
  readonly canImport = !!this.media;
  /**
   * Songs saved on the device from the download server (not user imports)
   * and the bytes their audio files take.
   */
  readonly downloaded = computed(() => {
    let count = 0;
    let bytes = 0;
    for (const record of this._stored().values()) {
      if (record.track.providerId === LOCAL_PROVIDER_ID) continue;
      if ((record.status ?? 'saved') !== 'saved') continue;
      count += 1;
      bytes += record.track.sizeBytes ?? 0;
    }
    return { count, bytes };
  });

  private loaded: Promise<void>;
  private catalogBytes?: Promise<number | null>;
  /** Resolved stored-cover URLs per track id, keyed by the cover they were resolved from. */
  private readonly artUrls = new Map<
    string,
    { coverPath: string; url: Promise<string | undefined> }
  >();

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

  /** When a saved record was bookmarked (epoch ms); undefined if unknown. Reactive. */
  savedAt(trackId: string): number | undefined {
    return this._savedAt().get(trackId);
  }

  /**
   * When a stored file record was created (epoch ms); undefined if none.
   * Reactive on the set of stored ids only, so download ticks do not re-run it.
   */
  importedAt(trackId: string): number | undefined {
    return this.storedIds().get(trackId)?.importedAt;
  }

  /** True when the track has a stored file record (editable, removable). Reactive. */
  isImported(track: Pick<Track, 'id'>): boolean {
    return this._stored().has(track.id);
  }

  /** The stored file record for a track, if any. Reactive. */
  storedRecord(trackId: string): ImportedTrack | undefined {
    return this._stored().get(trackId);
  }

  /**
   * Every stored file record: the in-memory mirror of the imported-tracks
   * collection, so callers need not re-read storage. Reactive.
   */
  readonly storedRecords = computed(() => [...this._stored().values()]);

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
      if (saved) {
        const at = Date.now();
        await this.storage.savedRecords.add(trackId, at);
        this._savedAt.update((m) => new Map(m).set(trackId, at));
      } else await this.storage.savedRecords.remove(trackId);
    } catch (err) {
      apply(!saved);
      throw err;
    }
    if (!saved) await this.offline().reconcile([trackId]);
  }

  /**
   * Un-bookmark several records with one signal write and one reconcile of
   * just those ids (account sync, detaching removed tracks). Ids that are not
   * saved are skipped. On a failed write the remaining ids stay saved.
   */
  async unsaveMany(ids: readonly string[]): Promise<void> {
    await this.loaded;
    const targets = [...new Set(ids)].filter((id) => this.isSaved(id));
    if (!targets.length) return;
    const gone = new Set(targets);
    const before = this._savedIds();
    this._savedIds.update((list) => list.filter((id) => !gone.has(id)));
    const done: string[] = [];
    let failed = false;
    try {
      for (const id of targets) {
        await this.storage.savedRecords.remove(id);
        done.push(id);
      }
    } catch (err) {
      failed = true;
      // Put back the original order minus the ids actually removed, keeping
      // any ids saved meanwhile.
      const removed = new Set(done);
      this._savedIds.update((list) => {
        const prior = new Set(before);
        return [...before.filter((id) => !removed.has(id)), ...list.filter((id) => !prior.has(id))];
      });
      throw err;
    } finally {
      if (done.length) {
        // Never let a reconcile failure replace the storage error.
        const reconciled = this.offline().reconcile(done);
        if (failed) await reconciled.catch(() => undefined);
        else await reconciled;
      }
    }
  }

  /**
   * Search every searchable provider plus imported tracks (matched locally on
   * title, artist, album, genre and year). A blank query returns all known
   * tracks. Results are merged into the known-track index so they can be
   * saved, added to playlists and restored in the queue.
   */
  async search(query: string, signal?: AbortSignal): Promise<Track[]> {
    if (!query.trim()) return [...this._tracks()];
    await this.loaded;
    const [remote, local] = [
      this.registry.searchAll(query, signal),
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
    const { coverPath } = track;
    if (!coverPath || !this.media) return undefined;
    const cached = this.artUrls.get(track.id);
    if (cached?.coverPath === coverPath) return cached.url;
    const url = this.media.artUrl(track);
    url.catch(() => this.artUrls.delete(track.id));
    this.artUrls.set(track.id, { coverPath, url });
    return url;
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
    await this.storage.metadataTracks.saveMany(tracks);
    const next = new Map(this._metadata());
    for (const t of tracks) next.set(t.id, t);
    this._metadata.set(next);
    for (const t of tracks) if (!this._stored().has(t.id)) this.upsert(t);
  }

  /** Forget metadata-only tracks (index entries of tracks with a file record stay). */
  async removeMetadataTracks(ids: readonly string[]): Promise<void> {
    await this.loaded;
    const gone = new Set(ids.filter((id) => this._metadata().has(id)));
    if (!gone.size) return;
    await this.forgetMetadata([...gone]);
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
   * saved are left alone. One storage write. Resolves to the newly saved ids.
   */
  async bookmarkWithoutSaving(
    entries: readonly { id: string; savedAt?: number }[],
  ): Promise<string[]> {
    await this.loaded;
    const seen = new Set(this._savedIds());
    const fresh = entries.filter((e) => !seen.has(e.id) && !!seen.add(e.id));
    if (!fresh.length) return [];
    try {
      return await this.storage.savedRecords.addMany(
        fresh.map((e) => ({ trackId: e.id, savedAt: e.savedAt })),
      );
    } finally {
      this.setSavedEntries(await this.storage.savedRecords.entries());
    }
  }

  /**
   * Bookmark every track of a playlist (never saves to the device), keeping
   * the playlist's order: its first track ends up on top of the library.
   * Already-saved tracks keep their place; ids with no known track record
   * are skipped (they could not be shown) and counted as unavailable.
   */
  async addTracksToLibrary(
    trackIds: readonly string[],
  ): Promise<{ added: number; alreadySaved: number; unavailable: number }> {
    await this.loaded;
    const map = this.trackMap();
    const saved = this.savedSet();
    const unique = [...new Set(trackIds)];
    let alreadySaved = 0;
    let unavailable = 0;
    const ids: string[] = [];
    for (const id of unique) {
      if (saved.has(id)) alreadySaved++;
      else if (!map.has(id)) unavailable++;
      else ids.push(id);
    }
    const base = Date.now();
    const added = await this.bookmarkWithoutSaving(
      ids.map((id, i) => ({ id, savedAt: base - i })),
    );
    return { added: added.length, alreadySaved, unavailable };
  }

  /** Move a bookmark to another track id, keeping its position. Never saves to the device. */
  async replaceSaved(oldId: string, newId: string): Promise<void> {
    await this.loaded;
    // Counts follow the id even when the track is not bookmarked.
    await this.playCounts.move(oldId, newId);
    if (oldId === newId || !this.isSaved(oldId)) return;
    await this.storage.savedRecords.replace(oldId, newId);
    const at = this._savedAt().get(oldId);
    if (at !== undefined) {
      this._savedAt.update((m) => {
        const next = new Map(m);
        next.delete(oldId);
        return next.set(newId, at);
      });
    }
    this._savedIds.update((ids) => {
      const seen = new Set<string>();
      return ids
        .map((id) => (id === oldId ? newId : id))
        .filter((id) => !seen.has(id) && !!seen.add(id));
    });
  }

  /**
   * Swap a remote track for `next` (a new id, e.g. a replaced source link) in
   * the library: persists `next` by metadata, moves the bookmark in place and
   * drops the old track's file record and index entry. The caller migrates
   * playlists, the queue and the rest; queue a download for `next` afterwards.
   */
  async replaceTrackId(oldId: string, next: Track): Promise<void> {
    await this.loaded;
    if (oldId === next.id) return;
    await this.addMetadataTracks([next]);
    // Also moves the play count (see `replaceSaved`).
    await this.replaceSaved(oldId, next.id);
    if (this._stored().has(oldId)) await this.dropRecord(oldId);
    if (this._metadata().has(oldId)) await this.forgetMetadata([oldId]);
    this._tracks.update((all) => all.filter((t) => t.id !== oldId));
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
    let batch: ImportedTrack[] = [];
    const flush = async () => {
      if (!batch.length) return;
      const records = batch;
      batch = [];
      try {
        await this.storeRecords(records);
        for (const r of records) imported.push(r.track);
      } catch (error) {
        for (const { track } of records) {
          await this.media?.remove(track).catch(() => 0);
          failures.push({ fileName: track.sourceFile ?? track.title, error });
        }
      }
    };
    for (const track of result.tracks) {
      batch.push({ track, filePath: track.sourceFile ?? '', importedAt });
      if (batch.length >= IMPORT_BATCH_SIZE) await flush();
    }
    await flush();
    if (imported.length || failures.length) {
      await this.sessions
        .record({
          kind: 'files',
          added: imported.length,
          skipped: 0,
          failed: failures.length,
          trackIds: imported.map((t) => t.id),
        })
        .catch(() => undefined);
    }
    return { imported, failures };
  }

  /**
   * Persist a stored file record (creates or replaces it) and update the
   * index and record map. Throws if the write fails; nothing changes then.
   */
  async storeRecord(record: ImportedTrack): Promise<void> {
    await this.storage.importedTracks.save(record);
    this.artUrls.delete(record.track.id);
    this._stored.update((m) => new Map(m).set(record.track.id, record));
    this.upsert(record.track);
  }

  /**
   * Persist several stored file records in one write and update the index
   * and record map once. Throws if the write fails; nothing changes then.
   */
  async storeRecords(records: readonly ImportedTrack[]): Promise<void> {
    if (!records.length) return;
    await this.storage.importedTracks.saveMany(records);
    for (const r of records) this.artUrls.delete(r.track.id);
    this._stored.update((m) => {
      const next = new Map(m);
      for (const r of records) next.set(r.track.id, r);
      return next;
    });
    this.upsertMany(records.map((r) => r.track));
  }

  /**
   * Delete a stored file record. Does not touch files, the index, saved
   * records or playlists: callers decide what else goes.
   */
  async dropRecord(trackId: string): Promise<void> {
    await this.storage.importedTracks.delete(trackId);
    this.artUrls.delete(trackId);
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
    await this.sessions.deleteKind('files');
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
    // Counts live in storage too: clear them so the in-memory map cannot
    // write the deleted history back on the next play. Best effort: a failure
    // here must not abort the reset.
    await this.playCounts.clear().catch(() => undefined);
    await this.storage.clearAll();
    await this.reload();
    await Promise.all([
      this.playlists().reload(),
      this.settings.reload(),
      this.sessions.reload(),
    ]);
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

  /** Delete metadata-only tracks from storage and the in-memory map. */
  private async forgetMetadata(ids: readonly string[]): Promise<void> {
    await this.storage.metadataTracks.deleteMany(ids);
    const next = new Map(this._metadata());
    for (const id of ids) next.delete(id);
    // An empty collection falls back to the legacy settings blob on the next
    // launch; empty the blob too so removed tracks do not come back.
    if (!next.size) {
      await this.storage.settings.set(SETTINGS_KEYS.metadataTracks, []);
    }
    this._metadata.set(next);
  }

  private replaceTrack(track: Track): void {
    this._tracks.update((all) => {
      const i = all.findIndex((t) => t.id === track.id);
      return i < 0 || all[i] === track ? all : replaceAt(all, i, track);
    });
  }

  /**
   * Replace the index entry for a track, or add it. Keeps the same array when
   * the entry is already this object, so re-storing a record (download status
   * writes) does not invalidate the index and everything derived from it.
   */
  private upsert(track: Track): void {
    this._tracks.update((all) => {
      const i = all.findIndex((t) => t.id === track.id);
      if (i < 0) return [...all, track];
      return all[i] === track ? all : replaceAt(all, i, track);
    });
  }

  /** {@link upsert} for several tracks in one pass (same array when nothing changes). */
  private upsertMany(tracks: readonly Track[]): void {
    this._tracks.update((all) => {
      const incoming = new Map(tracks.map((t) => [t.id, t]));
      let changed = false;
      const next = all.map((t) => {
        const u = incoming.get(t.id);
        if (!u) return t;
        incoming.delete(t.id);
        if (u === t) return t;
        changed = true;
        return u;
      });
      if (incoming.size) changed = true;
      return changed ? [...next, ...incoming.values()] : all;
    });
  }

  /** Remove tracks from the queue, playlists and saved records. */
  private async detach(ids: readonly string[]): Promise<void> {
    if (!ids.length) return;
    await this.player()?.removeTracks(ids);
    await this.playlists().removeTracksEverywhere(ids);
    await this.unsaveMany(ids);
  }

  private playlists() {
    return this.injector.get(PlaylistsStore);
  }

  /**
   * Resolved lazily: clearing or replacing a track id is rarely on a hot path,
   * and this store must build even when nothing ever counts a play.
   */
  private get playCounts(): PlayCountsStore {
    return this.injector.get(PlayCountsStore);
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
    const bundled = this._tracks().filter(
      (t) => !this.isImported(t) && !t.source,
    );
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

  /**
   * Metadata-only tracks from their collection (schema v6). When it is empty
   * the legacy settings blob is read instead (data written by an older build
   * after the migration ran) and copied into the collection, best effort, so
   * later per-id writes do not drop those tracks.
   */
  private async readMetadataTracks(): Promise<Track[]> {
    const stored = await this.storage.metadataTracks.list();
    if (stored.length) return stored;
    const blob = await this.storage.settings.get<JsonValue>(
      SETTINGS_KEYS.metadataTracks,
    );
    const legacy = Array.isArray(blob)
      ? (blob as unknown as Track[]).filter(
          (t) => !!t && typeof t.id === 'string' && !!t.id,
        )
      : [];
    if (legacy.length) {
      await this.storage.metadataTracks.saveMany(legacy).catch(() => undefined);
    }
    return legacy;
  }

  /** Replace the saved ids and their timestamps (storage order: newest first). */
  private setSavedEntries(entries: readonly SavedRecord[]): void {
    this._savedIds.set(entries.map((e) => e.trackId));
    this._savedAt.set(new Map(entries.map((e) => [e.trackId, e.savedAt])));
  }

  private async hydrate(): Promise<void> {
    this._status.set('loading');
    this._error.set(null);
    try {
      const [listed, imported, savedEntries, metaTracks] = await Promise.all([
        this.registry.listAll(),
        this.storage.importedTracks.list(),
        this.storage.savedRecords.entries(),
        this.readMetadataTracks(),
      ]);
      this._tracks.set(
        dedupe([...listed, ...imported.map((i) => i.track), ...metaTracks]),
      );
      this._stored.set(new Map(imported.map((i) => [i.track.id, i])));
      this._metadata.set(new Map(metaTracks.map((t) => [t.id, t])));
      this.setSavedEntries(savedEntries);
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

/** A copy of `items` with index `i` replaced. */
function replaceAt<T>(items: readonly T[], i: number, item: T): T[] {
  const next = [...items];
  next[i] = item;
  return next;
}

/** Same elements (by reference) in the same order. */
function sameItems<T>(a: readonly T[], b: readonly T[]): boolean {
  return a.length === b.length && a.every((item, i) => item === b[i]);
}

/** Same set of keys. */
function sameKeys(
  a: ReadonlyMap<string, unknown>,
  b: ReadonlyMap<string, unknown>,
): boolean {
  if (a.size !== b.size) return false;
  for (const key of a.keys()) if (!b.has(key)) return false;
  return true;
}
