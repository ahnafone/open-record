import { mkdtemp, readFile, readdir, rm, stat, utimes, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  InvalidUploadError,
  UploadCache,
  UploadsDisabledError,
  UploadTooLargeError,
  type UploadCacheOptions,
} from './upload-cache';

/** A one-shot async iterable, like the multipart file stream the route passes in. */
function source(...chunks: Array<Buffer | string>): AsyncIterable<Buffer> {
  return (async function* () {
    for (const chunk of chunks) yield Buffer.from(chunk);
  })();
}

/** A source that fails mid-stream, to prove the temporary file is removed. */
function failingSource(): AsyncIterable<Buffer> {
  return (async function* () {
    yield Buffer.from('partial');
    throw new Error('stream failed');
  })();
}

describe('UploadCache', () => {
  let dataDir: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'open-record-upload-cache-'));
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  function makeCache(overrides: Partial<UploadCacheOptions> = {}): UploadCache {
    return new UploadCache({
      dataDir,
      capBytes: 1024,
      maxUploadBytes: 1024,
      liveUploads: () => new Set<string>(),
      ...overrides,
    });
  }

  const userDir = (userId = 'user-1'): string => join(dataDir, 'cast', userId);

  it('stores a file, counts its usage and resolves it by id', async () => {
    const cache = makeCache();
    const result = await cache.store('user-1', source('hello'), 'mp3');

    expect(result.uploadId).toMatch(/^[a-f0-9]{64}\.mp3$/);
    expect(result.sizeBytes).toBe(5);
    expect(await cache.usage('user-1')).toEqual({ bytes: 5, count: 1, cap: 1024 });

    const path = cache.pathOf('user-1', result.uploadId);
    expect(path).toBe(join(userDir(), result.uploadId));
    expect(await readFile(path as string, 'utf8')).toBe('hello');
  });

  it('creates a 0700 directory and a 0600 file', async () => {
    const cache = makeCache();
    const { uploadId } = await cache.store('user-1', source('hello'), 'wav');

    expect((await stat(userDir())).mode & 0o777).toBe(0o700);
    expect((await stat(join(userDir(), uploadId))).mode & 0o777).toBe(0o600);
  });

  it('dedupes identical bytes to a single file and upload id', async () => {
    const cache = makeCache();
    const first = await cache.store('user-1', source('same-bytes'), 'mp3');
    const second = await cache.store('user-1', source('same-bytes'), 'mp3');

    expect(second.uploadId).toBe(first.uploadId);
    expect(second.sizeBytes).toBe(first.sizeBytes);
    expect(await cache.usage('user-1')).toEqual({ bytes: 10, count: 1, cap: 1024 });
    expect(await readdir(userDir())).toEqual([first.uploadId]);
  });

  it('evicts least-recently-used non-live files until usage fits the cap', async () => {
    const cache = makeCache({ capBytes: 8 });
    const first = await cache.store('user-1', source('aaaa'), 'mp3');
    const second = await cache.store('user-1', source('bbbb'), 'mp3');
    const third = await cache.store('user-1', source('cccc'), 'mp3');

    // Deterministic LRU order: oldest first, newest last.
    for (const [index, result] of [first, second, third].entries()) {
      const at = new Date(Date.UTC(2026, 0, 1, 0, 0, index));
      await utimes(join(userDir(), result.uploadId), at, at);
    }

    expect(await cache.evict('user-1')).toBe(4);
    expect(await cache.usage('user-1')).toEqual({ bytes: 8, count: 2, cap: 8 });
    expect(cache.pathOf('user-1', first.uploadId)).toBeUndefined();
    expect(cache.pathOf('user-1', second.uploadId)).toBeDefined();
    expect(cache.pathOf('user-1', third.uploadId)).toBeDefined();
  });

  it('never evicts a file with a live relay entry, even at a zero cap', async () => {
    const stored = await makeCache().store('user-1', source('live'), 'mp3');
    const other = await makeCache().store('user-1', source('other'), 'mp3');
    const cache = makeCache({ capBytes: 0, liveUploads: () => new Set([stored.uploadId]) });

    expect(await cache.evict('user-1')).toBe(5);
    expect(cache.pathOf('user-1', stored.uploadId)).toBeDefined();
    expect(cache.pathOf('user-1', other.uploadId)).toBeUndefined();
  });

  it('clear removes only non-live files and reports both sizes', async () => {
    const live = await makeCache().store('user-1', source('live'), 'flac');
    const dead = await makeCache().store('user-1', source('dead'), 'ogg');
    const cache = makeCache({ liveUploads: () => new Set([live.uploadId]) });

    expect(await cache.clear('user-1')).toEqual({ freedBytes: 4, retainedBytes: 4 });
    expect(cache.pathOf('user-1', live.uploadId)).toBeDefined();
    expect(cache.pathOf('user-1', dead.uploadId)).toBeUndefined();
  });

  it('rejects an oversize upload and leaves no partial or temporary file', async () => {
    const cache = makeCache({ maxUploadBytes: 4 });

    await expect(cache.store('user-1', source('12345'), 'mp3')).rejects.toBeInstanceOf(
      UploadTooLargeError,
    );
    expect(await cache.usage('user-1')).toEqual({ bytes: 0, count: 0, cap: 1024 });
    expect(await readdir(userDir())).toEqual([]);
  });

  it('removes the temporary file when the source stream fails', async () => {
    const cache = makeCache();

    await expect(cache.store('user-1', failingSource(), 'mp3')).rejects.toThrow('stream failed');
    expect(await readdir(userDir())).toEqual([]);
  });

  it('rejects a traversal or malformed user id on every method', async () => {
    const cache = makeCache();
    for (const userId of ['../x', 'a/b', '']) {
      await expect(cache.store(userId, source('x'), 'mp3')).rejects.toBeInstanceOf(InvalidUploadError);
      await expect(cache.usage(userId)).rejects.toBeInstanceOf(InvalidUploadError);
      await expect(cache.clear(userId)).rejects.toBeInstanceOf(InvalidUploadError);
      await expect(cache.evict(userId)).rejects.toBeInstanceOf(InvalidUploadError);
      expect(() => cache.pathOf(userId, 'f'.repeat(64))).toThrow(InvalidUploadError);
    }
  });

  it('rejects a disallowed extension and a disabled (zero) cap', async () => {
    const cache = makeCache();
    await expect(cache.store('user-1', source('x'), 'exe')).rejects.toBeInstanceOf(InvalidUploadError);
    await expect(cache.store('user-1', source('x'), '../mp3')).rejects.toBeInstanceOf(
      InvalidUploadError,
    );
    await expect(makeCache({ capBytes: 0 }).store('user-1', source('x'), 'mp3')).rejects.toBeInstanceOf(
      UploadsDisabledError,
    );
  });

  it('returns undefined for an unknown, malformed or foreign upload id', async () => {
    const cache = makeCache();
    const { uploadId } = await cache.store('user-1', source('mine'), 'mp3');
    await writeFile(join(dataDir, 'chunk.mp3'), 'unrelated');

    expect(cache.pathOf('user-1', 'not-an-id')).toBeUndefined();
    expect(cache.pathOf('user-1', 'f'.repeat(64))).toBeUndefined();
    expect(cache.pathOf('user-1', `${'f'.repeat(64)}.mp3`)).toBeUndefined();
    expect(cache.pathOf('user-1', `${uploadId}.flac`)).toBeUndefined();
    expect(cache.pathOf('user-2', uploadId)).toBeUndefined();
  });

  it('ignores stray files in the user directory', async () => {
    const cache = makeCache();
    await mkdir(userDir(), { recursive: true, mode: 0o700 });
    await writeFile(join(userDir(), 'notes.txt'), 'not an upload');
    await writeFile(join(userDir(), '.tmp-deadbeef'), 'partial');

    expect(await cache.usage('user-1')).toEqual({ bytes: 0, count: 0, cap: 1024 });
    expect(await cache.evict('user-1')).toBe(0);
    expect(await cache.clear('user-1')).toEqual({ freedBytes: 0, retainedBytes: 0 });
  });
});
