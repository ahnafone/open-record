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
  runMigrations,
} from '../migrations';

type Tables = Map<CollectionName, Map<string, unknown>>;

/**
 * Non-persistent store with the same semantics as the real adapters
 * (values are cloned, missing collections throw). For tests and previews.
 */
export class InMemoryBackend implements StorageBackend, MigrationTarget {
  version = 0;
  tables: Tables = new Map();

  private table(name: CollectionName): Map<string, unknown> {
    const table = this.tables.get(name);
    if (!table) throw new Error(`No such collection: ${name}`);
    return table;
  }

  async get<T>(
    collection: CollectionName,
    key: string,
  ): Promise<T | undefined> {
    const value = this.table(collection).get(key);
    return value === undefined ? undefined : (structuredClone(value) as T);
  }

  async getAll<T>(collection: CollectionName): Promise<T[]> {
    return [...this.table(collection).entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([, v]) => structuredClone(v) as T);
  }

  async put<T>(
    collection: CollectionName,
    key: string,
    value: T,
  ): Promise<void> {
    this.table(collection).set(key, structuredClone(value));
  }

  async putMany<T>(
    collection: CollectionName,
    entries: readonly (readonly [string, T])[],
  ): Promise<void> {
    const table = this.table(collection);
    for (const [key, value] of entries) table.set(key, structuredClone(value));
  }

  async delete(collection: CollectionName, key: string): Promise<void> {
    this.table(collection).delete(key);
  }

  async clear(collection: CollectionName): Promise<void> {
    this.table(collection).clear();
  }

  async close(): Promise<void> {
    // Nothing to release.
  }

  // MigrationTarget
  async readVersion(): Promise<number> {
    return this.version;
  }

  context(): MigrationContext {
    return {
      createCollection: async (name) => {
        assertCollectionName(name);
        if (!this.tables.has(name)) this.tables.set(name, new Map());
      },
      deleteCollection: async (name) => {
        this.tables.delete(name);
      },
      entries: async (name) =>
        [...this.table(name).entries()]
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([k, v]) => [k, structuredClone(v)] as [string, unknown]),
      put: (name, key, value) => this.put(name, key, value),
      delete: (name, key) => this.delete(name, key),
    };
  }

  async apply(migration: Migration, ctx: MigrationContext): Promise<void> {
    const snapshot = new Map(
      [...this.tables].map(([k, t]) => [k, new Map(t)] as const),
    );
    try {
      await migration.up(ctx);
      this.version = migration.version;
    } catch (err) {
      this.tables = snapshot;
      throw err;
    }
  }
}

/** A migrated, non-persistent `StoragePort`. */
export function createInMemoryStorage(
  migrations: readonly Migration[] = MIGRATIONS,
): DocumentStorage {
  return new DocumentStorage(async () => {
    const backend = new InMemoryBackend();
    await runMigrations(backend, migrations);
    return backend;
  });
}
