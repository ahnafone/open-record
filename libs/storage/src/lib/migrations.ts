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
  importSessions: 'import_sessions',
  /** Tracks known by metadata only (e.g. unmatched imports), keyed by track id. Added in v6. */
  metadataTracks: 'metadata_tracks',
} as const;

/** Well-known keys in the `settings` collection. */
export const SETTINGS_KEYS = {
  /** `{ url, token }` of the self-hosted download server (no migration: new key, absent = not set up). */
  downloadServer: 'downloadServer',
  /** `{ stream, download, sameForDownloads }` audio quality levels (no migration: new key, absent = highest/highest/false). */
  audioQuality: 'audioQuality',
  /** `{ library, mobileData }` auto-download switches (no migration: new key, absent = both off). */
  autoDownload: 'autoDownload',
  /** `'data' | 'external'` where new downloads are written (no migration: new key, absent = data). */
  downloadLocation: 'downloadLocation',
  /**
   * @deprecated Legacy Track[] blob of metadata-only tracks. Since v6 they live
   * in the `metadata_tracks` collection; this key is read only by the v6
   * migration and as a fallback when that collection is empty.
   */
  metadataTracks: 'metadataTracks',
  /** Spotify import matching job (no migration: new key, absent = no job). Holds no raw Spotify payloads. */
  spotifyImport: 'spotifyImport',
  /** YouTube playlist metadata enrichment queue (no migration: new key, absent = nothing queued). Track ids and status only. */
  youtubeImport: 'youtubeImport',
  /** Account sync clocks and tombstones (no migration: new key, absent = never synced). Metadata ids and hashes only. */
  syncState: 'syncState',
} as const;

/** Removed setting (online metadata lookups); only migrations reference it. */
const LEGACY_ONLINE_METADATA_KEY = 'onlineMetadata';

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
      for (const [key, value] of await ctx.entries(
        COLLECTIONS.importedTracks,
      )) {
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
      if (!settings.some(([key]) => key === LEGACY_ONLINE_METADATA_KEY)) {
        await ctx.put(COLLECTIONS.settings, LEGACY_ONLINE_METADATA_KEY, true);
      }
    },
  },
  {
    version: 3,
    description:
      'Remove online metadata: drop the onlineMetadata setting and track enrichment/mbids fields',
    async up(ctx) {
      for (const [key, value] of await ctx.entries(
        COLLECTIONS.importedTracks,
      )) {
        const record = value as { track?: Record<string, unknown> };
        if (!record?.track) continue;
        if (!('enrichment' in record.track) && !('mbids' in record.track))
          continue;
        const track = { ...record.track };
        delete track['enrichment'];
        delete track['mbids'];
        await ctx.put(COLLECTIONS.importedTracks, key, { ...record, track });
      }
      const settings = await ctx.entries(COLLECTIONS.settings);
      if (settings.some(([key]) => key === LEGACY_ONLINE_METADATA_KEY)) {
        await ctx.delete(COLLECTIONS.settings, LEGACY_ONLINE_METADATA_KEY);
      }
    },
  },
  {
    version: 4,
    description:
      'Imported track status: backfill status "saved" on existing records (absent status means saved)',
    async up(ctx) {
      for (const [key, value] of await ctx.entries(
        COLLECTIONS.importedTracks,
      )) {
        const record = value as { status?: string } | null;
        if (!record || record.status !== undefined) continue;
        await ctx.put(COLLECTIONS.importedTracks, key, {
          ...record,
          status: 'saved',
        });
      }
    },
  },
  {
    version: 5,
    description: 'Import sessions collection (one record per import run)',
    async up(ctx) {
      await ctx.createCollection('import_sessions');
    },
  },
  {
    version: 6,
    description:
      'Metadata-only tracks move from the settings blob to their own collection',
    async up(ctx) {
      await ctx.createCollection('metadata_tracks');
      const blob = (await ctx.entries(COLLECTIONS.settings)).find(
        ([key]) => key === 'metadataTracks',
      )?.[1];
      if (!Array.isArray(blob)) return;
      for (const track of blob as Array<{ id?: unknown } | null>) {
        if (!track || typeof track !== 'object') continue;
        if (typeof track.id !== 'string' || !track.id) continue;
        await ctx.put('metadata_tracks', track.id, track);
      }
      // The blob is kept (not deleted) so an older build can still read it;
      // the app reads it only when the collection is empty.
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
