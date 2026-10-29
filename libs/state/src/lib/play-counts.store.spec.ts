import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { Track } from '@open-record/models';
import { PlayerService } from '@open-record/player';
import { StoragePort, createInMemoryStorage } from '@open-record/storage';
import { AuthStore } from './auth.store';
import { LibraryStore } from './library.store';
import { PlayCountsStore } from './play-counts.store';
import { PlaylistsStore } from './playlists.store';
import {
  AuthPort,
  PlayCountsPort,
  type SyncPlayCount,
  type SyncPlayIncrement,
} from './ports';

const track: Track = {
  id: 'fake:a',
  providerId: 'fake',
  title: 'A',
  artist: 'X',
};
const localTrack: Track = {
  id: 'local:x',
  providerId: 'local',
  title: 'Mine',
  artist: 'Me',
};

function fakeAuth(signedIn: boolean): AuthPort {
  return {
    activeProject: async () => ({
      url: 'https://x.supabase.co',
      anonKey: 'anon',
    }),
    restore: async () => (signedIn ? { id: 'u1' } : null),
    signIn: async () => ({ id: 'u1' }),
    onChange: () => () => undefined,
    onRecovery: () => () => undefined,
  } as unknown as AuthPort;
}

/** A fake port that acknowledges every increment with `total` plays. */
function fakePort(total: number, remote: SyncPlayCount[] = []) {
  const received: SyncPlayIncrement[][] = [];
  const port: PlayCountsPort = {
    userId: async () => 'u1',
    pull: async () => remote.map((r) => ({ ...r })),
    record: async (plays) => {
      received.push(plays.map((p) => ({ ...p })));
      return plays.map((p) => ({
        trackId: p.trackId,
        count: total,
        firstPlayedAt: p.at - 1,
        lastPlayedAt: p.at,
      }));
    },
  };
  return { port, received };
}

function boot(opts: { signedIn: boolean; port: PlayCountsPort }) {
  const storage = createInMemoryStorage();
  const engine = {
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
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      { provide: StoragePort, useValue: storage },
      { provide: PlayerService, useValue: { engine } },
      { provide: LibraryStore, useValue: { ready: async () => undefined } },
      { provide: PlaylistsStore, useValue: {} },
      { provide: AuthPort, useValue: fakeAuth(opts.signedIn) },
      { provide: PlayCountsPort, useValue: opts.port },
    ],
  });
  const auth = TestBed.inject(AuthStore);
  const store = TestBed.inject(PlayCountsStore);
  return { storage, auth, store, ready: auth.start() };
}

