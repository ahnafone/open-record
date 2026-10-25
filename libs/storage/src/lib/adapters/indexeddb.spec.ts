import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { Playlist } from '@open-record/models';
import { COLLECTIONS, MIGRATIONS, Migration } from '../migrations';
import { createIndexedDbStorage } from './indexeddb';

describe('IndexedDB storage', () => {
  beforeEach(() => {
    globalThis.indexedDB = new IDBFactory();
  });

  it('round-trips every repository across a reopen', async () => {
    const playlist: Playlist = {
      id: 'p1',
      name: 'Late night',
      visibility: 'private',
      trackIds: ['catalog:a', 'catalog:b'],
      createdAt: 1,
      updatedAt: 2,
    };
    const first = createIndexedDbStorage('test-db');
    await first.playlists.save(playlist);
    await first.savedRecords.add('catalog:a');
    await first.importedTracks.save({
      track: {
        id: 'local:1',
        providerId: 'local',
        title: 'Tape',
        artist: 'Me',
      },
      filePath: 'imports/1.mp3',
      importedAt: 5,
    });
    await first.queueState.save({
      trackIds: ['catalog:a'],
      index: 0,
      positionSec: 42.5,
      shuffle: true,
      repeat: 'all',
    });
    await first.settings.set('volume', 0.8);
    await first.close();

    const second = createIndexedDbStorage('test-db');
    expect(await second.playlists.list()).toEqual([playlist]);
    expect(await second.savedRecords.list()).toEqual(['catalog:a']);
    expect(await second.savedRecords.has('catalog:b')).toBe(false);
    expect((await second.importedTracks.get('local:1'))?.filePath).toBe(
      'imports/1.mp3',
    );
    expect((await second.queueState.get())?.positionSec).toBe(42.5);
    expect(await second.settings.get<number>('volume')).toBe(0.8);

    await second.playlists.delete('p1');
    await second.savedRecords.remove('catalog:a');
    await second.queueState.clear();
    expect(await second.playlists.list()).toEqual([]);
    expect(await second.savedRecords.list()).toEqual([]);
    expect(await second.queueState.get()).toBeUndefined();
    await second.close();
  });

  it('runs a new migration on an existing database inside the upgrade', async () => {
    const v1 = createIndexedDbStorage('mig-db');
    await v1.settings.set('theme', 'dark');
    await v1.close();

    const v2: Migration = {
      version: MIGRATIONS.length + 1,
      description: 'prefix settings',
      async up(ctx) {
        for (const [key, value] of await ctx.entries(COLLECTIONS.settings)) {
          await ctx.delete(COLLECTIONS.settings, key);
          await ctx.put(COLLECTIONS.settings, `ui.${key}`, value);
        }
      },
    };
    const upgraded = createIndexedDbStorage('mig-db', [...MIGRATIONS, v2]);
    expect(await upgraded.settings.get('ui.theme')).toBe('dark');
    expect(await upgraded.settings.get('theme')).toBeUndefined();
    await upgraded.close();
  });
});
