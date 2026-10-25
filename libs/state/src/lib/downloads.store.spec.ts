import { TestBed } from '@angular/core/testing';
import type { Track } from '@open-record/models';
import { MusicSourceRegistry } from '@open-record/music-source';
import { StoragePort, createInMemoryStorage } from '@open-record/storage';
import { DownloadsStore } from './downloads.store';
import { LibraryStore } from './library.store';
import { RemoteDownloadPort } from './ports';

const remoteTrack: Track = {
  id: 'remote:x',
  providerId: 'remote',
  title: 'Maple Leaf Rag',
  artist: 'Scott Joplin',
  source: { site: 'youtube', url: 'https://example.com/watch?v=1' },
};

function boot(downloadToLibrary: RemoteDownloadPort['downloadToLibrary']) {
  const storage = createInMemoryStorage();
  const remote = {
    configured: true,
    configure: () => undefined,
    testConnection: async () => undefined,
    searchSite: async () => [],
    resolveUrl: async () => remoteTrack,
    downloadToLibrary,
  } as RemoteDownloadPort;
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      { provide: StoragePort, useValue: storage },
      { provide: MusicSourceRegistry, useValue: new MusicSourceRegistry() },
      { provide: RemoteDownloadPort, useValue: remote },
    ],
  });
  return {
    storage,
    library: TestBed.inject(LibraryStore),
    downloads: TestBed.inject(DownloadsStore),
  };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

describe('downloads queue', () => {
  it('persists a finished download as an imported track', async () => {
    const saved: Track = {
      ...remoteTrack,
      id: 'local:k1',
      providerId: 'local',
      sourceFile: 'imported/k1.mp3',
    };
    const { storage, library, downloads } = boot(async (_t, opts) => {
      opts?.onProgress?.({ phase: 'downloading', progress: 50 });
      return saved;
    });
    const item = downloads.enqueue(remoteTrack);
    await vi.waitFor(() => expect(downloads.items()[0].phase).toBe('done'));

    expect(downloads.itemFor(item.url)?.trackId).toBe('local:k1');
    expect(library.importedTracks().map((t) => t.id)).toEqual(['local:k1']);
    expect(
      (await storage.importedTracks.list()).map((i) => i.track.id),
    ).toEqual(['local:k1']);
  });

  it('marks a failed download with a friendly error and can retry', async () => {
    const auth = Object.assign(new Error('401'), { name: 'AuthError' });
    const download = vi.fn().mockRejectedValue(auth);
    const { library, downloads } = boot(download);
    const item = downloads.enqueue(remoteTrack);
    await vi.waitFor(() => expect(downloads.items()[0].phase).toBe('failed'));

    expect(downloads.items()[0].error).toBe('Server rejected the token.');
    expect(library.importedTracks()).toEqual([]);
    downloads.retry(item.id);
    await settle();
    expect(download).toHaveBeenCalledTimes(2);
  });
});
