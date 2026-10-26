import { TestBed } from '@angular/core/testing';
import type { Track } from '@open-record/models';
import { MusicSourceRegistry } from '@open-record/music-source';
import { StoragePort, createInMemoryStorage } from '@open-record/storage';
import { ImportStore } from './import.store';
import { LibraryStore } from './library.store';
import { PlaylistsStore } from './playlists.store';
import { RemoteServerPort } from './ports';

const SPOTIFY_ID = '4uLU6hMCjMI75M1A2tKUQC';
const match: Track = {
  id: 'remote:https%3A%2F%2Fmusic.youtube.com%2Fwatch%3Fv%3Dabc',
  providerId: 'remote',
  title: 'Midnight City',
  artist: 'M83 - Topic',
  durationSec: 244,
  source: { site: 'ytmusic', url: 'https://music.youtube.com/watch?v=abc' },
};

describe('spotify import', () => {
  it('creates playlists and likes as placeholders without downloading, then swaps in the match', async () => {
    const storage = createInMemoryStorage();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const remote = {
      configured: true,
      configure: () => undefined,
      searchSite: vi.fn(async () => {
        await gate;
        return [match];
      }),
    } as unknown as RemoteServerPort;
    TestBed.configureTestingModule({
      providers: [
        { provide: StoragePort, useValue: storage },
        { provide: MusicSourceRegistry, useValue: new MusicSourceRegistry() },
        { provide: RemoteServerPort, useValue: remote },
      ],
    });
    const store = TestBed.inject(ImportStore);
    const library = TestBed.inject(LibraryStore);
    const playlists = TestBed.inject(PlaylistsStore);
    const song = { title: 'Midnight City', artists: ['M83'], artist: 'M83', durationMs: 243_000, spotifyId: SPOTIFY_ID };

    const summary = await store.start({ playlists: [{ name: 'Drive', tracks: [song] }], liked: [song] });
    const placeholder = `spotify:${SPOTIFY_ID}`;
    expect(summary).toMatchObject({ playlists: 1, liked: 1, tracks: 1 });
    const [pl] = playlists.playlists();
    expect(pl.trackIds).toEqual([placeholder]);
    expect(library.savedIds()).toEqual([placeholder]);
    expect(library.track(placeholder)?.providerId).toBe('spotify');
    await expect(TestBed.inject(MusicSourceRegistry).resolve(library.track(placeholder) as Track)).rejects.toThrow(
      /Not matched/,
    );

    release();
    await vi.waitFor(() => expect(store.progress().matched).toBe(1));
    expect(playlists.playlist(pl.id)?.trackIds).toEqual([match.id]);
    expect(library.savedIds()).toEqual([match.id]);
    expect(library.track(match.id)).toMatchObject({ title: 'Midnight City', artist: 'M83', external: { spotifyId: SPOTIFY_ID } });
    // Metadata only: nothing was queued for download.
    expect(await storage.importedTracks.list()).toEqual([]);

    await store.deleteImportData();
    expect(store.hasJob()).toBe(false);
    expect(library.track(match.id)).toBeDefined();
  });

  it('sends a skipped track back to review with its suggestions', async () => {
    const remote = {
      configured: true,
      configure: () => undefined,
      searchSite: vi.fn(async () => [{ ...match, artist: 'Someone Else' }]),
    } as unknown as RemoteServerPort;
    TestBed.configureTestingModule({
      providers: [
        { provide: StoragePort, useValue: createInMemoryStorage() },
        { provide: MusicSourceRegistry, useValue: new MusicSourceRegistry() },
        { provide: RemoteServerPort, useValue: remote },
      ],
    });
    const store = TestBed.inject(ImportStore);
    const song = { title: 'Midnight City', artists: ['M83'], artist: 'M83', durationMs: 243_000, spotifyId: SPOTIFY_ID };
    await store.start({ playlists: [], liked: [song] });
    await vi.waitFor(() => expect(store.reviewItems()).toHaveLength(1), { timeout: 5_000 });
    const [item] = store.reviewItems();

    await store.skip(item.key);
    expect(store.unmatchedItems()).toHaveLength(1);
    await store.reopen(item.key);
    expect(store.unmatchedItems()).toEqual([]);
    const [again] = store.reviewItems();
    expect(again.manual).toBeUndefined();
    expect(again.candidates).toEqual(item.candidates);

    // Search again: fresh suggestions replace the old ones.
    const fresh = { ...match, id: 'remote:fresh', artist: 'Someone Else' };
    vi.mocked(remote.searchSite).mockResolvedValue([fresh]);
    await store.research(item.key);
    expect(store.searching().size).toBe(0);
    expect(store.reviewItems()[0].candidates?.map((c) => c.track.id)).toEqual([fresh.id]);

    await store.deleteImportData();
  }, 15_000);

  it('"Also add to Liked Songs" saves playlist tracks and the save follows a reviewed match', async () => {
    const other = { ...match, id: 'remote:other', artist: 'Someone Else' };
    const remote = {
      configured: true,
      configure: () => undefined,
      searchSite: vi.fn(async () => [other]),
    } as unknown as RemoteServerPort;
    TestBed.configureTestingModule({
      providers: [
        { provide: StoragePort, useValue: createInMemoryStorage() },
        { provide: MusicSourceRegistry, useValue: new MusicSourceRegistry() },
        { provide: RemoteServerPort, useValue: remote },
      ],
    });
    const store = TestBed.inject(ImportStore);
    const library = TestBed.inject(LibraryStore);
    const song = { title: 'Midnight City', artists: ['M83'], artist: 'M83', durationMs: 243_000, spotifyId: SPOTIFY_ID };
    await store.start({ playlists: [{ name: 'Pasted', tracks: [song] }], liked: [] }, { likeAll: true });
    expect(library.savedIds()).toEqual([`spotify:${SPOTIFY_ID}`]);

    await vi.waitFor(() => expect(store.reviewItems()).toHaveLength(1), { timeout: 5_000 });
    await store.acceptCandidate(store.reviewItems()[0].key, other.id);
    expect(library.savedIds()).toEqual([other.id]);
    await store.deleteImportData();
  }, 15_000);
});
