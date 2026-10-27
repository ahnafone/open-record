import { TestBed } from '@angular/core/testing';
import type { Track } from '@open-record/models';
import { MusicSourceRegistry } from '@open-record/music-source';
import { StoragePort, createInMemoryStorage } from '@open-record/storage';
import { LibraryStore } from './library.store';
import { PlaylistsStore } from './playlists.store';
import { LocalMediaPort } from './ports';

const tracks: Track[] = [
  { id: 'fake:a', providerId: 'fake', title: 'A', artist: 'X' },
  { id: 'fake:b', providerId: 'fake', title: 'B', artist: 'Y' },
];

function boot(storage: StoragePort) {
  const registry = new MusicSourceRegistry();
  registry.register({
    id: 'fake',
    capabilities: { search: true, download: false },
    list: async () => tracks,
    search: async () => tracks,
    resolve: async (id) => ({ url: id, kind: 'bundled' }),
  });
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      { provide: StoragePort, useValue: storage },
      { provide: MusicSourceRegistry, useValue: registry },
    ],
  });
  return {
    library: TestBed.inject(LibraryStore),
    playlists: TestBed.inject(PlaylistsStore),
  };
}

describe('store persistence', () => {
  it('playlists and saved records survive a restart', async () => {
    const storage = createInMemoryStorage();
    const first = boot(storage);
    const pl = await first.playlists.create('  Rainy day crate ');
    await first.playlists.addTracks(pl.id, ['fake:b', 'fake:a', 'fake:b']);
    await first.playlists.setVisibility(pl.id, 'public');
    await first.library.toggleSaved('fake:a');

    const second = boot(storage);
    await Promise.all([second.playlists.ready(), second.library.ready()]);

    const restored = second.playlists.playlist(pl.id);
    expect(restored).toMatchObject({
      name: 'Rainy day crate',
      visibility: 'public',
      trackIds: ['fake:b', 'fake:a'],
    });
    expect(second.playlists.tracksOf(pl.id).map((t) => t.title)).toEqual([
      'B',
      'A',
    ]);
    expect(second.library.isSaved('fake:a')).toBe(true);
    expect(second.library.savedRecords().map((t) => t.id)).toEqual(['fake:a']);
  });

  it('download status writes do not rebuild the index or derived lists', async () => {
    const { library } = boot(createInMemoryStorage());
    await library.ready();
    const [a, b] = library.tracks();
    await library.setSaved(b.id, true);
    await library.storeRecord({
      track: b,
      filePath: '',
      importedAt: 1,
      status: 'saving',
    });
    const index = library.tracks();
    const map = library.trackMap();
    const saved = library.savedRecords();
    const imported = library.importedTracks();
    expect(imported).toEqual([b]);

    await library.storeRecord({
      track: b,
      filePath: '',
      importedAt: 1,
      status: 'failed',
    });
    expect(library.tracks()).toBe(index);
    expect(library.trackMap()).toBe(map);
    expect(library.savedRecords()).toBe(saved);
    expect(library.importedTracks()).toBe(imported);

    await library.storeRecord({
      track: a,
      filePath: '',
      importedAt: 2,
      status: 'saving',
    });
    expect(library.importedTracks()).toEqual([a, b]);
  });

  it('adding a track records addedAt and removing it clears the entry', async () => {
    const { playlists } = boot(createInMemoryStorage());
    const pl = await playlists.create('Dated');
    await playlists.addTracks(pl.id, ['fake:a']);
    expect(playlists.addedAtOf(pl.id, 'fake:a')).toEqual(expect.any(Number));
    await playlists.removeTrack(pl.id, 'fake:a');
    expect(playlists.addedAtOf(pl.id, 'fake:a')).toBeUndefined();
  });

  it('adding a playlist to the library keeps its order and skips saved and unknown tracks', async () => {
    const storage = createInMemoryStorage();
    const { library } = boot(storage);
    await library.addMetadataTracks([
      { id: 'meta:c', providerId: 'meta', title: 'C', artist: 'Z' },
    ]);
    await library.bookmarkWithoutSaving([{ id: 'fake:b', savedAt: 1 }]);

    const result = await library.addTracksToLibrary([
      'meta:c',
      'fake:a',
      'fake:b',
      'gone:x',
      'fake:a',
    ]);

    expect(result).toEqual({ added: 2, alreadySaved: 1, unavailable: 1 });
    expect(library.savedIds()).toEqual(['meta:c', 'fake:a', 'fake:b']);
    expect(await storage.savedRecords.list()).toEqual([
      'meta:c',
      'fake:a',
      'fake:b',
    ]);
  });
});

describe('imported tracks', () => {
  const imported: Track = {
    id: 'local:k1',
    providerId: 'local',
    title: 'Song',
    artist: 'Band',
    album: 'My Album',
    userEdited: ['album'],
  };

  function bootWithPorts(storage: StoragePort) {
    const media: LocalMediaPort = {
      pickAndImport: async () => ({ tracks: [], failures: [] }),
      artUrl: async () => undefined,
      remove: async () => 0,
      cleanup: vi.fn(async () => 0),
      usage: async () => ({ audioBytes: 0, artBytes: 0 }),
    };
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        { provide: StoragePort, useValue: storage },
        { provide: MusicSourceRegistry, useValue: new MusicSourceRegistry() },
        { provide: LocalMediaPort, useValue: media },
      ],
    });
    return {
      library: TestBed.inject(LibraryStore),
      playlists: TestBed.inject(PlaylistsStore),
      media,
    };
  }

  it('clearImported removes records, references and files', async () => {
    const storage = createInMemoryStorage();
    await storage.importedTracks.save({
      track: imported,
      filePath: 'f',
      importedAt: 1,
    });
    const { library, playlists, media } = bootWithPorts(storage);
    await Promise.all([library.ready(), playlists.ready()]);
    await library.setSaved(imported.id, true);
    const pl = await playlists.create('Mix');
    await playlists.addTracks(pl.id, [imported.id]);

    await library.clearImported();

    expect(await storage.importedTracks.list()).toEqual([]);
    expect(await storage.savedRecords.list()).toEqual([]);
    expect((await storage.playlists.get(pl.id))?.trackIds).toEqual([]);
    expect(library.importedTracks()).toEqual([]);
    expect(media.cleanup).toHaveBeenCalledWith([]);
  });

  it('importFiles rolls back the files of a batch whose write fails', async () => {
    const storage = createInMemoryStorage();
    const files: Track[] = Array.from({ length: 25 }, (_, i) => ({
      id: `local:f${i}`,
      providerId: 'local',
      title: `F${i}`,
      artist: 'Band',
      sourceFile: `f${i}.mp3`,
    }));
    const { library, media } = bootWithPorts(storage);
    media.pickAndImport = async () => ({ tracks: files, failures: [] });
    const remove = vi.spyOn(media, 'remove');
    const saveMany = storage.importedTracks.saveMany;
    let calls = 0;
    storage.importedTracks.saveMany = (records) =>
      ++calls === 2
        ? Promise.reject(new Error('disk full'))
        : saveMany(records);
    await library.ready();

    const { imported, failures } = await library.importFiles();

    expect(imported.map((t) => t.id)).toEqual(
      files.slice(0, 20).map((t) => t.id),
    );
    expect(failures.map((f) => f.fileName)).toEqual(
      files.slice(20).map((t) => t.sourceFile),
    );
    expect(remove.mock.calls.map(([t]) => t)).toEqual(files.slice(20));
    expect(await storage.importedTracks.list()).toHaveLength(20);
    expect(library.importedTracks()).toHaveLength(20);
  });
});
