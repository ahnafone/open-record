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

/**
 * Thrown when the database was upgraded to a newer schema version (by another
 * tab or a newer build) than this build knows. Recovery needs a reload, so
 * reopening keeps failing with this error until then.
 */
export class StorageUpgradedError extends Error {
  constructor() {
    super('Storage was upgraded in another tab — reload to continue');
    this.name = 'StorageUpgradedError';
  }
}

/**
 * Holds one live connection at a time. `versionchange` fires for two cases:
 * - the database was deleted: the next operation reopens and recreates it;
 * - another tab upgraded it to a higher version: reopening with this build's
 *   version fails with `VersionError`, surfaced as `StorageUpgradedError`.
 * Concurrent operations share a single reopen, and a failed reopen is not
 * cached, so the next call retries.
 */
class IndexedDbBackend implements StorageBackend {
  private current?: IDBPDatabase;
  private reopening?: Promise<IDBPDatabase>;
  private closed = false;

  constructor(
    private readonly connect: () => Promise<IDBPDatabase>,
    initial: IDBPDatabase,
  ) {
    this.adopt(initial);
  }

  private adopt(db: IDBPDatabase): void {
    this.current = db;
    db.addEventListener('versionchange', () => {
      db.close();
      if (this.current === db) this.current = undefined;
    });
  }

  private async db(): Promise<IDBPDatabase> {
    if (this.closed) throw new Error('IndexedDB backend is closed');
    if (this.current) return this.current;
    this.reopening ??= this.connect()
      .then((db) => {
        if (this.closed) {
          db.close();
          throw new Error('IndexedDB backend is closed');
        }
        this.adopt(db);
        return db;
      })
      .finally(() => {
        this.reopening = undefined;
      });
    return this.reopening;
  }

  async get<T>(
    collection: CollectionName,
    key: string,
  ): Promise<T | undefined> {
    return (await (await this.db()).get(collection, key)) as T | undefined;
  }

  async getAll<T>(collection: CollectionName): Promise<T[]> {
    return (await (await this.db()).getAll(collection)) as T[];
  }

  async put<T>(
    collection: CollectionName,
    key: string,
    value: T,
  ): Promise<void> {
    await (await this.db()).put(collection, value, key);
  }

  async putMany<T>(
    collection: CollectionName,
    entries: readonly (readonly [string, T])[],
  ): Promise<void> {
    if (!entries.length) return;
    const tx = (await this.db()).transaction(collection, 'readwrite');
    for (const [key, value] of entries) void tx.store.put(value, key);
    await tx.done;
  }

  async delete(collection: CollectionName, key: string): Promise<void> {
    await (await this.db()).delete(collection, key);
  }

  async clear(collection: CollectionName): Promise<void> {
    await (await this.db()).clear(collection);
  }

  async close(): Promise<void> {
    this.closed = true;
    const db = this.current;
    this.current = undefined;
    db?.close();
  }
}

export async function openIndexedDbBackend(
  name = DEFAULT_DB_NAME,
  migrations: readonly Migration[] = MIGRATIONS,
): Promise<StorageBackend> {
  validateMigrations(migrations);
  const connect = async (): Promise<IDBPDatabase> => {
    let migrationError: unknown;
    try {
      return await openDB(name, Math.max(1, latestVersion(migrations)), {
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
      if (migrationError) throw migrationError;
      // DOMException (browsers) and fake-indexeddb both carry `name`.
      if ((err as { name?: unknown } | null)?.name === 'VersionError') {
        throw new StorageUpgradedError();
      }
      throw err;
    }
  };
  return new IndexedDbBackend(connect, await connect());
}

/** `StoragePort` backed by IndexedDB (web). */
export function createIndexedDbStorage(
  name = DEFAULT_DB_NAME,
  migrations: readonly Migration[] = MIGRATIONS,
): DocumentStorage {
  return new DocumentStorage(() => openIndexedDbBackend(name, migrations));
}
