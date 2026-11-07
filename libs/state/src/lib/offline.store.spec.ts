import { computed } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { Track } from '@open-record/models';
import { MusicSourceRegistry } from '@open-record/music-source';
import { StoragePort, createInMemoryStorage } from '@open-record/storage';
import type { ImportedTrack } from '@open-record/storage';
import { LibraryStore } from './library.store';
import { OfflineStore, SAVE_STALL_MS, SETTLE_MAX_MS } from './offline.store';
import { PlaylistsStore } from './playlists.store';
import { LocalMediaPort, StreamResolverPort } from './ports';

const remoteTrack = (key: string): Track => ({
  id: `remote:${key}`,
  providerId: 'remote',
  title: key,
  artist: 'Artist',
  source: { site: 'test', url: `https://example.test/${key}`, id: key },
});

function boot(
  storage: StoragePort,
  resolver: Partial<StreamResolverPort> | null,
  media: Partial<LocalMediaPort>,
) {
  TestBed.resetTestingModule();
  const registry = new MusicSourceRegistry();
  TestBed.configureTestingModule({
    providers: [
      { provide: StoragePort, useValue: storage },
      { provide: MusicSourceRegistry, useValue: registry },
      { provide: LocalMediaPort, useValue: media },
      ...(resolver
        ? [{ provide: StreamResolverPort, useValue: resolver }]
        : []),
    ],
  });
  return {
    library: TestBed.inject(LibraryStore),
    playlists: TestBed.inject(PlaylistsStore),
    offline: TestBed.inject(OfflineStore),
  };
}

