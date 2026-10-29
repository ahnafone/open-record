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
  /** Ids waiting in the "Play next" list, in play order. Absent when empty. */
  playNextIds?: string[];
}

export interface SavedRecord {
  trackId: string;
  /** Epoch milliseconds. */
  savedAt: number;
}

/**
 * Play count for one track, keyed by track id. Device-local bookkeeping
 * lives next to the total so guest plays can be uploaded later.
 */
export interface PlayCountRecord {
  trackId: string;
  /**
   * Plays known for this track: the device's own while offline, the account
   * total after a sync. Never lower than this device's plays (it includes
   * `pending`).
   */
  count: number;
  /** Plays recorded here and not yet uploaded; 0 for local-only tracks. */
  pending: number;
  /** Epoch milliseconds. */
  firstPlayedAt: number;
  /** Epoch milliseconds. */
  lastPlayedAt: number;
  /**
   * Metadata snapshot so a count survives independently of the library
   * (streamed tracks that were never saved). Never synced as-is.
   */
  track?: Track;
}

export interface PlayCountsRepository {
  /** Most recently played first. */
  list(): Promise<PlayCountRecord[]>;
  get(trackId: string): Promise<PlayCountRecord | undefined>;
  save(record: PlayCountRecord): Promise<void>;
  /** Insert or replace several records in one write. */
  saveMany(records: readonly PlayCountRecord[]): Promise<void>;
  /**
   * Re-key a count to another track id (e.g. a replaced source URL).
   * When both exist their counts and pending are summed, first/last
   * played are the earliest/latest known values (0 means unknown and never
   * wins), and `track` prefers the new record's then the old one's. Resolves
   * the merged record, or undefined when `oldId` is not counted (or is
   * already `newId`).
   */
  replace(oldId: string, newId: string): Promise<PlayCountRecord | undefined>;
  clear(): Promise<void>;
}

/**
 * Lifecycle of a track's on-device audio copy.
 * - `saving`: record persisted, file download in progress or queued.
 * - `saved`: audio file is on device and playable offline.
 * - `failed`: the download failed; `error` says why.
 * Records written before schema v4 have no status and are treated as `saved`.
 */
export type ImportedTrackStatus = 'saving' | 'saved' | 'failed';

/** A user-imported or saved file: its metadata plus where the audio lives on device. */
export interface ImportedTrack {
  track: Track;
  /**
   * Filesystem path / URI of the copied audio file. Empty string while the
   * file is not yet downloaded (`status` `saving` or `failed`).
   */
  filePath: string;
  /** Epoch milliseconds. */
  importedAt: number;
  /** Absent on records written before schema v4; treat absent as `saved`. */
  status?: ImportedTrackStatus;
  /** Human-readable reason, set when `status` is `failed`. */
  error?: string;
  /** Failed download attempts so far (no migration: absent = 0). */
  attempts?: number;
  /** Epoch ms before which a failed download is not retried (no migration: absent = retry now). */
  retryAt?: number;
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
  /** Bookmarks with their savedAt, most recently saved first. */
  entries(): Promise<SavedRecord[]>;
  has(trackId: string): Promise<boolean>;
  /** No-op when already saved. `savedAt` (epoch ms) defaults to now. */
  add(trackId: string, savedAt?: number): Promise<void>;
  /**
   * Bookmark several tracks in one write. Ids already saved (or repeated)
   * are skipped. Resolves to the ids that were newly saved, in input order.
   */
  addMany(
    entries: readonly { trackId: string; savedAt?: number }[],
  ): Promise<string[]>;
  remove(trackId: string): Promise<void>;
  /** Re-keys a bookmark to another track id, keeping its savedAt (no-op when `oldId` is not saved). */
  replace(oldId: string, newId: string): Promise<void>;
}

export interface ImportedTracksRepository {
  /** Oldest import first. */
  list(): Promise<ImportedTrack[]>;
  get(trackId: string): Promise<ImportedTrack | undefined>;
  save(imported: ImportedTrack): Promise<void>;
  /** Create or replace several records in one write (all or nothing where supported). */
  saveMany(records: readonly ImportedTrack[]): Promise<void>;
  delete(trackId: string): Promise<void>;
  /** Delete every imported-track record. */
  clear(): Promise<void>;
}

export type ImportSessionKind = 'files' | 'spotify' | 'youtube';

/**
 * One import run (audio files, a Spotify export or a public YouTube
 * playlist). Holds counts and track ids only; never raw third-party payloads.
 */
export interface ImportSession {
  id: string;
  kind: ImportSessionKind;
  /** Epoch milliseconds. */
  createdAt: number;
  label: string;
  added: number;
  skipped: number;
  failed: number;
  /** Track ids added or referenced by the run, in import order. */
  trackIds: string[];
}

export interface ImportSessionsRepository {
  /** Newest first. */
  list(): Promise<ImportSession[]>;
  get(id: string): Promise<ImportSession | undefined>;
  save(session: ImportSession): Promise<void>;
  delete(id: string): Promise<void>;
  clear(): Promise<void>;
}

/** Tracks known by metadata only (no stored file), keyed by track id. */
export interface MetadataTracksRepository {
  /** In key order. */
  list(): Promise<Track[]>;
  get(id: string): Promise<Track | undefined>;
  /** Insert or replace several tracks in one write. */
  saveMany(tracks: readonly Track[]): Promise<void>;
  deleteMany(ids: readonly string[]): Promise<void>;
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
  abstract readonly playCounts: PlayCountsRepository;
  abstract readonly importedTracks: ImportedTracksRepository;
  abstract readonly queueState: QueueStateRepository;
  abstract readonly settings: SettingsRepository;
  abstract readonly importSessions: ImportSessionsRepository;
  abstract readonly metadataTracks: MetadataTracksRepository;
  /** Delete every record in every collection (keeps the schema). */
  abstract clearAll(): Promise<void>;
  /** Resolves once the store is open and migrated; rejects on failure. */
  abstract ready(): Promise<void>;
  abstract close(): Promise<void>;
}
