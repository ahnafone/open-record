import { Playlist, Track } from '@open-record/models';
import { JsonValue } from './backend';

export type RepeatMode = 'off' | 'all' | 'one';

export interface QueueState {
  trackIds: string[];
  /** Index into `trackIds` of the current track; -1 when empty. */
  index: number;
  positionSec: number;
  shuffle: boolean;
  repeat: RepeatMode;
}

export interface SavedRecord {
  trackId: string;
  /** Epoch milliseconds. */
  savedAt: number;
}

/** A user-imported file: its metadata plus where the audio lives on device. */
export interface ImportedTrack {
  track: Track;
  /** Filesystem path / URI of the copied audio file. */
  filePath: string;
  /** Epoch milliseconds. */
  importedAt: number;
}

export interface PlaylistRepository {
  /** Oldest first (by `createdAt`). */
  list(): Promise<Playlist[]>;
  get(id: string): Promise<Playlist | undefined>;
  save(playlist: Playlist): Promise<void>;
  delete(id: string): Promise<void>;
}

export interface SavedRecordsRepository {
  /** Bookmarked track ids, most recently saved first. */
  list(): Promise<string[]>;
  has(trackId: string): Promise<boolean>;
  add(trackId: string): Promise<void>;
  remove(trackId: string): Promise<void>;
}

export interface ImportedTracksRepository {
  /** Oldest import first. */
  list(): Promise<ImportedTrack[]>;
  get(trackId: string): Promise<ImportedTrack | undefined>;
  save(imported: ImportedTrack): Promise<void>;
  delete(trackId: string): Promise<void>;
  /** Delete every imported-track record. */
  clear(): Promise<void>;
}

export interface QueueStateRepository {
  get(): Promise<QueueState | undefined>;
  save(state: QueueState): Promise<void>;
  clear(): Promise<void>;
}

export interface SettingsRepository {
  get<T extends JsonValue>(key: string): Promise<T | undefined>;
  set(key: string, value: JsonValue): Promise<void>;
  delete(key: string): Promise<void>;
}

/**
 * Persistence port. Inject this; never an adapter. Adapters open lazily and
 * run pending migrations before the first read or write.
 */
export abstract class StoragePort {
  abstract readonly playlists: PlaylistRepository;
  abstract readonly savedRecords: SavedRecordsRepository;
  abstract readonly importedTracks: ImportedTracksRepository;
  abstract readonly queueState: QueueStateRepository;
  abstract readonly settings: SettingsRepository;
  /** Delete every record in every collection (keeps the schema). */
  abstract clearAll(): Promise<void>;
  /** Resolves once the store is open and migrated; rejects on failure. */
  abstract ready(): Promise<void>;
  abstract close(): Promise<void>;
}
