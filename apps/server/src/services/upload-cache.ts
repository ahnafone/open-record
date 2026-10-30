import { createHash, randomBytes } from 'node:crypto';
import { createWriteStream, statSync, type Dirent } from 'node:fs';
import { chmod, mkdir, readdir, rename, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/** Uploads are scoped to one account directory; only safe path segments are accepted. */
const USER_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** Audio types the cache accepts, keyed by lower-case extension. */
export const UPLOAD_EXTENSIONS = ['mp3', 'm4a', 'aac', 'ogg', 'opus', 'flac', 'wav'] as const;

export type UploadExtension = (typeof UPLOAD_EXTENSIONS)[number];

/** `Content-Type` for each allow-listed extension; Opus is carried in an Ogg container. */
export const UPLOAD_MIME_BY_EXT: Readonly<Record<UploadExtension, string>> = {
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  ogg: 'audio/ogg',
  opus: 'audio/ogg',
  flac: 'audio/flac',
  wav: 'audio/wav',
};

/**
 * An upload id is `<sha256>.<ext>`: the lower-case hex digest of the contents
 * plus the allow-listed extension. The extension is part of the id so the cast
 * service knows the receiver's content type before the file is fetched.
 */
const UPLOAD_ID_PATTERN = new RegExp(
  `^[a-f0-9]{64}\\.(${UPLOAD_EXTENSIONS.join('|')})$`,
);

/** Matches the only files the cache itself creates: `<sha256>.<ext>`. */
const UPLOAD_FILE_PATTERN = new RegExp(
  `^([a-f0-9]{64})\\.(${UPLOAD_EXTENSIONS.join('|')})$`,
);

/** Thrown for a bad user id, extension or other malformed upload; maps to HTTP 400. */
export class InvalidUploadError extends Error {}

/** Thrown when an upload exceeds `maxUploadBytes`; maps to HTTP 413. */
export class UploadTooLargeError extends Error {}

/** Thrown when the per-user cap is `0` (uploads disabled); maps to HTTP 503. */
export class UploadsDisabledError extends Error {}

export interface UploadCacheOptions {
  /** Root data directory; files live under `<dataDir>/cast/<userId>/`. */
  dataDir: string;
  /** Per-user cache cap in bytes. `0` disables uploads and evicts everything not live. */
  capBytes: number;
  /** Largest accepted upload in bytes. */
  maxUploadBytes: number;
  /** Ids referenced by unexpired relay entries; these are never evicted or cleared. */
  liveUploads: () => Set<string>;
  /** Clock seam (unused today; kept for parity with the plan's interface). */
  now?: () => number;
}

interface CachedFile {
  uploadId: string;
  path: string;
  sizeBytes: number;
  mtimeMs: number;
}

function isErrno(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === code;
}

function isUploadExtension(value: string): value is UploadExtension {
  return (UPLOAD_EXTENSIONS as readonly string[]).includes(value);
}

/**
 * On-disk cache for PC-imported audio handed to cast relays.
 *
 * Layout: `<dataDir>/cast/<userId>/<sha256>.<ext>`, directories `0700` and files
 * `0600`. Writes go to a temporary file in the same directory and are renamed
 * into place, so a reader never sees a partial upload. Identical bytes (same
 * hash and extension) dedupe to one file. Every method that takes a user id
 * validates it first: nothing here can escape the user's directory.
 */
export class UploadCache {
  private readonly dataDir: string;
  private readonly capBytes: number;
  private readonly maxUploadBytes: number;
  private readonly liveUploads: () => Set<string>;

  constructor(opts: UploadCacheOptions) {
    this.dataDir = opts.dataDir;
    this.capBytes = opts.capBytes;
    this.maxUploadBytes = opts.maxUploadBytes;
    this.liveUploads = opts.liveUploads;
  }

  /** Streams `file` into the cache and returns its content hash and size. */
  async store(
    userId: string,
    file: AsyncIterable<Buffer>,
    ext: string,
  ): Promise<{ uploadId: string; sizeBytes: number }> {
    this.userDir(userId);
    const extension = ext.toLowerCase();
    if (!isUploadExtension(extension)) {
      throw new InvalidUploadError(`unsupported upload extension: ${ext}`);
    }
    if (this.capBytes <= 0) {
      throw new UploadsDisabledError('the upload cache is disabled');
    }

    const dir = await this.ensureUserDir(userId);
    const temp = join(dir, `.tmp-${randomBytes(8).toString('hex')}`);
    const hash = createHash('sha256');
    let sizeBytes = 0;

    const meter = new Transform({
      transform: (chunk: Buffer, _encoding, callback) => {
        sizeBytes += chunk.length;
        if (sizeBytes > this.maxUploadBytes) {
          callback(new UploadTooLargeError('upload exceeds the size limit'));
          return;
        }
        hash.update(chunk);
        callback(null, chunk);
      },
    });

    try {
      await pipeline(Readable.from(file), meter, createWriteStream(temp, { flags: 'wx', mode: 0o600 }));
    } catch (error) {
      await unlink(temp).catch(() => undefined);
      throw error;
    }

    const uploadId = `${hash.digest('hex')}.${extension}`;
    // The on-disk name is exactly the id, so clear/evict/live matching is a
    // plain name comparison.
    const destination = join(dir, uploadId);
    try {
      const existing = await stat(destination);
      if (existing.isFile() && existing.size === sizeBytes) {
        // Same bytes and same size: keep the existing file (dedupe).
        await unlink(temp).catch(() => undefined);
        return { uploadId, sizeBytes };
      }
    } catch (error) {
      if (!isErrno(error, 'ENOENT')) {
        await unlink(temp).catch(() => undefined);
        throw error;
      }
    }

    try {
      await chmod(temp, 0o600);
      await rename(temp, destination);
    } catch (error) {
      await unlink(temp).catch(() => undefined);
      throw error;
    }
    return { uploadId, sizeBytes };
  }

  /** Bytes and file count in the user's directory, plus the per-user cap. */
  async usage(userId: string): Promise<{ bytes: number; count: number; cap: number }> {
    const files = await this.files(userId);
    return {
      bytes: files.reduce((total, file) => total + file.sizeBytes, 0),
      count: files.length,
      cap: this.capBytes,
    };
  }

  /** Removes every file except those referenced by a live relay entry. */
  async clear(userId: string): Promise<{ freedBytes: number; retainedBytes: number }> {
    const files = await this.files(userId);
    const live = this.liveUploads();
    let freedBytes = 0;
    let retainedBytes = 0;
    for (const file of files) {
      if (live.has(file.uploadId)) {
        retainedBytes += file.sizeBytes;
        continue;
      }
      if (await this.remove(file)) freedBytes += file.sizeBytes;
    }
    return { freedBytes, retainedBytes };
  }

  /** Evicts least-recently-used non-live files until usage is within the cap. */
  async evict(userId: string): Promise<number> {
    const files = await this.files(userId);
    let total = files.reduce((sum, file) => sum + file.sizeBytes, 0);
    if (total <= this.capBytes) return 0;

    const live = this.liveUploads();
    const removable = files
      .filter((file) => !live.has(file.uploadId))
      .sort((a, b) => a.mtimeMs - b.mtimeMs || a.uploadId.localeCompare(b.uploadId));

    let freedBytes = 0;
    for (const file of removable) {
      if (total <= this.capBytes) break;
      if (!(await this.remove(file))) continue;
      total -= file.sizeBytes;
      freedBytes += file.sizeBytes;
    }
    return freedBytes;
  }

  /**
   * Resolves an upload id to its file. The id is validated as `<sha256>.<ext>`
   * first and the on-disk name equals the id, so a malformed or traversal-shaped
   * id can never reach the filesystem; unknown ids return `undefined`.
   */
  pathOf(userId: string, uploadId: string): string | undefined {
    const dir = this.userDir(userId);
    if (!UPLOAD_ID_PATTERN.test(uploadId)) return undefined;
    const path = join(dir, uploadId);
    try {
      return statSync(path).isFile() ? path : undefined;
    } catch {
      return undefined;
    }
  }

  private userDir(userId: string): string {
    if (!USER_ID_PATTERN.test(userId)) {
      throw new InvalidUploadError('invalid user id');
    }
    return join(this.dataDir, 'cast', userId);
  }

  private async ensureUserDir(userId: string): Promise<string> {
    const dir = this.userDir(userId);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    // mkdir's mode is filtered by umask; make the final component explicit.
    await chmod(dir, 0o700);
    return dir;
  }

  private async files(userId: string): Promise<CachedFile[]> {
    const dir = this.userDir(userId);
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (isErrno(error, 'ENOENT')) return [];
      throw error;
    }

    const files: CachedFile[] = [];
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const match = UPLOAD_FILE_PATTERN.exec(entry.name);
      if (!match) continue;
      const path = join(dir, entry.name);
      try {
        const info = await stat(path);
        files.push({
          uploadId: match[0],
          path,
          sizeBytes: info.size,
          mtimeMs: info.mtimeMs,
        });
      } catch {
        // A file removed between readdir and stat (clear/evict) is ignored.
      }
    }
    return files;
  }

  private async remove(file: CachedFile): Promise<boolean> {
    try {
      await unlink(file.path);
      return true;
    } catch (error) {
      if (isErrno(error, 'ENOENT')) return false;
      throw error;
    }
  }
}