describe('offline store', () => {
  it('reconcile keeps referenced remote tracks and removes orphans', async () => {
    const storage = createInMemoryStorage();
    const record = (track: Track): ImportedTrack => ({
      track,
      filePath: `imported/${track.id.replace(':', '-')}.audio.mp3`,
      importedAt: 1,
      status: 'saved',
    });
    const keep = remoteTrack('keep');
    const orphan = remoteTrack('orphan');
    const local: Track = {
      id: 'local:k1',
      providerId: 'local',
      title: 'Mine',
      artist: 'Me',
      sourceFile: 'imported/k1.audio.mp3',
    };
    await storage.importedTracks.save(record(keep));
    await storage.importedTracks.save(record(orphan));
    await storage.importedTracks.save(record(local));

    const remove = vi.fn(async () => 1);
    const { library, playlists, offline } = boot(storage, null, { remove });
    await Promise.all([library.ready(), playlists.ready()]);
    const pl = await playlists.create('Crate');
    await playlists.addTracks(pl.id, [keep]);

    expect(await offline.reconcile()).toBe(1);
    expect(remove).toHaveBeenCalledWith(orphan);
    expect(await storage.importedTracks.get(orphan.id)).toBeUndefined();
    expect(await storage.importedTracks.get(keep.id)).toBeDefined();
    expect(await storage.importedTracks.get(local.id)).toBeDefined();
  });

  it('ensureSaved persists a saving record, then a saved one', async () => {
    const storage = createInMemoryStorage();
    let finish!: (v: { sourceFile: string; sizeBytes: number }) => void;
    const resolver = {
      saveToDevice: vi.fn(
        () =>
          new Promise<{ sourceFile: string; sizeBytes: number }>((resolve) => {
            finish = resolve;
          }),
      ),
    };
    const track = remoteTrack('song');
    const { library, offline } = boot(storage, resolver, {
      remove: async () => 0,
    });
    await library.ready();

    await offline.ensureSaved(track);
    expect((await storage.importedTracks.get(track.id))?.status).toBe(
      'saving',
    );

    await vi.waitFor(() => expect(resolver.saveToDevice).toHaveBeenCalled());
    finish({ sourceFile: 'imported/remote-song.audio.mp3', sizeBytes: 10 });
    await vi.waitFor(async () => {
      const saved = await storage.importedTracks.get(track.id);
      expect(saved?.status ?? 'saved').toBe('saved');
      expect(saved?.filePath).toBe('imported/remote-song.audio.mp3');
      expect(saved?.track.source).toEqual(track.source);
    });
    expect(offline.status(track.id)).toBe('saved');
  });

  it('streamed but unsaved tracks are never persisted', async () => {
    const storage = createInMemoryStorage();
    const { library } = boot(storage, { saveToDevice: vi.fn() }, {
      remove: async () => 0,
    });
    await library.ready();

    library.remember([remoteTrack('browse')]);
    await new Promise((r) => setTimeout(r, 0));
    expect(await storage.importedTracks.list()).toEqual([]);
    expect(await storage.savedRecords.list()).toEqual([]);
  });

  it('a rate-limited save stays queued and holds the queue until Retry-After', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      const storage = createInMemoryStorage();
      const busy = Object.assign(new Error('busy'), { name: 'busy', retryAfterSec: 5 });
      const saveToDevice = vi.fn(async (_url: string, opts: { id: string }) => {
        if (saveToDevice.mock.calls.length === 1) throw busy;
        return { sourceFile: `imported/${opts.id}.mp3`, sizeBytes: 1 };
      });
      const { library, offline } = boot(storage, { saveToDevice }, { remove: async () => 0 });
      await library.ready();
      const a = remoteTrack('a');
      const b = remoteTrack('b');

      await offline.ensureSaved(a);
      await vi.waitFor(() => expect(offline.busyUntil()).not.toBeNull());
      await offline.ensureSaved(b);
      expect(saveToDevice).toHaveBeenCalledTimes(1);
      expect(offline.status(a.id)).toBe('queued');
      expect(offline.status(b.id)).toBe('queued');

      await vi.advanceTimersByTimeAsync(4_900);
      expect(saveToDevice).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(200);
      expect(offline.busyUntil()).toBeNull();
      // The rate-limited track goes first when the wait is over.
      expect(saveToDevice.mock.calls[1][1].id).toBe(a.id);
    } finally {
      vi.useRealTimers();
    }
  });

  it('progress ticks are coalesced and never change status reads (list re-render guard)', async () => {
    const storage = createInMemoryStorage();
    let tick!: (f: number) => void;
    const resolver = {
      saveToDevice: vi.fn(
        (_url: string, opts: { onProgress?: (f: number) => void }) => {
          tick = opts.onProgress as (f: number) => void;
          return new Promise<never>(() => undefined);
        },
      ),
    };
    const track = remoteTrack('ticks');
    const { library, offline } = boot(storage, resolver, { remove: async () => 0 });
    await library.ready();
    await offline.ensureSaved(track);
    await vi.waitFor(() => expect(resolver.saveToDevice).toHaveBeenCalled());
    expect(offline.status(track.id)).toBe('saving');

    let runs = 0;
    const status = computed(() => (runs++, offline.status(track.id)));
    status();
    for (let i = 1; i <= 50; i++) tick(i / 100);
    status();
    expect(runs).toBe(1);
    await vi.waitFor(() => expect(offline.progress(track.id)).toBe(0.5));
    status();
    expect(runs).toBe(1);
  });
});

