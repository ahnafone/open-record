import { Capacitor } from '@capacitor/core';
import { Directory, Filesystem } from '@capacitor/filesystem';
import { FilePicker } from '@capawesome/capacitor-file-picker';
import { openDB, type IDBPDatabase } from 'idb';

/** A user-picked audio file, before it is copied into app storage. */
export interface PickedAudio {
  name: string;
  mimeType?: string;
  size: number;
  /** Web: the file contents. */
  blob?: Blob;
  /** Native: the picker's path/URI for the file. */
  path?: string;
}

export interface StoredFileEntry {
  /** Store-relative path, e.g. `imported/<key>.audio.mp3`. */
  path: string;
  sizeBytes: number;
}

/**
 * Port for app-private file storage used by the local provider. Paths are
 * store-relative and always live under {@link IMPORT_DIR}.
 */
export interface LocalFileStore {
  /** Copy a picked file into the store at `path`; resolves to the stored size in bytes. */
  copyIn(path: string, file: PickedAudio): Promise<number>;
  /** Write raw bytes (e.g. embedded cover art) to `path`. */
  write(path: string, data: Uint8Array, mimeType: string): Promise<number>;
  /** A URL the web view can load (`<audio>`, `<img>`, `fetch`). */
  url(path: string): Promise<string>;
  /** Delete a stored file; missing files are ignored. */
  remove(path: string): Promise<void>;
  /** Everything currently stored. */
  list(): Promise<StoredFileEntry[]>;
}

export const IMPORT_DIR = 'imported';

function toBase64(data: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < data.length; i += chunk) {
    binary += String.fromCharCode(...data.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/** Native store: `Directory.Data/imported/`, served to the web view via `convertFileSrc`. */
export class NativeFileStore implements LocalFileStore {
  private dirReady?: Promise<void>;

  private ensureDir(): Promise<void> {
    this.dirReady ??= Filesystem.mkdir({ path: IMPORT_DIR, directory: Directory.Data, recursive: true }).catch(
      async (err) => {
        // mkdir rejects when the folder already exists.
        await Filesystem.stat({ path: IMPORT_DIR, directory: Directory.Data }).catch(() => {
          this.dirReady = undefined;
          throw err;
        });
      },
    );
    return this.dirReady;
  }

  private async size(path: string): Promise<number> {
    const { size } = await Filesystem.stat({ path, directory: Directory.Data });
    return size;
  }

  async copyIn(path: string, file: PickedAudio): Promise<number> {
    await this.ensureDir();
    if (file.path) {
      const { uri } = await Filesystem.getUri({ path, directory: Directory.Data });
      // FilePicker.copyFile understands content:// URIs on Android and security-scoped URLs on iOS.
      await FilePicker.copyFile({ from: file.path, to: uri, overwrite: true });
    } else if (file.blob) {
      const bytes = new Uint8Array(await file.blob.arrayBuffer());
      await Filesystem.writeFile({ path, directory: Directory.Data, data: toBase64(bytes) });
    } else {
      throw new Error(`No data for picked file "${file.name}"`);
    }
    return this.size(path);
  }

  async write(path: string, data: Uint8Array): Promise<number> {
    await this.ensureDir();
    await Filesystem.writeFile({ path, directory: Directory.Data, data: toBase64(data) });
    return data.byteLength;
  }

  async url(path: string): Promise<string> {
    const { uri } = await Filesystem.getUri({ path, directory: Directory.Data });
    return Capacitor.convertFileSrc(uri);
  }

  async remove(path: string): Promise<void> {
    await Filesystem.deleteFile({ path, directory: Directory.Data }).catch(() => undefined);
  }

  async list(): Promise<StoredFileEntry[]> {
    try {
      const { files } = await Filesystem.readdir({ path: IMPORT_DIR, directory: Directory.Data });
      return files
        .filter((f) => f.type === 'file')
        .map((f) => ({ path: `${IMPORT_DIR}/${f.name}`, sizeBytes: f.size }));
    } catch {
      return []; // folder not created yet
    }
  }
}

interface WebFileRecord {
  path: string;
  blob: Blob;
  sizeBytes: number;
}

const WEB_DB_NAME = 'open-record-files';
const WEB_STORE = 'files';

/**
 * Web store: blobs in a dedicated IndexedDB database (separate from the
 * storage lib's document DB so their schema versions never collide).
 * URLs are object URLs, cached per path and revoked on remove.
 */
export class IndexedDbFileStore implements LocalFileStore {
  private db?: Promise<IDBPDatabase>;
  private readonly urls = new Map<string, string>();

  constructor(private readonly dbName = WEB_DB_NAME) {}

  private open(): Promise<IDBPDatabase> {
    this.db ??= openDB(this.dbName, 1, {
      upgrade(db) {
        if (!db.objectStoreNames.contains(WEB_STORE)) db.createObjectStore(WEB_STORE, { keyPath: 'path' });
      },
    });
    return this.db;
  }

  private async put(record: WebFileRecord): Promise<number> {
    const db = await this.open();
    await db.put(WEB_STORE, record);
    this.revoke(record.path);
    return record.sizeBytes;
  }

  async copyIn(path: string, file: PickedAudio): Promise<number> {
    if (!file.blob) throw new Error(`No data for picked file "${file.name}"`);
    const blob = file.blob.type || !file.mimeType ? file.blob : file.blob.slice(0, file.blob.size, file.mimeType);
    return this.put({ path, blob, sizeBytes: blob.size });
  }

  async write(path: string, data: Uint8Array, mimeType: string): Promise<number> {
    const blob = new Blob([data as Uint8Array<ArrayBuffer>], { type: mimeType });
    return this.put({ path, blob, sizeBytes: blob.size });
  }

  async url(path: string): Promise<string> {
    const cached = this.urls.get(path);
    if (cached) return cached;
    const db = await this.open();
    const record = (await db.get(WEB_STORE, path)) as WebFileRecord | undefined;
    if (!record) throw new Error(`Stored file "${path}" not found`);
    const url = URL.createObjectURL(record.blob);
    this.urls.set(path, url);
    return url;
  }

  async remove(path: string): Promise<void> {
    this.revoke(path);
    const db = await this.open();
    await db.delete(WEB_STORE, path);
  }

  async list(): Promise<StoredFileEntry[]> {
    const db = await this.open();
    const records = (await db.getAll(WEB_STORE)) as WebFileRecord[];
    return records.map(({ path, sizeBytes }) => ({ path, sizeBytes }));
  }

  private revoke(path: string): void {
    const url = this.urls.get(path);
    if (url) {
      URL.revokeObjectURL(url);
      this.urls.delete(path);
    }
  }
}

/** Native filesystem on Android/iOS, IndexedDB in the browser. */
export function createDefaultFileStore(): LocalFileStore {
  return Capacitor.isNativePlatform() ? new NativeFileStore() : new IndexedDbFileStore();
}
