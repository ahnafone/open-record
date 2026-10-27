/**
 * Low-level document store shared by every adapter. Collections hold JSON
 * values keyed by string. Repositories are written once against this
 * interface; SQLite, IndexedDB and the in-memory store only implement it.
 */
export type CollectionName = string;

/** Any value that survives JSON and structured clone unchanged. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue | undefined };

export interface StorageBackend {
  get<T>(collection: CollectionName, key: string): Promise<T | undefined>;
  /** Values in key order. */
  getAll<T>(collection: CollectionName): Promise<T[]>;
  put<T>(collection: CollectionName, key: string, value: T): Promise<void>;
  /** Write several entries in one transaction (all or nothing where supported). */
  putMany<T>(
    collection: CollectionName,
    entries: readonly (readonly [string, T])[],
  ): Promise<void>;
  delete(collection: CollectionName, key: string): Promise<void>;
  clear(collection: CollectionName): Promise<void>;
  close(): Promise<void>;
}

const COLLECTION_NAME = /^[a-z][a-z0-9_]*$/;

/** Collection names become SQL identifiers; keep them strictly safe. */
export function assertCollectionName(name: string): void {
  if (!COLLECTION_NAME.test(name)) {
    throw new Error(`Invalid collection name: "${name}"`);
  }
}
