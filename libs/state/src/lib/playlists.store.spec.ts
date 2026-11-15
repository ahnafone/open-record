import { TestBed } from '@angular/core/testing';
import type { Playlist, Track } from '@open-record/models';
import { MusicSourceRegistry } from '@open-record/music-source';
import { StoragePort, createInMemoryStorage } from '@open-record/storage';
import { OfflineStore } from './offline.store';
import { PlaylistsStore } from './playlists.store';

const t = (id: string, genre?: string): Track => ({
  id: `remote:${id}`,
  providerId: 'remote',
  title: id,
  artist: 'A',
  source: { site: 'ytmusic', url: `https://music.youtube.com/watch?v=${id}` },
  ...(genre === undefined ? {} : { genre }),
});

describe('PlaylistsStore.createGenrePlaylists', () => {
  function setup() {
    const storage = createInMemoryStorage();
    TestBed.configureTestingModule({
      providers: [
        { provide: StoragePort, useValue: storage },
        { provide: MusicSourceRegistry, useValue: new MusicSourceRegistry() },
      ],
    });
    const store = TestBed.inject(PlaylistsStore);
    const offline = TestBed.inject(OfflineStore);
    const ensureSaved = vi.spyOn(offline, 'ensureSaved');
    return { store, storage, ensureSaved };
  }

  it('creates a private genre playlist without saving or downloading tracks', async () => {
    const { store, ensureSaved } = setup();
    const tracks = [t('1', 'Rock'), t('2', 'Rock'), t('3', 'Rock')];

    const result = await store.createGenrePlaylists(tracks);

    expect(result).toEqual({ created: 1, updated: 0, added: 0 });
    const [pl] = store.playlists();
    expect(pl).toMatchObject({
      name: 'Rock',
      genre: 'Rock',
      visibility: 'private',
      trackIds: tracks.map((x) => x.id),
    });
    expect(Object.keys(pl.addedAt ?? {})).toHaveLength(3);
    expect(ensureSaved).not.toHaveBeenCalled();
  });

  it('tops up the genre playlist by marker and never removes tracks', async () => {
    const { store } = setup();
    await store.createGenrePlaylists([t('1', 'Rock'), t('2', 'Rock'), t('3', 'Rock')]);
    const id = store.playlists()[0].id;
    await store.removeTrack(id, 'remote:2');

    const result = await store.createGenrePlaylists([
      t('1', 'Rock'),
      t('3', 'Rock'),
      t('4', 'Rock'),
      t('5', 'Rock'),
    ]);

    expect(result).toEqual({ created: 0, updated: 1, added: 2 });
    expect(store.playlists()).toHaveLength(1);
    expect(store.playlist(id)?.trackIds).toEqual([
      'remote:1',
      'remote:3',
      'remote:4',
      'remote:5',
    ]);
    const again = await store.createGenrePlaylists([t('1', 'Rock'), t('3', 'Rock'), t('4', 'Rock')]);
    expect(again).toEqual({ created: 0, updated: 0, added: 0 });
  });

  it('adopts an unmarked private playlist with the same name instead of duplicating it', async () => {
    const { store } = setup();
    const mine = await store.create('  ROCK ');
    await store.addTracks(mine.id, ['remote:9']);

    const result = await store.createGenrePlaylists([t('1', 'Rock'), t('2', 'Rock'), t('3', 'Rock')]);

    expect(result).toEqual({ created: 0, updated: 1, added: 3 });
    expect(store.playlists()).toHaveLength(1);
    expect(store.playlist(mine.id)).toMatchObject({
      name: 'ROCK',
      genre: 'Rock',
      trackIds: ['remote:9', 'remote:1', 'remote:2', 'remote:3'],
    });
    expect(await store.createGenrePlaylists([t('1', 'Rock'), t('2', 'Rock'), t('3', 'Rock')])).toEqual({
      created: 0,
      updated: 0,
      added: 0,
    });
  });

  it('never adopts a playlist that carries a different genre marker', async () => {
    const { store } = setup();
    await store.createGenrePlaylists([t('1', 'Jazz'), t('2', 'Jazz'), t('3', 'Jazz')]);
    const jazz = store.playlists()[0];
    await store.rename(jazz.id, 'Rock');

    const result = await store.createGenrePlaylists([t('4', 'Rock'), t('5', 'Rock'), t('6', 'Rock')]);

    expect(result.created).toBe(1);
    expect(store.playlists()).toHaveLength(2);
    expect(store.playlist(jazz.id)).toMatchObject({ genre: 'Jazz', trackIds: ['remote:1', 'remote:2', 'remote:3'] });
  });

  it('never adopts a public playlist with the same name', async () => {
    const { store } = setup();
    const mine = await store.create('Rock', 'public');

    const result = await store.createGenrePlaylists([t('1', 'Rock'), t('2', 'Rock'), t('3', 'Rock')]);

    expect(result.created).toBe(1);
    expect(store.playlist(mine.id)).toMatchObject({ visibility: 'public', trackIds: [] });
    expect(store.playlist(mine.id)?.genre).toBeUndefined();
  });

  it('matches an existing marker case-insensitively', async () => {
    const { store } = setup();
    await store.createGenrePlaylists([t('1', 'Rock'), t('2', 'Rock'), t('3', 'Rock')]);

    const result = await store.createGenrePlaylists([t('1', 'rock'), t('4', ' ROCK '), t('5', 'rock')]);

    expect(result).toEqual({ created: 0, updated: 1, added: 2 });
    expect(store.playlists()).toHaveLength(1);
    expect(store.playlists()[0].genre).toBe('Rock');
  });

  it('keeps the genre marker when the cloud copy overwrites the playlist', async () => {
    const { store, storage } = setup();
    await store.createGenrePlaylists([t('1', 'Rock'), t('2', 'Rock'), t('3', 'Rock')]);
    const local = store.playlists()[0];
    // The cloud copy never carries the local-only marker.
    const cloud: Playlist = {
      id: local.id,
      name: 'Rock (cloud)',
      visibility: 'private',
      trackIds: ['remote:1', 'remote:9'],
      createdAt: local.createdAt,
      updatedAt: local.updatedAt + 1000,
    };

    await store.applySynced(cloud);

    expect(store.playlist(local.id)).toMatchObject({
      name: 'Rock (cloud)',
      trackIds: ['remote:1', 'remote:9'],
      genre: 'Rock',
    });
    const stored = (await storage.playlists.list()).find((p) => p.id === local.id);
    expect(stored?.genre).toBe('Rock');
  });

  it('skips genres under three tracks and tracks without genre', async () => {
    const { store } = setup();

    const result = await store.createGenrePlaylists([
      t('1', 'Jazz'),
      t('2', 'Jazz'),
      t('3'),
      t('4', 'Pop'),
      t('5', 'Pop'),
      t('6', 'Pop'),
    ]);

    expect(result).toEqual({ created: 1, updated: 0, added: 0 });
    expect(store.playlists().map((p) => p.genre)).toEqual(['Pop']);
  });
});
