import { Playlist } from '@open-record/models';
import { JsonValue, StorageBackend } from './backend';
import { COLLECTIONS } from './migrations';
import {
  ImportedTrack,
  ImportedTracksRepository,
  PlaylistRepository,
  QueueState,
  QueueStateRepository,
  SavedRecord,
  SavedRecordsRepository,
  SettingsRepository,
  StoragePort,
} from './storage-port';

const QUEUE_KEY = 'current';

/**
 * `StoragePort` implemented once over any `StorageBackend`. The backend is
 * opened (and migrated) on first use via `open`.
 */
export class DocumentStorage extends StoragePort {
  private backend?: Promise<StorageBackend>;

  constructor(private readonly open: () => Promise<StorageBackend>) {
    super();
  }

  private db(): Promise<StorageBackend> {
    if (!this.backend) {
      this.backend = this.open();
      // Allow a retry after a failed open instead of caching the rejection.
      this.backend.catch(() => (this.backend = undefined));
    }
    return this.backend;
  }

  async ready(): Promise<void> {
    await this.db();
  }

  async close(): Promise<void> {
    const pending = this.backend;
    this.backend = undefined;
    if (pending) await (await pending).close();
  }

  async clearAll(): Promise<void> {
    const db = await this.db();
    for (const name of Object.values(COLLECTIONS)) await db.clear(name);
  }

  readonly playlists: PlaylistRepository = {
    list: async () => {
      const all = await (
        await this.db()
      ).getAll<Playlist>(COLLECTIONS.playlists);
      return all.sort((a, b) => a.createdAt - b.createdAt);
    },
    get: async (id) =>
      (await this.db()).get<Playlist>(COLLECTIONS.playlists, id),
    save: async (playlist) =>
      (await this.db()).put(COLLECTIONS.playlists, playlist.id, playlist),
    delete: async (id) => (await this.db()).delete(COLLECTIONS.playlists, id),
  };

  readonly savedRecords: SavedRecordsRepository = {
    list: async () => {
      const all = await (
        await this.db()
      ).getAll<SavedRecord>(COLLECTIONS.savedRecords);
      return all.sort((a, b) => b.savedAt - a.savedAt).map((r) => r.trackId);
    },
    has: async (trackId) =>
      (await (await this.db()).get(COLLECTIONS.savedRecords, trackId)) !==
      undefined,
    add: async (trackId, savedAt) => {
      const db = await this.db();
      if ((await db.get(COLLECTIONS.savedRecords, trackId)) !== undefined) {
        return;
      }
      const record: SavedRecord = { trackId, savedAt: savedAt ?? Date.now() };
      await db.put(COLLECTIONS.savedRecords, trackId, record);
    },
    remove: async (trackId) =>
      (await this.db()).delete(COLLECTIONS.savedRecords, trackId),
    replace: async (oldId, newId) => {
      const db = await this.db();
      const old = await db.get<SavedRecord>(COLLECTIONS.savedRecords, oldId);
      if (!old || oldId === newId) return;
      await db.delete(COLLECTIONS.savedRecords, oldId);
      if ((await db.get(COLLECTIONS.savedRecords, newId)) === undefined) {
        const record: SavedRecord = { trackId: newId, savedAt: old.savedAt };
        await db.put(COLLECTIONS.savedRecords, newId, record);
      }
    },
  };

  readonly importedTracks: ImportedTracksRepository = {
    list: async () => {
      const all = await (
        await this.db()
      ).getAll<ImportedTrack>(COLLECTIONS.importedTracks);
      return all.sort((a, b) => a.importedAt - b.importedAt);
    },
    get: async (trackId) =>
      (await this.db()).get<ImportedTrack>(COLLECTIONS.importedTracks, trackId),
    save: async (imported) =>
      (await this.db()).put(
        COLLECTIONS.importedTracks,
        imported.track.id,
        imported,
      ),
    delete: async (trackId) =>
      (await this.db()).delete(COLLECTIONS.importedTracks, trackId),
    clear: async () => (await this.db()).clear(COLLECTIONS.importedTracks),
  };

  readonly queueState: QueueStateRepository = {
    get: async () =>
      (await this.db()).get<QueueState>(COLLECTIONS.queueState, QUEUE_KEY),
    save: async (state) =>
      (await this.db()).put(COLLECTIONS.queueState, QUEUE_KEY, state),
    clear: async () =>
      (await this.db()).delete(COLLECTIONS.queueState, QUEUE_KEY),
  };

  readonly settings: SettingsRepository = {
    get: async <T extends JsonValue>(key: string) =>
      (await this.db()).get<T>(COLLECTIONS.settings, key),
    set: async (key: string, value: JsonValue) =>
      (await this.db()).put(COLLECTIONS.settings, key, value),
    delete: async (key: string) =>
      (await this.db()).delete(COLLECTIONS.settings, key),
  };
}
