import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { Track } from '@open-record/models';
import { PlayerService } from '@open-record/player';
import { StoragePort, createInMemoryStorage } from '@open-record/storage';
import { LibraryStore } from './library.store';
import { PlayCountsStore } from './play-counts.store';
import { PlaylistsStore } from './playlists.store';
import { PlayerStore, QUEUE_SAVE_INTERVAL_MS } from './player.store';

const queue: Track[] = [
  { id: 'fake:a', providerId: 'fake', title: 'A', artist: 'X' },
  { id: 'fake:b', providerId: 'fake', title: 'B', artist: 'Y' },
];

/** Just enough of `PlayerService`'s engine for `PlayerStore`. */
function fakeEngine() {
  return {
    queue: signal<readonly Track[]>([]),
    currentIndex: signal(-1),
    playNextIndices: signal<readonly number[]>([]),
    shuffle: signal(false),
    repeat: signal('off'),
    status: signal('idle'),
    position: signal(0),
    canSetVolume: false,
    lastPlay: signal<{ seq: number; track: Track; at: number } | null>(null),
  };
}

describe('PlayerStore queue persistence', () => {
  beforeEach(() => TestBed.resetTestingModule());
  afterEach(() => vi.useRealTimers());

  it('does not rewrite the queue on every position tick, and saves the exact position on pause', async () => {
    const engine = fakeEngine();
    const storage = createInMemoryStorage();
    const save = vi.spyOn(storage.queueState, 'save');
    TestBed.configureTestingModule({
      providers: [
        { provide: StoragePort, useValue: storage },
        { provide: PlayerService, useValue: { engine } },
        { provide: LibraryStore, useValue: { ready: async () => undefined } },
        { provide: PlaylistsStore, useValue: {} },
      ],
    });
    const player = TestBed.inject(PlayerStore);
    await player.restore();

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    engine.queue.set(queue);
    engine.currentIndex.set(0);
    engine.status.set('playing');
    TestBed.tick();
    await vi.advanceTimersByTimeAsync(QUEUE_SAVE_INTERVAL_MS);
    expect(save).toHaveBeenCalledTimes(1);

    // Ticks inside one 10 s bucket schedule no writes.
    for (let sec = 1; sec <= 9; sec++) {
      engine.position.set(sec);
      TestBed.tick();
      await vi.advanceTimersByTimeAsync(1000);
    }
    expect(save).toHaveBeenCalledTimes(1);

    // Pausing saves the exact position, not the 10 s bucket.
    engine.position.set(9.6);
    engine.status.set('paused');
    TestBed.tick();
    await vi.advanceTimersByTimeAsync(QUEUE_SAVE_INTERVAL_MS);
    expect(save).toHaveBeenCalledTimes(2);
    expect(save.mock.lastCall?.[0]).toMatchObject({
      trackIds: ['fake:a', 'fake:b'],
      positionSec: 9,
    });
  });

  it('hands each counted play to the counts store exactly once', async () => {
    const engine = fakeEngine();
    const recordPlay = vi.fn(async () => undefined);
    TestBed.configureTestingModule({
      providers: [
        { provide: StoragePort, useValue: createInMemoryStorage() },
        { provide: PlayerService, useValue: { engine } },
        { provide: LibraryStore, useValue: { ready: async () => undefined } },
        { provide: PlaylistsStore, useValue: {} },
        { provide: PlayCountsStore, useValue: { recordPlay } },
      ],
    });
    TestBed.inject(PlayerStore);

    const play = { seq: 1, track: queue[0], at: 1700000000000 };
    engine.lastPlay.set(play);
    TestBed.tick();
    await Promise.resolve();
    // A rebuilt object with the same seq is not a new play.
    engine.lastPlay.set({ ...play });
    TestBed.tick();
    await Promise.resolve();

    expect(recordPlay).toHaveBeenCalledTimes(1);
    expect(recordPlay).toHaveBeenCalledWith(play.track, play.at);
  });
});
