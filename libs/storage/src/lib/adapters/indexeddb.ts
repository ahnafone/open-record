import { IDBPDatabase, IDBPTransaction, openDB } from 'idb';
import {
  CollectionName,
  StorageBackend,
  assertCollectionName,
} from '../backend';
import { DocumentStorage } from '../document-storage';
import {
  Migration,
  MigrationContext,
  MigrationTarget,
  MIGRATIONS,
  latestVersion,
  runMigrations,
  validateMigrations,
} from '../migrations';

export const DEFAULT_DB_NAME = 'open-record';

type UpgradeTx = IDBPTransaction<unknown, string[], 'versionchange'>;

/**
 * Runs migrations inside the IndexedDB upgrade transaction. The IndexedDB
 * database version is the schema version, so `apply` only runs `up`; the
 * whole upgrade commits or aborts as one transaction.
 */
class IdbUpgradeTarget implements MigrationTarget {
  constructor(
    private readonly db: IDBPDatabase,
    private readonly tx: UpgradeTx,
    private readonly oldVersion: number,
  ) {}

  async readVersion(): Promise<number> {
    return this.oldVersion;
  }

  context(): MigrationContext {
    const { db, tx } = this;
    return {
      createCollection: async (name) => {
        assertCollectionName(name);
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name);
      },
      deleteCollection: async (name) => {
        if (db.objectStoreNames.contains(name)) db.deleteObjectStore(name);
      },
      entries: async (name) => {
        const store = tx.objectStore(name);
        const [keys, values] = await Promise.all([
          store.getAllKeys(),
          store.getAll(),
        ]);
        return keys.map((k, i) => [String(k), values[i]] as [string, unknown]);
      },
      put: async (name, key, value) => {
        await tx.objectStore(name).put(value, key);
      },
      delete: async (name, key) => {
        await tx.objectStore(name).delete(key);
      },
    };
  }

  async apply(migration: Migration, ctx: MigrationContext): Promise<void> {
    await migration.up(ctx);
  }
}

class IndexedDbBackend implements StorageBackend {
  constructor(private readonly db: IDBPDatabase) {}

  async get<T>(
    collection: CollectionName,
    key: string,
  ): Promise<T | undefined> {
    return (await this.db.get(collection, key)) as T | undefined;
  }

  async getAll<T>(collection: CollectionName): Promise<T[]> {
    return (await this.db.getAll(collection)) as T[];
  }

  async put<T>(
    collection: CollectionName,
    key: string,
    value: T,
  ): Promise<void> {
    await this.db.put(collection, value, key);
  }

  async delete(collection: CollectionName, key: string): Promise<void> {
    await this.db.delete(collection, key);
  }

  async clear(collection: CollectionName): Promise<void> {
    await this.db.clear(collection);
  }

  async close(): Promise<void> {
    this.db.close();
  }
}

export async function openIndexedDbBackend(
  name = DEFAULT_DB_NAME,
  migrations: readonly Migration[] = MIGRATIONS,
): Promise<StorageBackend> {
  validateMigrations(migrations);
  let migrationError: unknown;
  let db: IDBPDatabase;
  try {
    db = await openDB(name, Math.max(1, latestVersion(migrations)), {
      upgrade(upgradeDb, oldVersion, _newVersion, tx) {
        const target = new IdbUpgradeTarget(upgradeDb, tx, oldVersion);
        runMigrations(target, migrations).catch((err) => {
          migrationError = err;
          tx.abort();
        });
      },
    });
  } catch (err) {
    // A failed migration aborts the upgrade; surface the real cause.
    throw migrationError ?? err;
  }
  // Another tab upgraded the schema: let it proceed, reopen on next launch.
  db.addEventListener('versionchange', () => db.close());
  return new IndexedDbBackend(db);
}

/** `StoragePort` backed by IndexedDB (web). */
export function createIndexedDbStorage(
  name = DEFAULT_DB_NAME,
  migrations: readonly Migration[] = MIGRATIONS,
): DocumentStorage {
  return new DocumentStorage(() => openIndexedDbBackend(name, migrations));
}
