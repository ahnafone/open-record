import { Injectable, computed, inject, signal } from '@angular/core';
import type { Playlist, Track } from '@open-record/models';
import { StoragePort } from '@open-record/storage';
import { LibraryStore, type LoadStatus } from './library.store';

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

  /** Append tracks, skipping ids already in the playlist. */
  addTracks(id: string, trackIds: readonly string[]): Promise<Playlist> {
    return this.mutate(id, (p) => {
      const have = new Set(p.trackIds);
      const added: string[] = [];
      for (const t of trackIds) {
        if (have.has(t)) continue;
        have.add(t);
        added.push(t);
      }
      if (!added.length) return p;
      return { ...p, trackIds: [...p.trackIds, ...added] };
    });
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
  }

  private async mutate(
    id: string,
    change: (p: Playlist) => Playlist,
  ): Promise<Playlist> {
    await this.loaded;
    const before = this.playlist(id);
    if (!before) throw new Error(`Playlist "${id}" not found`);
    const changed = change(before);
    if (changed === before) return before;
    const after: Playlist = { ...changed, id, updatedAt: Date.now() };
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
