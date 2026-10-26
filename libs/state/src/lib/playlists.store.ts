import { Injectable, computed, inject, signal } from '@angular/core';
import type { Playlist, Track } from '@open-record/models';
import { StoragePort } from '@open-record/storage';
import { LibraryStore, type LoadStatus } from './library.store';
import { OfflineStore } from './offline.store';

export type PlaylistVisibility = Playlist['visibility'];

export const PLAYLIST_NAME_MAX = 80;

/**
 * The user's playlists. Hydrates from storage on construction. Every mutation
 * updates the signal first and persists; a failed write rolls that playlist
 * back and rethrows so the UI can show an error toast.
 */
@Injectable({ providedIn: 'root' })
export class PlaylistsStore {
  private readonly storage = inject(StoragePort);
  private readonly library = inject(LibraryStore);
  private readonly offline = inject(OfflineStore);

  private readonly _playlists = signal<readonly Playlist[]>([]);
  private readonly _status = signal<LoadStatus>('loading');
  private readonly _error = signal<string | null>(null);

  /** Oldest first. */
  readonly playlists = this._playlists.asReadonly();
  readonly status = this._status.asReadonly();
  readonly error = this._error.asReadonly();
  private readonly byIdMap = computed(
    () => new Map(this._playlists().map((p) => [p.id, p])),
  );

  private readonly loaded: Promise<void>;

  constructor() {
    this.loaded = this.hydrate();
  }

  ready(): Promise<void> {
    return this.loaded;
  }

  /** Reactive lookup. */
  playlist(id: string): Playlist | undefined {
    return this.byIdMap().get(id);
  }

  /** Reactive: the playlist's tracks that resolve in the library, in order. */
  tracksOf(id: string): Track[] {
    const playlist = this.playlist(id);
    return playlist ? this.library.resolveIds(playlist.trackIds) : [];
  }

  /** Reactive: when the track was added to the playlist, if known (epoch ms). */
  addedAtOf(playlistId: string, trackId: string): number | undefined {
    return this.playlist(playlistId)?.addedAt?.[trackId];
  }

  async create(
    name: string,
    visibility: PlaylistVisibility = 'private',
  ): Promise<Playlist> {
    await this.loaded;
    const now = Date.now();
    const playlist: Playlist = {
      id: newId(),
      name: validName(name),
      visibility,
      trackIds: [],
      createdAt: now,
      updatedAt: now,
    };
    this._playlists.update((all) => [...all, playlist]);
    try {
      await this.storage.playlists.save(playlist);
    } catch (err) {
      this._playlists.update((all) => all.filter((p) => p.id !== playlist.id));
      throw err;
    }
    return playlist;
  }

  rename(id: string, name: string): Promise<Playlist> {
    const trimmed = validName(name);
    return this.mutate(id, (p) => ({ ...p, name: trimmed }));
  }

  setVisibility(id: string, visibility: PlaylistVisibility): Promise<Playlist> {
    return this.mutate(id, (p) => ({ ...p, visibility }));
  }

  /** Keep every track of the playlist saved on the device (auto-download). */
  setAutoDownload(id: string, on: boolean): Promise<Playlist> {
    return this.mutate(id, (p) => {
      if (!!p.autoDownload === on) return p;
      const next: Playlist = { ...p };
      if (on) next.autoDownload = true;
      else delete next.autoDownload;
      return next;
    });
  }

  /**
   * Append tracks, skipping ids already in the playlist. Full `Track`
   * objects are remembered first; remote tracks are then saved to the device
   * in the background (adding never waits for the download).
   */
  async addTracks(
    id: string,
    tracks: readonly (string | Track)[],
  ): Promise<Playlist> {
    const ids = tracks.map((t) => {
      if (typeof t !== 'string') this.library.remember([t]);
      return typeof t === 'string' ? t : t.id;
    });
    const before = this.playlist(id);
    const result = await this.mutate(id, (p) => {
      const have = new Set(p.trackIds);
      const added: string[] = [];
      for (const t of ids) {
        if (have.has(t)) continue;
        have.add(t);
        added.push(t);
      }
      if (!added.length) return p;
      const now = Date.now();
      const addedAt = { ...p.addedAt };
      for (const t of added) addedAt[t] = now;
      return { ...p, trackIds: [...p.trackIds, ...added], addedAt };
    });
    const newlyAdded = result.trackIds.filter(
      (t) => !before?.trackIds.includes(t),
    );
    for (const trackId of newlyAdded) {
      const track = this.library.track(trackId);
      if (track) await this.offline.ensureSaved(track);
    }
    return result;
  }

  /**
   * Create a playlist from tracks already in the library index without
   * saving any of them to the device (imports: tracks stay metadata-only
   * until matched or downloaded). Repeated ids are dropped. `addedAt` gives
   * known add times (epoch ms, aligned with `trackIds`); missing or invalid
   * entries fall back to now.
   */
  async createWithTracks(
    name: string,
    trackIds: readonly string[],
    addedAt: readonly (number | undefined)[] = [],
  ): Promise<Playlist> {
    const created = await this.create(name);
    const ids = [...new Set(trackIds)];
    if (!ids.length) return created;
    const now = Date.now();
    const times: Record<string, number> = {};
    trackIds.forEach((id, i) => {
      if (id in times) return;
      const at = addedAt[i];
      times[id] = at !== undefined && Number.isFinite(at) && at > 0 ? at : now;
    });
    return this.mutate(created.id, (p) => ({
      ...p,
      trackIds: ids,
      addedAt: times,
    }));
  }