describe('PlayCountsStore', () => {
  afterEach(() => vi.useRealTimers());

  it('counts plays on this device while signed out', async () => {
    const { port } = fakePort(0);
    const { storage, store, ready } = boot({ signedIn: false, port });
    await ready;

    await store.recordPlay(track, 100);
    await store.recordPlay(track, 200);

    expect(store.count('fake:a')).toBe(2);
    expect(store.counts().get('fake:a')).toMatchObject({
      count: 2,
      pending: 2,
      firstPlayedAt: 100,
      lastPlayedAt: 200,
      track: { id: 'fake:a', title: 'A' },
    });
    expect(await storage.playCounts.get('fake:a')).toMatchObject({
      count: 2,
      pending: 2,
    });
  });

  it('uploads pending plays on flush and takes the account total', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { port, received } = fakePort(10);
    const { store, ready } = boot({ signedIn: true, port });
    await ready;

    await store.recordPlay(track, 100);
    await store.recordPlay(track, 200);
    await store.flush();

    expect(received).toHaveLength(1);
    expect(received[0]).toHaveLength(1);
    expect(received[0][0]).toMatchObject({
      trackId: 'fake:a',
      count: 2,
      firstPlayedAt: 100,
      at: 200,
      track: { id: 'fake:a', title: 'A', artist: 'X' },
    });
    expect(store.counts().get('fake:a')).toMatchObject({
      count: 10,
      pending: 0,
      lastPlayedAt: 200,
    });
    expect(store.mostPlayed().map((r) => r.trackId)).toEqual(['fake:a']);
  });

  it('merges the account totals without losing unflushed plays', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const remote: SyncPlayCount[] = [
      { trackId: 'fake:a', count: 10, firstPlayedAt: 5, lastPlayedAt: 50 },
    ];
    const { port } = fakePort(10, remote);
    const { store, ready } = boot({ signedIn: true, port });
    await ready;

    await store.recordPlay(track, 100);
    await store.recordPlay(track, 200);
    await store.pull();

    expect(store.counts().get('fake:a')).toMatchObject({
      count: 10,
      pending: 2,
      firstPlayedAt: 5,
      lastPlayedAt: 200,
    });
  });

  it('never uploads local file tracks', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { port, received } = fakePort(10);
    const { storage, store, ready } = boot({ signedIn: true, port });
    await ready;

    await store.recordPlay(localTrack, 100);
    await store.recordPlay(localTrack, 200);
    await store.flush();

    expect(received).toEqual([]);
    expect(store.count('local:x')).toBe(2);
    expect(await storage.playCounts.get('local:x')).toMatchObject({
      count: 2,
      pending: 0,
    });
  });

  it('uploads plays recorded signed out on the first sign-in', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { port, received } = fakePort(1);
    const { auth, store, ready } = boot({ signedIn: false, port });
    await ready;
    store.start();

    await store.recordPlay(track, 100);
    await store.recordPlay(track, 200);
    expect(received).toEqual([]);

    await auth.signIn('listener@example.com', 'secret1');
    TestBed.tick();
    await vi.waitFor(() => expect(received).toHaveLength(1));

    expect(received[0][0]).toMatchObject({ trackId: 'fake:a', count: 2 });
    await vi.waitFor(() =>
      expect(store.counts().get('fake:a')).toMatchObject({
        count: 2,
        pending: 0,
      }),
    );
  });

  it('keeps plays pending when an upload fails and retries them once', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let calls = 0;
    const received: SyncPlayIncrement[][] = [];
    const port: PlayCountsPort = {
      userId: async () => 'u1',
      pull: async () => [],
      record: async (plays) => {
        calls++;
        if (calls === 1) throw new Error('offline');
        received.push(plays.map((p) => ({ ...p })));
        return plays.map((p) => ({
          trackId: p.trackId,
          count: 5,
          firstPlayedAt: p.at,
          lastPlayedAt: p.at,
        }));
      },
    };
    const { store, ready } = boot({ signedIn: true, port });
    await ready;

    await store.recordPlay(track, 100);
    await expect(store.flush()).rejects.toThrow('offline');
    expect(store.counts().get('fake:a')?.pending).toBe(1);

    await store.flush();

    expect(received).toHaveLength(1);
    expect(received[0][0]).toMatchObject({ trackId: 'fake:a', count: 1 });
    expect(store.counts().get('fake:a')).toMatchObject({
      count: 5,
      pending: 0,
    });
  });

  it('clears every count so deleted history cannot be written back', async () => {
    const { storage, store, ready } = boot({
      signedIn: false,
      port: fakePort(0).port,
    });
    await ready;
    await store.recordPlay(track, 100);

    await store.clear();

    expect(store.counts().size).toBe(0);
    expect(await storage.playCounts.list()).toEqual([]);

    // The next play starts from zero again instead of restoring the old count.
    await store.recordPlay(track, 200);
    expect(store.count('fake:a')).toBe(1);
  });

  it('does not lose a play recorded at the same time as another', async () => {
    const { store, ready } = boot({
      signedIn: false,
      port: fakePort(0).port,
    });
    await ready;

    await Promise.all([
      store.recordPlay(track, 100),
      store.recordPlay(track, 200),
    ]);

    expect(store.counts().get('fake:a')).toMatchObject({
      count: 2,
      firstPlayedAt: 100,
      lastPlayedAt: 200,
    });
  });

  it('cannot be undone by a play that is still being saved', async () => {
    const { storage, store, ready } = boot({
      signedIn: false,
      port: fakePort(0).port,
    });
    await ready;

    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const realSave = storage.playCounts.save.bind(storage.playCounts);
    vi.spyOn(storage.playCounts, 'save').mockImplementation(async (record) => {
      await gate;
      await realSave(record);
    });

    const playing = store.recordPlay(track, 100);
    const clearing = store.clear();
    release();
    await Promise.all([playing, clearing]);

    expect(store.counts().size).toBe(0);
    expect(await storage.playCounts.list()).toEqual([]);
  });

  it('keeps a play recorded while a pull is in flight', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const port: PlayCountsPort = {
      userId: async () => 'u1',
      pull: async () => {
        await gate;
        return [
          { trackId: 'fake:a', count: 3, firstPlayedAt: 10, lastPlayedAt: 20 },
        ];
      },
      record: async () => [],
    };
    const { store, ready } = boot({ signedIn: true, port });
    await ready;

    const pulling = store.pull();
    await store.recordPlay(track, 100);
    release();
    await pulling;

    expect(store.counts().get('fake:a')).toMatchObject({
      count: 3,
      pending: 1,
      firstPlayedAt: 10,
      lastPlayedAt: 100,
    });
  });

  it('keeps a play recorded while a flush is in flight pending', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const port: PlayCountsPort = {
      userId: async () => 'u1',
      pull: async () => [],
      record: async (plays) => {
        const snapshot = plays.map((p) => ({ ...p }));
        await gate;
        return snapshot.map((p) => ({
          trackId: p.trackId,
          count: 5,
          firstPlayedAt: p.firstPlayedAt,
          lastPlayedAt: p.at,
        }));
      },
    };
    const { store, ready } = boot({ signedIn: true, port });
    await ready;
    await store.recordPlay(track, 100);

    const flushing = store.flush();
    await store.recordPlay(track, 200);
    release();
    await flushing;

    expect(store.counts().get('fake:a')).toMatchObject({
      count: 5,
      pending: 1,
      lastPlayedAt: 200,
    });
  });

  it('drops a pull that lands after a clear', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const port: PlayCountsPort = {
      userId: async () => 'u1',
      pull: async () => {
        await gate;
        return [
          { trackId: 'fake:a', count: 9, firstPlayedAt: 5, lastPlayedAt: 50 },
        ];
      },
      record: async () => [],
    };
    const { store, ready } = boot({ signedIn: true, port });
    await ready;

    const pulling = store.pull();
    await store.clear();
    release();
    await pulling;

    expect(store.counts().size).toBe(0);
  });

  it('drops a pull whose account changed while it was in flight', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let account = 'u1';
    const port: PlayCountsPort = {
      userId: async () => account,
      pull: async () => {
        await gate;
        // The account switches while the request is in flight.
        account = 'u2';
        return [
          { trackId: 'fake:a', count: 9, firstPlayedAt: 5, lastPlayedAt: 50 },
        ];
      },
      record: async () => [],
    };
    const { store, ready } = boot({ signedIn: true, port });
    await ready;

    const pulling = store.pull();
    release();
    await pulling;

    expect(store.counts().size).toBe(0);
  });

  it('keeps the old count when a move fails', async () => {
    const { storage, store, ready } = boot({
      signedIn: false,
      port: fakePort(0).port,
    });
    await ready;
    await store.recordPlay(track, 100);
    vi.spyOn(storage.playCounts, 'replace').mockRejectedValue(
      new Error('disk'),
    );

    await store.move('fake:a', 'fake:b');

    expect(store.count('fake:a')).toBe(1);
    expect(store.count('fake:b')).toBe(0);
  });

  it('repairs a count whose save was lost when its id is replaced', async () => {
    const { storage, store, ready } = boot({
      signedIn: false,
      port: fakePort(0).port,
    });
    await ready;
    await store.recordPlay(track, 100);
    // Storage lost the record (e.g. its save failed).
    await storage.playCounts.clear();

    await store.move('fake:a', 'fake:b');

    expect(store.count('fake:a')).toBe(0);
    expect(store.count('fake:b')).toBe(1);
    expect(await storage.playCounts.get('fake:b')).toMatchObject({ count: 1 });
  });

  it('sums two counts that only exist in memory when ids are merged', async () => {
    const { storage, store, ready } = boot({
      signedIn: false,
      port: fakePort(0).port,
    });
    await ready;
    const next: Track = { ...track, id: 'fake:b' };
    await store.recordPlay(track, 100);
    // The newer record is older in this case, so both ends are pinned.
    await store.recordPlay(next, 50);
    // Both saves "failed": storage has neither record.
    await storage.playCounts.clear();

    await store.move('fake:a', 'fake:b');

    expect(store.count('fake:a')).toBe(0);
    expect(store.counts().get('fake:b')).toMatchObject({
      count: 2,
      pending: 2,
      firstPlayedAt: 50,
      lastPlayedAt: 100,
      track: { id: 'fake:b' },
    });
    expect(await storage.playCounts.get('fake:b')).toMatchObject({ count: 2 });
  });

  it('keeps a known first play when merging into a record without one', async () => {
    const { storage, store, ready } = boot({
      signedIn: false,
      port: fakePort(0).port,
    });
    await ready;
    // The new id exists, but its first play is unknown (0).
    await storage.playCounts.save({
      trackId: 'fake:b',
      count: 1,
      pending: 0,
      firstPlayedAt: 0,
      lastPlayedAt: 50,
    });
    await store.recordPlay(track, 100);

    await store.move('fake:a', 'fake:b');

    expect(store.counts().get('fake:b')).toMatchObject({
      count: 2,
      firstPlayedAt: 100,
      lastPlayedAt: 100,
    });
  });

  it('moves a count when a track id is replaced', async () => {
    const { storage, store, ready } = boot({
      signedIn: false,
      port: fakePort(0).port,
    });
    await ready;
    const next: Track = { ...track, id: 'fake:b' };

    await store.recordPlay(track, 100);
    await store.recordPlay(track, 200);
    await store.recordPlay(next, 300);
    await store.move('fake:a', 'fake:b');

    expect(store.count('fake:a')).toBe(0);
    expect(store.counts().get('fake:b')).toMatchObject({
      count: 3,
      firstPlayedAt: 100,
      lastPlayedAt: 300,
    });
    expect(await storage.playCounts.get('fake:a')).toBeUndefined();
    expect(await storage.playCounts.get('fake:b')).toMatchObject({ count: 3 });
  });
});
