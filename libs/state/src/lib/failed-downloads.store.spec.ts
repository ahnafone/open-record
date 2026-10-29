import { computed, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { Track } from '@open-record/models';
import { FailedDownloadsStore } from './failed-downloads.store';
import { ImportSessionsStore } from './import-sessions.store';
import { ImportStore } from './import.store';
import { LibraryStore } from './library.store';
import { OfflineStore } from './offline.store';
import { PlayerStore } from './player.store';
import { PlaylistsStore } from './playlists.store';

describe('failed downloads store', () => {
  it('keeps a track listed while its retry is queued and drops it once saved', async () => {
    TestBed.resetTestingModule();
    const track: Track = {
      id: 'remote:retry',
      providerId: 'remote',
      title: 'Song',
      artist: 'Artist',
      source: { site: 'youtube', url: 'https://www.youtube.com/watch?v=abcdefghijk' },
    };
    const status = signal<'failed' | 'queued' | 'saving' | 'saved'>('failed');
    const error = signal<string | undefined>('Video unavailable');
    let finish!: () => void;
    const retry = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    TestBed.configureTestingModule({
      providers: [
        { provide: LibraryStore, useValue: { importedTracks: computed(() => [track]) } },
        {
          provide: OfflineStore,
          useValue: { status: () => status(), error: () => error(), retry },
        },
        { provide: PlaylistsStore, useValue: {} },
        { provide: PlayerStore, useValue: {} },
        { provide: ImportSessionsStore, useValue: {} },
        { provide: ImportStore, useValue: {} },
      ],
    });
    const store = TestBed.inject(FailedDownloadsStore);

    expect(store.tracks()).toEqual([track]);
    expect(store.listed()).toEqual([track]);
    expect(store.isRetrying(track.id)).toBe(false);

    const retried = store.retry(track.id);
    // The record write is still in flight: the row must not drop.
    expect(store.isRetrying(track.id)).toBe(false);
    expect(store.listed()).toEqual([track]);
    expect(store.tracks()).toEqual([track]);

    status.set('queued');
    expect(store.isRetrying(track.id)).toBe(true);
    expect(store.listed()).toEqual([track]);
    expect(store.tracks()).toEqual([]);

    finish();
    await retried;
    status.set('saved');
    expect(store.isRetrying(track.id)).toBe(false);
    expect(store.listed()).toEqual([]);

    status.set('failed');
    error.set('Video unavailable');
    expect(store.listed()).toEqual([track]);
    expect(store.isRetrying(track.id)).toBe(false);
    expect(retry).toHaveBeenCalledWith(track.id);
  });
});
