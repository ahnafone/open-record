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

export const DEFAULT_SQLITE_NAME = 'open-record';

/** The subset of `SQLiteDBConnection` this adapter uses. */
export interface SqlConnection {
  query(statement: string, values?: unknown[]): Promise<{ values?: unknown[] }>;
  run(
    statement: string,
    values?: unknown[],
    transaction?: boolean,
  ): Promise<unknown>;
  execute(statements: string, transaction?: boolean): Promise<unknown>;
  beginTransaction(): Promise<unknown>;
  commitTransaction(): Promise<unknown>;
  rollbackTransaction(): Promise<unknown>;
  close(): Promise<void>;
}

interface Row {
  key: string;
  value: string;
}

function table(name: CollectionName): string {
  assertCollectionName(name);
  return `"${name}"`;
}

/**
 * Each collection is a `(key TEXT PRIMARY KEY, value TEXT)` table of JSON.
 * The schema version lives in the single-row `schema_version` table.
 */
export class SqliteBackend implements StorageBackend, MigrationTarget {
  /**
   * Tail of the operation queue. The connection is shared, and an open
   * transaction is connection-wide: a statement (or another transaction) that
   * starts while one is open would commit or roll back the wrong work. Every
   * public operation therefore runs one at a time.
   *
   * Migration context methods are NOT locked: they run inside `apply`, which
   * already holds the lock, and locking them again would deadlock.
   */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly conn: SqlConnection) {}

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async rows(collection: CollectionName): Promise<Row[]> {
    const res = await this.conn.query(
      `SELECT key, value FROM ${table(collection)} ORDER BY key`,
    );
    return (res.values ?? []) as Row[];
  }

  get<T>(collection: CollectionName, key: string): Promise<T | undefined> {
    return this.exclusive(async () => {
      const res = await this.conn.query(
        `SELECT value FROM ${table(collection)} WHERE key = ?`,
        [key],
      );
      const row = res.values?.[0] as Pick<Row, 'value'> | undefined;
      return row ? (JSON.parse(row.value) as T) : undefined;
    });
  }

  getAll<T>(collection: CollectionName): Promise<T[]> {
    return this.exclusive(async () =>
      (await this.rows(collection)).map((r) => JSON.parse(r.value) as T),
    );
  }

  put<T>(collection: CollectionName, key: string, value: T): Promise<void> {
    return this.exclusive(async () => {
      await this.conn.run(
        `INSERT INTO ${table(collection)} (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        [key, JSON.stringify(value)],
      );
    });
  }

  putMany<T>(
    collection: CollectionName,
    entries: readonly (readonly [string, T])[],
  ): Promise<void> {
    if (!entries.length) return Promise.resolve();
    return this.exclusive(async () => {
      const sql = `INSERT INTO ${table(collection)} (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`;
      await this.conn.beginTransaction();
      try {
        for (const [key, value] of entries)
          await this.conn.run(sql, [key, JSON.stringify(value)], false);
        await this.conn.commitTransaction();
      } catch (err) {
        await this.conn.rollbackTransaction();
        throw err;
      }
    });
  }

  delete(collection: CollectionName, key: string): Promise<void> {
    return this.exclusive(async () => {
      await this.conn.run(`DELETE FROM ${table(collection)} WHERE key = ?`, [
        key,
      ]);
    });
  }

  clear(collection: CollectionName): Promise<void> {
    return this.exclusive(async () => {
      await this.conn.run(`DELETE FROM ${table(collection)}`);
    });
  }

  close(): Promise<void> {
    return this.exclusive(() => this.conn.close());
  }

  // MigrationTarget
  readVersion(): Promise<number> {
    return this.exclusive(async () => {
      await this.conn.execute(
        `CREATE TABLE IF NOT EXISTS schema_version (
           id INTEGER PRIMARY KEY CHECK (id = 1),
           version INTEGER NOT NULL
         )`,
      );
      const res = await this.conn.query(
        'SELECT version FROM schema_version WHERE id = 1',
      );
      const row = res.values?.[0] as { version: number } | undefined;
      return row?.version ?? 0;
    });
  }

  context(): MigrationContext {
    // Inside `apply` a transaction is open, so statements must not start one.
    const run = (sql: string, values?: unknown[]) =>
      this.conn.run(sql, values, false);
    return {
      createCollection: async (name) => {
        await run(
          `CREATE TABLE IF NOT EXISTS ${table(name)} (
             key TEXT PRIMARY KEY NOT NULL,
             value TEXT NOT NULL
           )`,
        );
      },
      deleteCollection: async (name) => {
        await run(`DROP TABLE IF EXISTS ${table(name)}`);
      },
      entries: async (name) =>
        (await this.rows(name)).map(
          (r) => [r.key, JSON.parse(r.value)] as [string, unknown],
        ),
      put: async (name, key, value) => {
        await run(
          `INSERT INTO ${table(name)} (key, value) VALUES (?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
          [key, JSON.stringify(value)],
        );
      },
      delete: async (name, key) => {
        await run(`DELETE FROM ${table(name)} WHERE key = ?`, [key]);
      },
    };
  }

  apply(migration: Migration, ctx: MigrationContext): Promise<void> {
    return this.exclusive(async () => {
      await this.conn.beginTransaction();
      try {
        await migration.up(ctx);
        await this.conn.run(
          `INSERT INTO schema_version (id, version) VALUES (1, ?)
           ON CONFLICT(id) DO UPDATE SET version = excluded.version`,
          [migration.version],
          false,
        );
        await this.conn.commitTransaction();
      } catch (err) {
        await this.conn.rollbackTransaction();
        throw err;
      }
    });
  }
}

/** Opens the native SQLite database via @capacitor-community/sqlite. */
export async function openSqliteBackend(
  name = DEFAULT_SQLITE_NAME,
  migrations: readonly Migration[] = MIGRATIONS,
): Promise<StorageBackend> {
  // Loaded lazily so web bundles never pull in the native plugin bridge.
  const { CapacitorSQLite, SQLiteConnection } =
    await import('@capacitor-community/sqlite');
  const sqlite = new SQLiteConnection(CapacitorSQLite);
  const consistent = (await sqlite.checkConnectionsConsistency()).result;
  const exists = (await sqlite.isConnection(name, false)).result;
  const db =
    consistent && exists
      ? await sqlite.retrieveConnection(name, false)
      : await sqlite.createConnection(name, false, 'no-encryption', 1, false);
  await db.open();

  const conn: SqlConnection = {
    query: (statement, values) => db.query(statement, values),
    run: (statement, values, transaction) =>
      db.run(statement, values, transaction ?? true),
    execute: (statements, transaction) =>
      db.execute(statements, transaction ?? true),
    beginTransaction: () => db.beginTransaction(),
    commitTransaction: () => db.commitTransaction(),
    rollbackTransaction: () => db.rollbackTransaction(),
    close: async () => {
      await db.close();
      await sqlite.closeConnection(name, false);
    },
  };

  const backend = new SqliteBackend(conn);
  await runMigrations(backend, migrations);
  return backend;
}

/** `StoragePort` backed by native SQLite (Android / iOS). */
export function createSqliteStorage(
  name = DEFAULT_SQLITE_NAME,
  migrations: readonly Migration[] = MIGRATIONS,
): DocumentStorage {
  return new DocumentStorage(() => openSqliteBackend(name, migrations));
}
