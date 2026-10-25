import { TestBed } from '@angular/core/testing';
import type { Track } from '@open-record/models';
import { MusicSourceRegistry } from '@open-record/music-source';
import { StoragePort, createInMemoryStorage } from '@open-record/storage';
import { LibraryStore } from './library.store';
import { PlaylistsStore } from './playlists.store';
import { LocalMediaPort, MetadataPort } from './ports';

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
  return { library: TestBed.inject(LibraryStore), playlists: TestBed.inject(PlaylistsStore) };
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
    expect(second.playlists.tracksOf(pl.id).map((t) => t.title)).toEqual(['B', 'A']);
    expect(second.library.isSaved('fake:a')).toBe(true);
    expect(second.library.savedRecords().map((t) => t.id)).toEqual(['fake:a']);
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
    enrichment: 'pending',
  };

  function bootWithPorts(storage: StoragePort) {
    const media: LocalMediaPort = {
      pickAndImport: async () => ({ tracks: [], failures: [] }),
      artUrl: async () => undefined,
      storeCover: async () => undefined,
      remove: async () => 0,
      cleanup: vi.fn(async () => 0),
      usage: async () => ({ audioBytes: 0, artBytes: 0 }),
    };
    const metadata: MetadataPort = {
      available: true,
      searchRecordings: async () => [],
      enrich: async () => ({
        recordingMbid: 'rec-1',
        title: 'Song',
        artist: 'Band',
        artistMbids: ['art-1'],
        album: 'Online Album',
        year: 1999,
        genres: ['jazz'],
        matchScore: 0.9,
        coverArt: null,
      }),
    };
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        { provide: StoragePort, useValue: storage },
        { provide: MusicSourceRegistry, useValue: new MusicSourceRegistry() },
        { provide: LocalMediaPort, useValue: media },
        { provide: MetadataPort, useValue: metadata },
      ],
    });
    return { library: TestBed.inject(LibraryStore), playlists: TestBed.inject(PlaylistsStore), media };
  }

  it('enrichment fills empty fields but never overwrites user edits', async () => {
    const storage = createInMemoryStorage();
    await storage.importedTracks.save({ track: imported, filePath: 'f', importedAt: 1 });
    const { library } = bootWithPorts(storage);
    await library.ready();
    await library.enrichmentIdle();

    const stored = (await storage.importedTracks.get(imported.id))?.track;
    expect(stored).toMatchObject({ album: 'My Album', year: 1999, genre: 'jazz', enrichment: 'done' });
    expect(stored?.mbids).toEqual({ recording: 'rec-1', artist: 'art-1' });
    expect(library.track(imported.id)?.album).toBe('My Album');
  });

  it('clearImported removes records, references and files', async () => {
    const storage = createInMemoryStorage();
    await storage.importedTracks.save({ track: { ...imported, enrichment: 'done' }, filePath: 'f', importedAt: 1 });
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
});
