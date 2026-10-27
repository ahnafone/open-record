// Public API for @open-record/storage.
export type { CollectionName, JsonValue, StorageBackend } from './lib/backend';
export {
  COLLECTIONS,
  MIGRATIONS,
  SETTINGS_KEYS,
  latestVersion,
  runMigrations,
  validateMigrations,
} from './lib/migrations';
export type {
  Migration,
  MigrationContext,
  MigrationResult,
  MigrationTarget,
} from './lib/migrations';
export { StoragePort } from './lib/storage-port';
export type {
  ImportedTrack,
  ImportedTracksRepository,
  ImportSession,
  ImportSessionKind,
  ImportSessionsRepository,
  MetadataTracksRepository,
  PlaylistRepository,
  QueueState,
  QueueStateRepository,
  RepeatMode,
  SavedRecord,
  SavedRecordsRepository,
  SettingsRepository,
} from './lib/storage-port';
export { DocumentStorage } from './lib/document-storage';
export { InMemoryBackend, createInMemoryStorage } from './lib/adapters/memory';
export { createIndexedDbStorage } from './lib/adapters/indexeddb';
export { SqliteBackend, createSqliteStorage } from './lib/adapters/sqlite';
export type { SqlConnection } from './lib/adapters/sqlite';
export { createPlatformStorage, provideStorage } from './lib/provide-storage';
export type { StorageOptions } from './lib/provide-storage';
