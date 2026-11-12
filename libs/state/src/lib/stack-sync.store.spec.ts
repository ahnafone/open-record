import { computed, signal, type WritableSignal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { Track } from '@open-record/models';
import type { StackEntry } from '@open-record/player';
import { PlayerStore } from './player.store';
import {
  SETTINGS_KEYS,
  StoragePort,
  createInMemoryStorage,
  type JsonValue,
} from '@open-record/storage';
import { AuthStore } from './auth.store';
import { StackSyncStore, planPositions } from './stack-sync.store';
import {
  AuthPort,
  StackSyncPort,
  type SyncStackEntry,
  type SyncStackMove,
} from './ports';

const a: Track = {
  id: 'remote:a',
  providerId: 'remote',
  title: 'A',
  artist: 'X',
};
const b: Track = {
  id: 'remote:b',
  providerId: 'remote',
  title: 'B',
  artist: 'Y',
};

const entry = (entryId: string, track: Track): StackEntry => ({
  entryId,
  track,
});

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

/** A fake cloud copy: records every push, serves `remote` on pull. */
function fakePort(remote: SyncStackEntry[] = []) {
  const pushes: {
    upsert: SyncStackEntry[];
    move: SyncStackMove[];
    remove: string[];
  }[] = [];
  const port = {
    userId: async () => 'u1',
    pull: vi.fn(async () => remote.map((r) => ({ ...r }))),
    push: vi.fn(
      async (changes: {
        upsert: SyncStackEntry[];
        move: SyncStackMove[];
        remove: string[];
      }) => {
        pushes.push({
          upsert: changes.upsert.map((r) => ({ ...r })),
          move: changes.move.map((m) => ({ ...m })),
          remove: [...changes.remove],
        });
        return { rejected: [] };
      },
    ),
  } as unknown as StackSyncPort & {
    pull: ReturnType<typeof vi.fn>;
    push: ReturnType<typeof vi.fn>;
  };
  return { port, pushes };
}

/**
 * `user` swaps in a settable account (AuthStore stand-in) so a test can sign
 * out while a push is in flight.
 */
function boot(opts: {
  signedIn: boolean;
  port: StackSyncPort;
  user?: WritableSignal<{ id: string } | null>;
}) {
  const storage = createInMemoryStorage();
  const stack = signal<StackEntry[]>([]);
  const session = { ownsPlayback: signal(false) };
  /** The session's Your Stack (`SessionState.stack`), used while it owns playback. */
  const sessionStack = signal<StackEntry[]>([]);
  // Mirrors PlayerStore: while a session owns playback, the stack is the session's.
  const effective = () => (session.ownsPlayback() ? sessionStack : stack);
  /** False while the session's stack state is not loaded (PlayerStore.stackKnown). */
  const sessionKnown = signal(true);
  const player = {
    stackEntries: computed(() => effective()()),
    stackKnown: computed(() => !session.ownsPlayback() || sessionKnown()),
    deviceStackEntries: computed(() => stack()),
    discardStackOnSignOut: vi.fn(() => {
      sessionStack.set([]);
      stack.set([]);
    }),
    setStackFromRemote: vi.fn(async (entries: readonly StackEntry[]) =>
      effective().set([...entries]),
    ),
    discardStack: vi.fn(() => stack.set([])),
    removeStackEntry: vi.fn(async (entryId: string) => {
      effective().update((s) => s.filter((e) => e.entryId !== entryId));
      return true;
    }),
  };
  const user = opts.user;
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      { provide: StoragePort, useValue: storage },
      { provide: PlayerStore, useValue: player },
      { provide: AuthPort, useValue: fakeAuth(opts.signedIn) },
      { provide: StackSyncPort, useValue: opts.port },
      ...(user
        ? [
            {
              provide: AuthStore,
              useValue: { user, signedIn: computed(() => !!user()) },
            },
          ]
        : []),
    ],
  });
  const auth = TestBed.inject(AuthStore);
  const store = TestBed.inject(StackSyncStore);
  return {
    player,
    session,
    sessionKnown,
    stack,
    sessionStack,
    store,
    storage,
    ready: user ? Promise.resolve() : auth.start(),
  };
}

