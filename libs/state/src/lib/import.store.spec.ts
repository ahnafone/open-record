import { TestBed } from '@angular/core/testing';
import type { Track } from '@open-record/models';
import { MusicSourceRegistry } from '@open-record/music-source';
import { SETTINGS_KEYS, StoragePort, createInMemoryStorage } from '@open-record/storage';
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

describe('youtube import', () => {
  const yt = (v: string, title: string, withLink = true): Track => ({
    id: `remote:https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3D${v}`,
    providerId: 'remote',
    title,
    artist: 'Uploader',
    durationSec: 200,
    ...(withLink ? { source: { site: 'youtube', url: `https://www.youtube.com/watch?v=${v}` } } : { providerId: 'other' }),
  });

  function setup(remote: Partial<RemoteServerPort>, storage = createInMemoryStorage()) {
    TestBed.configureTestingModule({
      providers: [
        { provide: StoragePort, useValue: storage },
        { provide: MusicSourceRegistry, useValue: new MusicSourceRegistry() },
        { provide: RemoteServerPort, useValue: { configured: true, configure: () => undefined, ...remote } },
      ],
    });
    return {
      store: TestBed.inject(ImportStore),
      library: TestBed.inject(LibraryStore),
      playlists: TestBed.inject(PlaylistsStore),
    };
  }

  it('auto-applies confident details, sends weak ones to review, keeps originals and likes playlist songs', async () => {
    const a = yt('a', 'M83 - Midnight City (Official Video)');
    const b = yt('b', 'some upload');
    const c = yt('c', 'unknown thing');
    const enrich = vi.fn(async () => [
      { title: 'Midnight City', artist: 'M83', album: 'Hurry Up', confidence: 0.95, sources: ['ytmusic' as const] },
      { title: 'Maybe Song', artist: 'Maybe Artist', confidence: 0.6, sources: ['itunes' as const] },
      null,
    ]);
    const { store, library, playlists } = setup({
      importPlaylist: vi.fn(async () => ({ title: 'Mix', url: 'u', site: 'youtube', tracks: [a, b, c], unavailable: 0, truncated: false })),
      enrich,
    });

    const summary = await store.startYoutube('https://www.youtube.com/playlist?list=x', undefined, { likeToo: true });
    expect(summary).toMatchObject({ single: false, added: 3 });
    expect(playlists.playlists()[0].trackIds).toEqual([a.id, b.id, c.id]);
    expect(new Set(library.savedIds())).toEqual(new Set([a.id, b.id, c.id]));
    expect(store.source()).toEqual({ kind: 'youtube', label: 'Mix' });

    await vi.waitFor(() => expect(store.progress()).toMatchObject({ matched: 2, review: 1, pending: 0 }));
    expect(library.track(a.id)).toMatchObject({ title: 'Midnight City', artist: 'M83', album: 'Hurry Up' });
    expect(library.track(c.id)?.title).toBe('unknown thing');
    const [review] = store.reviewItems();
    expect(review).toMatchObject({ key: b.id, origin: 'youtube', state: 'review' });
    expect(review.candidates).toBeUndefined();
    expect(review.metaCandidates?.[0]).toMatchObject({ title: 'Maybe Song', score: 0.6 });

    await store.acceptMetadata(b.id, review.metaCandidates?.[0].id ?? '');
    expect(library.track(b.id)).toMatchObject({ id: b.id, title: 'Maybe Song', artist: 'Maybe Artist' });
    expect(store.progress()).toMatchObject({ matched: 3, review: 0 });
    await store.deleteImportData();
    expect(library.track(a.id)).toBeDefined();
  });

  it('a song whose link failed is unmatched and can be fixed by pasting a link', async () => {
    const broken = yt('x', 'Lost Song', false);
    const fixed = yt('y', 'Lost Song (re-upload)');
    const { store, library } = setup({
      importPlaylist: vi.fn(async () => ({ title: 'Lost Song', url: 'u', site: 'youtube', tracks: [broken], unavailable: 0, truncated: false, single: true })),
      enrich: vi.fn(async () => [null]),
      resolveUrl: vi.fn(async () => fixed),
    });
    const summary = await store.startYoutube('https://youtu.be/x', undefined, { likeToo: true });
    expect(summary.single).toBe(true);
    expect(library.savedIds()).toEqual([broken.id]);
    await vi.waitFor(() => expect(store.unmatchedItems()).toHaveLength(1));
    expect(store.unmatchedItems()[0].linkError).toBeTruthy();
    await expect(store.keepOriginal(broken.id)).rejects.toThrow();

    await store.useLink(broken.id, 'https://www.youtube.com/watch?v=y');
    expect(store.progress()).toMatchObject({ matched: 1, unmatched: 0 });
    expect(store.resolveId(broken.id)).toBe(fixed.id);
    expect(library.savedIds()).toEqual([fixed.id]);
    expect(library.track(fixed.id)?.title).toBe('Lost Song');
    await store.deleteImportData();
  });

  it('loads jobs where youtube songs were stored as matched', async () => {
    const storage = createInMemoryStorage();
    const old = yt('o', 'Old');
    await storage.settings.set(SETTINGS_KEYS.spotifyImport, {
      version: 1,
      status: 'done',
      cache: {},
      items: [{ key: old.id, title: 'Old', artists: [], artist: 'Unknown artist', state: 'matched', origin: 'youtube' }],
    });
    const { store } = setup({}, storage);
    await store.ready();
    expect(store.progress()).toMatchObject({ total: 1, matched: 1 });
    expect(store.needsAttention()).toBe(false);
  });
});