  /**
   * Swap a track id for another in every playlist, keeping its position
   * (a repeat of `newId` is dropped). Never saves to the device.
   */
  async replaceTrackEverywhere(oldId: string, newId: string): Promise<void> {
    await this.loaded;
    if (oldId === newId) return;
    const affected = this._playlists().filter((p) =>
      p.trackIds.includes(oldId),
    );
    for (const p of affected) {
      await this.mutate(
        p.id,
        (pl) => {
          const seen = new Set<string>();
          const trackIds = pl.trackIds
            .map((t) => (t === oldId ? newId : t))
            .filter((t) => !seen.has(t) && !!seen.add(t));
          const addedAt = { ...pl.addedAt };
          if (oldId in addedAt && !(newId in addedAt))
            addedAt[newId] = addedAt[oldId];
          return { ...pl, trackIds, addedAt };
        },
        false,
      );
    }
  }

  removeTrack(id: string, trackId: string): Promise<Playlist> {
    return this.mutate(id, (p) => ({
      ...p,
      trackIds: p.trackIds.filter((t) => t !== trackId),
    }));
  }

  /** Move a track from one position to another. */
  moveTrack(id: string, from: number, to: number): Promise<Playlist> {
    return this.mutate(id, (p) => {
      const ids = [...p.trackIds];
      if (from < 0 || from >= ids.length) return p;
      const [moved] = ids.splice(from, 1);
      ids.splice(Math.min(Math.max(to, 0), ids.length), 0, moved);
      return { ...p, trackIds: ids };
    });
  }

  /** Remove the given track ids from every playlist (used when tracks are deleted). */
  async removeTracksEverywhere(trackIds: Iterable<string>): Promise<void> {
    await this.loaded;
    const gone = new Set(trackIds);
    if (!gone.size) return;
    const affected = this._playlists().filter((p) =>
      p.trackIds.some((t) => gone.has(t)),
    );
    for (const p of affected) {
      await this.mutate(p.id, (pl) => ({
        ...pl,
        trackIds: pl.trackIds.filter((t) => !gone.has(t)),
      }));
    }
  }

  /** Reload playlists from storage (e.g. after a full reset). */
  async reload(): Promise<void> {
    await this.loaded;
    await this.hydrate();
  }

  async delete(id: string): Promise<void> {
    await this.loaded;
    const index = this._playlists().findIndex((p) => p.id === id);
    if (index < 0) return;
    const removed = this._playlists()[index];
    this._playlists.update((all) => all.filter((p) => p.id !== id));
    try {
      await this.storage.playlists.delete(id);
    } catch (err) {
      this._playlists.update((all) => {
        const next = [...all];
        next.splice(Math.min(index, next.length), 0, removed);
        return next;
      });
      throw err;
    }
    await this.offline.reconcile();
  }

  /**
   * Insert or replace a playlist from the account's cloud copy, keeping its
   * clocks (no `updatedAt` bump) and never saving tracks to the device
   * (auto-download playlists are picked up by `AutoDownloadStore`).
   */
  async applySynced(playlist: Playlist): Promise<void> {
    await this.loaded;
    const before = this.playlist(playlist.id);
    const next = withPrunedAddedAt({
      ...playlist,
      trackIds: [...playlist.trackIds],
    });
    if (!next.autoDownload) delete next.autoDownload;
    const put = (p: Playlist | undefined) =>
      this._playlists.update((all) => {
        const rest = all.filter((x) => x.id !== playlist.id);
        if (!p) return rest;
        return before ? all.map((x) => (x.id === p.id ? p : x)) : [...rest, p];
      });
    put(next);
    try {
      await this.storage.playlists.save(next);
    } catch (err) {
      put(before);
      throw err;
    }
    if (before?.trackIds.some((t) => !next.trackIds.includes(t)))
      await this.offline.reconcile();
  }

  private async mutate(
    id: string,
    change: (p: Playlist) => Playlist,
    reconcile = true,
  ): Promise<Playlist> {
    await this.loaded;
    const before = this.playlist(id);
    if (!before) throw new Error(`Playlist "${id}" not found`);
    const changed = change(before);
    if (changed === before) return before;
    // Entries for tracks no longer in the playlist are dropped here.
    const after = withPrunedAddedAt({ ...changed, id, updatedAt: Date.now() });
    const replace = (with_: Playlist) =>
      this._playlists.update((all) =>
        all.map((p) => (p.id === id ? with_ : p)),
      );
    replace(after);
    try {
      await this.storage.playlists.save(after);
    } catch (err) {
      replace(before);
      throw err;
    }
    const dropped = before.trackIds.some((t) => !after.trackIds.includes(t));
    if (dropped && reconcile) await this.offline.reconcile();
    return after;
  }

  private async hydrate(): Promise<void> {
    this._status.set('loading');
    this._error.set(null);
    try {
      this._playlists.set(await this.storage.playlists.list());
      this._status.set('ready');
    } catch (err) {
      this._error.set(
        err instanceof Error ? err.message : 'Could not load playlists.',
      );
      this._status.set('error');
    }
  }
}

/** Copy with `addedAt` limited to tracks still in the playlist (absent when empty). */
function withPrunedAddedAt(p: Playlist): Playlist {
  const next: Playlist = { ...p };
  delete next.addedAt;
  if (!p.addedAt) return next;
  const kept: Record<string, number> = {};
  for (const id of p.trackIds) {
    const at = p.addedAt[id];
    if (typeof at === 'number' && Number.isFinite(at)) kept[id] = at;
  }
  if (Object.keys(kept).length) next.addedAt = kept;
  return next;
}

function validName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) throw new Error('Playlist name is required.');
  if (trimmed.length > PLAYLIST_NAME_MAX) {
    throw new Error(
      `Playlist name must be ${PLAYLIST_NAME_MAX} characters or fewer.`,
    );
  }
  return trimmed;
}

function newId(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  return `pl-${uuid ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`}`;
}
