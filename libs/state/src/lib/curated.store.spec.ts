import { computed, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { Track } from '@open-record/models';
import type { PlayCountRecord } from '@open-record/storage';
import { CuratedStore, RECENTLY_PLAYED_ID } from './curated.store';
import { LibraryStore } from './library.store';
import { PlayCountsStore } from './play-counts.store';

const a: Track = { id: 'fake:a', providerId: 'fake', title: 'A', artist: 'X' };
const b: Track = { ...a, id: 'fake:b', title: 'B' };
const c: Track = { ...a, id: 'fake:c', title: 'C' };

function entry(
  trackId: string,
  lastPlayedAt: number,
  track?: Track,
): PlayCountRecord {
  return {
    trackId,
    count: 0,
    pending: 0,
    firstPlayedAt: lastPlayedAt - 50,
    lastPlayedAt,
    ...(track ? { track } : {}),
  };
}

function boot(
  records: readonly PlayCountRecord[],
  known: readonly Track[] = [],
): CuratedStore {
  const recentlyPlayed = signal<readonly PlayCountRecord[]>(records);
  const trackMap = computed(() => new Map(known.map((t) => [t.id, t])));
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      {
        provide: PlayCountsStore,
        useValue: { ready: async () => undefined, recentlyPlayed },
      },
      {
        provide: LibraryStore,
        useValue: { ready: async () => undefined, trackMap },
      },
    ],
  });
  return TestBed.inject(CuratedStore);
}

describe('CuratedStore', () => {
  it('lists the app-curated playlists for the sidebar', () => {
    const store = boot([]);

    expect(store.playlists.map((p) => p.id)).toEqual([RECENTLY_PLAYED_ID]);
    expect(store.playlist(RECENTLY_PLAYED_ID)).toMatchObject({
      name: 'Recently Played',
      description: 'Records you have played recently, newest first.',
    });
    expect(store.playlist('weekly-mix')).toBeUndefined();
  });

  it('keeps the most recently played rows first and totals them', () => {
    const store = boot([entry('fake:b', 300, b), entry('fake:a', 100, a)]);

    expect(store.entriesOf(RECENTLY_PLAYED_ID).map((e) => e.track.id)).toEqual([
      'fake:b',
      'fake:a',
    ]);
    expect(
      store.entriesOf(RECENTLY_PLAYED_ID).map((e) => e.lastPlayedAt),
    ).toEqual([300, 100]);
    expect(store.totalOf(RECENTLY_PLAYED_ID)).toBe(2);
  });

  it('resolves a missing snapshot through the library and skips unknown ids', () => {
    // `fake:d` is neither snapshotted nor known to the library.
    const store = boot(
      [entry('fake:c', 300), entry('fake:d', 200), entry('fake:a', 100, a)],
      [c, a],
    );

    const rows = store.entriesOf(RECENTLY_PLAYED_ID);
    expect(rows.map((e) => e.track.id)).toEqual(['fake:c', 'fake:a']);
    expect(rows[0].track).toBe(c);
  });

  it('finds when a track was last played in a list', () => {
    const store = boot([entry('fake:a', 100, a)]);

    expect(store.lastPlayedAtOf(RECENTLY_PLAYED_ID, 'fake:a')).toBe(100);
    expect(store.lastPlayedAtOf(RECENTLY_PLAYED_ID, 'fake:b')).toBeUndefined();
    expect(store.lastPlayedAtOf('weekly-mix', 'fake:a')).toBeUndefined();
  });

  it('has no rows for an unknown list', () => {
    const store = boot([entry('fake:a', 100, a)]);

    expect(store.entriesOf('weekly-mix')).toEqual([]);
    expect(store.totalOf('weekly-mix')).toBe(0);
  });
});