describe('offline store stalls', () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] }));
  afterEach(() => vi.useRealTimers());

  /** A save that reports some progress, then never finishes on its own. */
  const stallingSave = () =>
    vi.fn((_url: string, opts: { onProgress?: (f: number) => void }) => {
      opts.onProgress?.(0.5);
      return new Promise<never>(() => undefined);
    });

  it('a stalled save frees its slot so the next queued track starts', async () => {
    const storage = createInMemoryStorage();
    const saveToDevice = stallingSave();
    const { library, offline } = boot(storage, { saveToDevice }, { remove: async () => 0 });
    await library.ready();
    const [a, b, c] = [remoteTrack('a'), remoteTrack('b'), remoteTrack('c')];
    await offline.ensureSaved(a);
    await offline.ensureSaved(b);
    await offline.ensureSaved(c);
    await vi.waitFor(() => expect(saveToDevice).toHaveBeenCalledTimes(2));

    await vi.advanceTimersByTimeAsync(SAVE_STALL_MS);

    await vi.waitFor(() => expect(saveToDevice).toHaveBeenCalledTimes(3));
    expect(saveToDevice.mock.calls[2][1]).toMatchObject({ id: c.id });
    expect(offline.status(a.id)).toBe('failed');
  });

  it('a stalled attempt that finishes late is discarded, not stored, and its file removed', async () => {
    const storage = createInMemoryStorage();
    let finish!: (v: { sourceFile: string; sizeBytes: number }) => void;
    const saveToDevice = vi.fn((_url: string, opts: { onProgress?: (f: number) => void }) => {
      opts.onProgress?.(0.5);
      return new Promise<{ sourceFile: string; sizeBytes: number }>((resolve) => (finish = resolve));
    });
    const remove = vi.fn(async () => 0);
    const { library, offline } = boot(storage, { saveToDevice }, { remove });
    await library.ready();
    const a = remoteTrack('late');
    await offline.ensureSaved(a);
    await vi.waitFor(() => expect(saveToDevice).toHaveBeenCalled());

    await vi.advanceTimersByTimeAsync(SAVE_STALL_MS);
    await vi.waitFor(() => expect(offline.status(a.id)).toBe('failed'));
    finish({ sourceFile: 'imported/late.audio.mp3', sizeBytes: 10 });

    await vi.waitFor(() =>
      expect(remove).toHaveBeenCalledWith({ id: a.id, sourceFile: 'imported/late.audio.mp3' }),
    );
    expect(offline.status(a.id)).toBe('failed');
    expect((await storage.importedTracks.get(a.id))?.status).not.toBe('saved');
  });

  it('a cancel before the stall window is not overwritten by the stall timer', async () => {
    const storage = createInMemoryStorage();
    const saveToDevice = stallingSave();
    const { library, offline } = boot(storage, { saveToDevice }, { remove: async () => 0 });
    await library.ready();
    const a = remoteTrack('cancelled');
    await offline.ensureSaved(a);
    await vi.waitFor(() => expect(saveToDevice).toHaveBeenCalled());

    offline.cancel(a.id);
    await vi.waitFor(() => expect(offline.error(a.id)).toBe('Cancelled.'));
    await vi.advanceTimersByTimeAsync(SAVE_STALL_MS);

    expect(offline.error(a.id)).toBe('Cancelled.');
    expect(offline.failureKind(a.id)).toBeUndefined();
  });

  /** First attempt stalls (resolved by the test via `finish`); later attempts succeed at once. */
  const stallThenSucceed = () => {
    let finish!: (v: { sourceFile: string; sizeBytes: number }) => void;
    let calls = 0;
    const saveToDevice = vi.fn((_url: string, opts: { onProgress?: (f: number) => void }) => {
      calls++;
      opts.onProgress?.(0.5);
      if (calls === 1)
        return new Promise<{ sourceFile: string; sizeBytes: number }>((resolve) => (finish = resolve));
      return Promise.resolve({ sourceFile: 'imported/remote-retry.audio.mp3', sizeBytes: 1 });
    });
    return { saveToDevice, finish: (v: { sourceFile: string; sizeBytes: number }) => finish(v) };
  };

  it('a retry after a stall waits for the orphan to settle before saving again', async () => {
    const storage = createInMemoryStorage();
    const { saveToDevice, finish } = stallThenSucceed();
    const remove = vi.fn(async () => 0);
    const { library, offline } = boot(storage, { saveToDevice }, { remove });
    await library.ready();
    const a = remoteTrack('retry-wait');
    await offline.ensureSaved(a);
    await vi.waitFor(() => expect(saveToDevice).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(SAVE_STALL_MS);
    await vi.waitFor(() => expect(offline.status(a.id)).toBe('failed'));

    await offline.retry(a.id);
    await vi.advanceTimersByTimeAsync(SETTLE_MAX_MS - 1_000);
    expect(saveToDevice).toHaveBeenCalledTimes(1);

    finish({ sourceFile: 'imported/remote-retry-orphan.audio.mp3', sizeBytes: 1 });
    await vi.waitFor(() => expect(saveToDevice).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(offline.status(a.id)).toBe('saved'));
    expect(remove).toHaveBeenCalledWith({
      id: a.id,
      sourceFile: 'imported/remote-retry-orphan.audio.mp3',
    });
  });

  it('retries keep failing retryably past the settle cap until the orphan settles, then save and keep their file', async () => {
    const storage = createInMemoryStorage();
    const { saveToDevice, finish } = stallThenSucceed();
    const remove = vi.fn(async () => 0);
    const { library, offline } = boot(storage, { saveToDevice }, { remove });
    await library.ready();
    const a = remoteTrack('retry-cap');
    const stillClosing = 'The previous download is still closing. It will be retried.';
    await offline.ensureSaved(a);
    await vi.waitFor(() => expect(saveToDevice).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(SAVE_STALL_MS);
    await vi.waitFor(() => expect(offline.status(a.id)).toBe('failed'));

    // Past the cap: the retry fails retryably and never starts a native attempt.
    await offline.retry(a.id);
    await vi.advanceTimersByTimeAsync(SETTLE_MAX_MS + 1_000);
    await vi.waitFor(() => expect(offline.error(a.id)).toBe(stillClosing));
    expect(saveToDevice).toHaveBeenCalledTimes(1);
    expect(offline.failureKind(a.id)).toBe('systemic');

    // A repeated retry still waits on the (unsettled) orphan and fails the same way.
    await offline.retry(a.id);
    await vi.advanceTimersByTimeAsync(SETTLE_MAX_MS + 1_000);
    await vi.waitFor(() => expect(offline.error(a.id)).toBe(stillClosing));
    expect(saveToDevice).toHaveBeenCalledTimes(1);

    // The orphan finishes late: its own cleanup removes only its file.
    finish({ sourceFile: 'imported/remote-retry-orphan.audio.mp3', sizeBytes: 1 });
    await vi.waitFor(() =>
      expect(remove).toHaveBeenCalledWith({
        id: a.id,
        sourceFile: 'imported/remote-retry-orphan.audio.mp3',
      }),
    );

    await offline.retry(a.id);
    await vi.waitFor(() => expect(saveToDevice).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(offline.status(a.id)).toBe('saved'));
    expect(remove).not.toHaveBeenCalledWith({
      id: a.id,
      sourceFile: 'imported/remote-retry.audio.mp3',
    });
    expect((await storage.importedTracks.get(a.id))?.filePath).toBe(
      'imported/remote-retry.audio.mp3',
    );
  });

  it('a save with no progress ticks is not abandoned', async () => {
    const storage = createInMemoryStorage();
    const saveToDevice = vi.fn(() => new Promise<never>(() => undefined));
    const { library, offline } = boot(storage, { saveToDevice }, { remove: async () => 0 });
    await library.ready();
    const a = remoteTrack('silent');
    await offline.ensureSaved(a);
    await vi.waitFor(() => expect(saveToDevice).toHaveBeenCalled());

    await vi.advanceTimersByTimeAsync(SAVE_STALL_MS * 2);

    expect(offline.status(a.id)).toBe('saving');
    expect(offline.failureKind(a.id)).toBeUndefined();
  });

  it('a save that keeps ticking is not abandoned', async () => {
    const storage = createInMemoryStorage();
    let tick: ((f: number) => void) | undefined;
    const saveToDevice = vi.fn((_url: string, opts: { onProgress?: (f: number) => void }) => {
      tick = opts.onProgress;
      return new Promise<never>(() => undefined);
    });
    const { library, offline } = boot(storage, { saveToDevice }, { remove: async () => 0 });
    await library.ready();
    const a = remoteTrack('ticking');
    await offline.ensureSaved(a);
    await vi.waitFor(() => expect(saveToDevice).toHaveBeenCalled());

    // Ten minutes in one-minute steps: every gap is shorter than the stall window.
    for (let i = 1; i <= 10; i++) {
      tick?.(i / 10);
      await vi.advanceTimersByTimeAsync(60_000);
    }

    expect(offline.status(a.id)).toBe('saving');
    expect(offline.failureKind(a.id)).toBeUndefined();
  });
});
