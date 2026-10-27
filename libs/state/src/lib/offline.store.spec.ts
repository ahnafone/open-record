import { computed } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { Track } from '@open-record/models';
import { MusicSourceRegistry } from '@open-record/music-source';
import { StoragePort, createInMemoryStorage } from '@open-record/storage';
import type { ImportedTrack } from '@open-record/storage';
import { LibraryStore } from './library.store';
import { OfflineStore } from './offline.store';
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