/** Let effects run, then timers and their microtasks. */
async function settle(ms = 0): Promise<void> {
  TestBed.flushEffects();
  await vi.advanceTimersByTimeAsync(ms);
  TestBed.flushEffects();
}

describe('StackSyncStore', () => {
  beforeEach(() =>
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }),
  );
  afterEach(() => vi.useRealTimers());

  it('debounces local changes into one push', async () => {
    const { port, pushes } = fakePort();
    const { player, stack, store, ready } = boot({ signedIn: true, port });
    await ready;
    store.start();
    await settle();

    stack.set([entry('e1', a)]);
    await settle(1_000);
    stack.set([entry('e1', a), entry('e2', b)]);
    await settle(1_999);
    expect(pushes).toHaveLength(0);

    await settle(1);
    expect(pushes).toHaveLength(1);
    expect(pushes[0].remove).toEqual([]);
    // Spaced positions: the order is what matters, not the exact values.
    const [first, second] = pushes[0].upsert;
    expect([first.entryId, second.entryId]).toEqual(['e1', 'e2']);
    expect(first.position).toBeLessThan(second.position);
    expect(player.setStackFromRemote).not.toHaveBeenCalled();
  });

  it('pushes the session stack while a session owns playback', async () => {
    const { port, pushes } = fakePort();
    const { session, sessionStack, store, ready } = boot({ signedIn: true, port });
    await ready;
    store.start();
    await settle();

    session.ownsPlayback.set(true);
    sessionStack.set([entry('e1', a)]);
    await settle(2_000);
    expect(pushes).toHaveLength(1);
    expect(pushes[0].upsert.map((r) => r.entryId)).toEqual(['e1']);
  });

  it('keeps a cloud entry the session stack still holds when a session takes playback', async () => {
    const { port } = fakePort();
    const { storage, session, sessionStack, store, ready } = boot({
      signedIn: true,
      port,
    });
    // The cloud and this device's sync state both hold e0.
    await storage.settings.set(
      SETTINGS_KEYS.stackSync,
      { userId: 'u1', entries: { e0: 0 } } as unknown as JsonValue,
    );
    await ready;
    session.ownsPlayback.set(true);
    sessionStack.set([entry('e0', a)]);
    store.start();
    await settle(10_000);
    // The session's stack equals the known state: nothing to write, nothing deleted.
    expect(port.push).not.toHaveBeenCalled();
  });

  it('applies a pull during a session through setStack and does not push it back', async () => {
    const remote = [
      { entryId: 'r1', position: 0, track: { id: 'remote:a', providerId: 'remote', title: 'A', artist: 'X' } },
    ];
    const { port } = fakePort(remote);
    const { player, session, sessionStack, store, ready } = boot({
      signedIn: true,
      port,
    });
    await ready;
    session.ownsPlayback.set(true);
    store.start();
    await settle(10_000);

    expect(player.setStackFromRemote).toHaveBeenCalledTimes(1);
    expect(sessionStack().map((e) => e.entryId)).toEqual(['r1']);
    expect(port.push).not.toHaveBeenCalled();
    // Sync keeps running and no push/pull loop forms.
    await settle(60_000);
    expect(player.setStackFromRemote).toHaveBeenCalledTimes(1);
    expect(port.push).not.toHaveBeenCalled();
  });

  it('does not push back what a pull just applied', async () => {
    const { port, pushes } = fakePort([
      {
        entryId: 'r1',
        position: 0,
        track: {
          id: 'remote:a',
          providerId: 'remote',
          title: 'A',
          artist: 'X',
        },
      },
      {
        entryId: 'r2',
        position: 1,
        track: {
          id: 'remote:b',
          providerId: 'remote',
          title: 'B',
          artist: 'Y',
        },
      },
    ]);
    const { player, stack, store, ready } = boot({ signedIn: true, port });
    await ready;
    store.start();
    await settle(10_000);

    expect(player.setStackFromRemote).toHaveBeenCalledTimes(1);
    expect(stack().map((e) => e.entryId)).toEqual(['r1', 'r2']);
    // The apply fired the change effect; the diff is empty, so nothing is written.
    await settle(10_000);
    expect(pushes).toHaveLength(0);
    expect(port.push).not.toHaveBeenCalled();
  });

  it('an unloaded session stack neither pushes, pulls nor deletes', async () => {
    const remote = [
      {
        entryId: 'e0',
        position: 0,
        track: { id: 'remote:a', providerId: 'remote', title: 'A', artist: 'X' },
      },
    ];
    const { port } = fakePort(remote);
    const { storage, player, session, sessionKnown, sessionStack, store, ready } = boot({
      signedIn: true,
      port,
    });
    // This device knows e0 from the account; the session state has not loaded.
    await storage.settings.set(
      SETTINGS_KEYS.stackSync,
      { userId: 'u1', entries: { e0: 0 } } as unknown as JsonValue,
    );
    await ready;
    session.ownsPlayback.set(true);
    sessionKnown.set(false);
    store.start();
    await settle(40_000);

    expect(port.push).not.toHaveBeenCalled();
    expect(port.pull).not.toHaveBeenCalled();
    expect(player.setStackFromRemote).not.toHaveBeenCalled();

    // The state loads with e0 still in it: nothing is written, nothing deleted.
    sessionStack.set([entry('e0', a)]);
    sessionKnown.set(true);
    await settle(40_000);
    expect(port.push).not.toHaveBeenCalled();
    expect(player.setStackFromRemote).not.toHaveBeenCalled();
  });

  it('a loaded empty session stack syncs as empty', async () => {
    const { port, pushes } = fakePort([]);
    const { storage, session, store, ready } = boot({ signedIn: true, port });
    await storage.settings.set(
      SETTINGS_KEYS.stackSync,
      { userId: 'u1', entries: { e0: 0 } } as unknown as JsonValue,
    );
    await ready;
    session.ownsPlayback.set(true);
    store.start();
    await settle(10_000);

    // Known loaded and empty: the cloud's e0 is removed, as a local clear would do.
    expect(pushes).toHaveLength(1);
    expect(pushes[0].remove).toEqual(['e0']);
  });

  it('a song a controller adds to the session is pushed exactly once, and the pull does not push it again', async () => {
    const { port, pushes } = fakePort([]);
    const { player, session, sessionStack, store, ready } = boot({
      signedIn: true,
      port,
    });
    await ready;
    session.ownsPlayback.set(true);
    store.start();
    await settle();

    // Another controller adds a song: the server's state now names it.
    sessionStack.set([entry('s1', a)]);
    await settle(2_000);
    expect(pushes).toHaveLength(1);
    expect(pushes[0].upsert.map((r) => r.entryId)).toEqual(['s1']);

    // The account now holds s1 (the pull reflects the push).
    const pushed = pushes[0].upsert[0];
    port.pull.mockResolvedValueOnce([
      { entryId: 's1', position: pushed.position, track: pushed.track },
    ]);
    await store.pull();
    await settle(10_000);

    expect(pushes).toHaveLength(1);
    expect(port.push).toHaveBeenCalledTimes(1);
    expect(player.setStackFromRemote).not.toHaveBeenCalled();
  });

  it('sign-out asks the player to clear the stack, session included', async () => {
    const user = signal<{ id: string } | null>({ id: 'u1' });
    const { port } = fakePort();
    const { player, stack, store, ready } = boot({ signedIn: true, port, user });
    await ready;
    store.start();
    await settle();
    stack.set([entry('e1', a)]);

    user.set(null);
    await settle();

    expect(player.discardStackOnSignOut).toHaveBeenCalledTimes(1);
  });

  it('is a no-op while signed out', async () => {
    const { port } = fakePort([
      {
        entryId: 'r1',
        position: 0,
        track: {
          id: 'remote:a',
          providerId: 'remote',
          title: 'A',
          artist: 'X',
        },
      },
    ]);
    const { player, stack, store, ready } = boot({ signedIn: false, port });
    await ready;
    store.start();
    stack.set([entry('e1', a)]);
    await settle(10_000);

    expect(port.pull).not.toHaveBeenCalled();
    expect(port.push).not.toHaveBeenCalled();
    expect(player.setStackFromRemote).not.toHaveBeenCalled();
    expect(stack().map((e) => e.entryId)).toEqual(['e1']);
  });

  it('keeps unpushed local entries after the remote rows when a push fails', async () => {
    const { port } = fakePort([
      {
        entryId: 'r1',
        position: 0,
        track: { id: 'remote:a', providerId: 'remote', title: 'A', artist: 'X' },
      },
    ]);
    port.push.mockRejectedValueOnce(new Error('offline'));
    const { stack, store, ready } = boot({ signedIn: true, port });
    await ready;
    stack.set([entry('e1', b)]);

    await expect(store.pull()).rejects.toThrow('offline');
    expect(port.pull).toHaveBeenCalled();
    expect(stack().map((e) => e.entryId)).toEqual(['r1', 'e1']);
  });

  it('never pushes another account’s stack into this one', async () => {
    const { port } = fakePort([]);
    const { storage, stack, store, ready } = boot({ signedIn: true, port });
    // The device last synced a different account (before this sign-in).
    await storage.settings.set(
      SETTINGS_KEYS.stackSync,
      {
        userId: 'someone-else',
        entries: { old: 0 },
      } as unknown as JsonValue,
    );
    stack.set([entry('e1', a)]);
    await ready;
    store.start();
    await settle(10_000);

    expect(port.push).not.toHaveBeenCalled();
    expect(port.pull).toHaveBeenCalled();
    // The account's (empty) stack replaces the local one.
    expect(stack()).toEqual([]);
  });

  it('does not record the account when it signs out during a push', async () => {
    const user = signal<{ id: string } | null>({ id: 'u1' });
    const { port } = fakePort();
    let finish!: () => void;
    port.push.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = () => resolve({ rejected: [] });
        }),
    );
    const { storage, stack, store, ready } = boot({ signedIn: true, port, user });
    await ready;
    store.start();
    await settle();
    stack.set([entry('e1', a)]);
    await settle(2_000);
    expect(port.push).toHaveBeenCalledTimes(1);

    // Sign out while the write is in flight, then let it finish.
    user.set(null);
    await settle();
    finish();
    await settle();

    const saved = (await storage.settings.get(SETTINGS_KEYS.stackSync)) as {
      userId: string;
    };
    expect(saved.userId).toBe('');
    expect(stack()).toEqual([]);
  });

  it('keeps an oversized or rejected entry local and pushes the rest', async () => {
    const { port } = fakePort();
    // The cloud refuses e2 (a bad row, not the cap) on the first write.
    port.push.mockResolvedValueOnce({ rejected: ['e2'] });
    const { stack, store, ready } = boot({ signedIn: true, port });
    await ready;
    store.start();
    await settle();
    const huge: Track = { ...b, title: 'x'.repeat(9_000) };
    stack.set([entry('e1', a), entry('e2', b), entry('e3', huge)]);
    await settle(2_000);

    // e3 is too large for a row and never sent; e2 is retried once without e2.
    const sent = port.push.mock.calls.map(([c]) =>
      c.upsert.map((u: SyncStackEntry) => u.entryId),
    );
    expect(sent).toEqual([['e1', 'e2'], ['e1']]);
    // Both stay on this device, and nothing is retried after that.
    expect(stack().map((e) => e.entryId)).toEqual(['e1', 'e2', 'e3']);
    await settle(120_000);
    expect(port.push).toHaveBeenCalledTimes(2);
  });
});

describe('planPositions', () => {
  it('takes midpoints, returns null when a gap is full, and ignores out-of-order stored positions', () => {
    // A new entry between two stored neighbours takes their midpoint.
    expect(
      planPositions(['a', 'x', 'c'], new Map([['a', 1024], ['c', 3072]])),
    ).toEqual([1024, 2048, 3072]);
    // No integer left between the neighbours: null, so the caller renumbers.
    expect(planPositions(['a', 'x', 'c'], new Map([['a', 10], ['c', 11]]))).toBeNull();
    // Past the 32-bit cap: null too.
    expect(planPositions(['a', 'x'], new Map([['a', 2_000_000_000 - 10]]))).toBeNull();
    // 'b' is stored before 'a' (not monotonic): it is not an anchor, so it is
    // re-placed between its real neighbours.
    expect(
      planPositions(['a', 'b', 'c'], new Map([['a', 2000], ['b', 1000], ['c', 3000]])),
    ).toEqual([2000, 2500, 3000]);
  });
});
