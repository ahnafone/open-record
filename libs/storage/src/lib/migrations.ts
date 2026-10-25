import { CollectionName } from './backend';

/**
 * Operations a migration may perform. Every adapter implements this so the
 * one ordered `MIGRATIONS` list runs identically on SQLite and IndexedDB.
 * Migrations must only await these operations (IndexedDB upgrade
 * transactions auto-commit if control returns to the event loop).
 */
export interface MigrationContext {
  createCollection(name: CollectionName): Promise<void>;
  deleteCollection(name: CollectionName): Promise<void>;
  /** All [key, value] pairs, in key order. */
  entries(name: CollectionName): Promise<Array<[string, unknown]>>;
  put(name: CollectionName, key: string, value: unknown): Promise<void>;
  delete(name: CollectionName, key: string): Promise<void>;
}

export interface Migration {
  /** Schema version this migration upgrades to. 1-based, contiguous. */
  version: number;
  description: string;
  up(ctx: MigrationContext): Promise<void>;
}

/**
 * Adapter hook for the runner. `apply` must run `migration.up` and record
 * `migration.version` as the schema version atomically.
 */
export interface MigrationTarget {
  readVersion(): Promise<number>;
  apply(migration: Migration, ctx: MigrationContext): Promise<void>;
  context(): MigrationContext;
}

export interface MigrationResult {
  from: number;
  to: number;
  applied: number[];
}

export const COLLECTIONS = {
  playlists: 'playlists',
  savedRecords: 'saved_records',
  importedTracks: 'imported_tracks',
  queueState: 'queue_state',
  settings: 'settings',
} as const;

/** Well-known keys in the `settings` collection. */
export const SETTINGS_KEYS = {
  /** boolean, default true: allow MusicBrainz/Cover Art Archive lookups. */
  onlineMetadata: 'onlineMetadata',
} as const;

/** Ordered schema history. Append only; never edit a shipped migration. */
export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    description: 'Initial collections',
    async up(ctx) {
      for (const name of Object.values(COLLECTIONS)) {
        await ctx.createCollection(name);
      }
    },
  },
  {
    version: 2,
    description:
      'Imported track metadata fields (sourceFile, enrichment) and the onlineMetadata setting',
    async up(ctx) {
      // Collections from v1 are reused; only data is backfilled.
      for (const [key, value] of await ctx.entries(COLLECTIONS.importedTracks)) {
        const record = value as {
          track?: Record<string, unknown>;
          filePath?: string;
        };
        if (!record?.track) continue;
        const track = { ...record.track };
        if (track['sourceFile'] === undefined && record.filePath) {
          track['sourceFile'] = record.filePath;
        }
        if (track['enrichment'] === undefined) track['enrichment'] = 'none';
        await ctx.put(COLLECTIONS.importedTracks, key, { ...record, track });
      }
      const settings = await ctx.entries(COLLECTIONS.settings);
      if (!settings.some(([key]) => key === SETTINGS_KEYS.onlineMetadata)) {
        await ctx.put(COLLECTIONS.settings, SETTINGS_KEYS.onlineMetadata, true);
      }
    },
  },
];

export function latestVersion(
  migrations: readonly Migration[] = MIGRATIONS,
): number {
  return migrations.length ? migrations[migrations.length - 1].version : 0;
}

export function validateMigrations(migrations: readonly Migration[]): void {
  migrations.forEach((m, i) => {
    if (m.version !== i + 1) {
      throw new Error(
        `Migrations must be contiguous from 1; found v${m.version} at position ${i + 1}`,
      );
    }
  });
}

/** Applies every migration newer than the stored version, in order. */
export async function runMigrations(
  target: MigrationTarget,
  migrations: readonly Migration[] = MIGRATIONS,
): Promise<MigrationResult> {
  validateMigrations(migrations);
  const from = await target.readVersion();
  const latest = latestVersion(migrations);
  if (from > latest) {
    throw new Error(
      `Stored schema v${from} is newer than supported v${latest}; refusing to downgrade`,
    );
  }
  const applied: number[] = [];
  for (const migration of migrations) {
    if (migration.version <= from) continue;
    await target.apply(migration, target.context());
    applied.push(migration.version);
  }
  return { from, to: Math.max(from, latest), applied };
}
