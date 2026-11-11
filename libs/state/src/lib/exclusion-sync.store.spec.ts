import { computed, signal, type WritableSignal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  SETTINGS_KEYS,
  StoragePort,
  createInMemoryStorage,
} from '@open-record/storage';
import { AuthStore } from './auth.store';
import { ExclusionSyncStore } from './exclusion-sync.store';
import { PlayerStore } from './player.store';
import { SessionStore } from './session.store';
import { AuthPort, ExclusionSyncPort } from './ports';

const HOUR = 60 * 60 * 1000;

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
function fakePort(remote: Record<string, number> = {}) {
  return {
    pull: vi.fn(async () => ({ ...remote })),
    push: vi.fn(async () => undefined),
  };
}

/**
 * Boots the store over a stand-in for PlayerStore's exclusion contract:
 * `stamp` records a local exclusion (and bumps the version, as the player does),
 * a remote merge is newest-wins and does not bump it.
 */
function boot(opts: {
  signedIn: boolean;
  port: ExclusionSyncPort;
  /** When given, the account is driven by this signal instead of AuthStore. */
  user?: WritableSignal<{ id: string } | null>;
}) {
  const storage = createInMemoryStorage();
  const exclusions = signal<Record<string, number>>({});
  const exclusionVersion = signal(0);
  const session = { ownsPlayback: signal(false) };
  const player = {
    exclusionVersion,
    recentExclusions: () => exclusions(),
    clearRecentExclusions: vi.fn(() => exclusions.set({})),
    mergeRemoteExclusions: vi.fn((remote: Record<string, number>) => {
      exclusions.update((cur) => {
        const next = { ...cur };
        for (const [id, at] of Object.entries(remote)) {
          if ((next[id] ?? 0) < at) next[id] = at;
        }
        return next;
      });
    }),
  };
  const stamp = (trackId: string, at = Date.now()) => {
    exclusions.update((cur) => ({ ...cur, [trackId]: at }));
    exclusionVersion.update((v) => v + 1);
  };
  const user = opts.user;
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      { provide: StoragePort, useValue: storage },
      { provide: PlayerStore, useValue: player },
      { provide: SessionStore, useValue: session },
      { provide: AuthPort, useValue: fakeAuth(opts.signedIn) },
      { provide: ExclusionSyncPort, useValue: opts.port },
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
  const store = TestBed.inject(ExclusionSyncStore);
  return {
    player,
    session,
    stamp,
    storage,
    store,
    ready: user ? Promise.resolve() : TestBed.inject(AuthStore).start(),
  };
}

/** Let effects run, then timers and their microtasks. */
async function settle(ms = 0): Promise<void> {
  TestBed.flushEffects();
  await vi.advanceTimersByTimeAsync(ms);
  TestBed.flushEffects();
}

describe('ExclusionSyncStore', () => {
  beforeEach(() =>
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }),
  );
  afterEach(() => vi.useRealTimers());

  it('pushes a local exclusion after a debounce', async () => {
    const port = fakePort();
    const { stamp, store, ready } = boot({ signedIn: true, port });
    await ready;
    store.start();
    await settle();
    expect(port.push).not.toHaveBeenCalled();

    const at = Date.now();
    stamp('remote:a', at);
    await settle(1_999);
    expect(port.push).not.toHaveBeenCalled();

    await settle(1);
    expect(port.push).toHaveBeenCalledTimes(1);
    expect(port.push).toHaveBeenCalledWith([{ trackId: 'remote:a', at }]);
  });

  it('never pushes local-only tracks', async () => {
    const port = fakePort();
    const { stamp, store, ready } = boot({ signedIn: true, port });
    await ready;
    store.start();
    await settle();

    stamp('local:file-1');
    await settle(10_000);
    expect(port.push).not.toHaveBeenCalled();
  });

  it('merges the account’s exclusions and ignores rows outside the window', async () => {
    const fresh = Date.now() - HOUR;
    const port = fakePort({
      'remote:a': fresh,
      'remote:old': Date.now() - 13 * HOUR,
    });
    const { player, store, ready } = boot({ signedIn: true, port });
    await ready;
    store.start();
    await settle(1_000);

    expect(port.pull).toHaveBeenCalled();
    expect(player.mergeRemoteExclusions).toHaveBeenCalledWith({
      'remote:a': fresh,
    });
    // A merge applied locally is not pushed back.
    await settle(10_000);
    expect(port.push).not.toHaveBeenCalled();
  });

  it('is a no-op while signed out', async () => {
    const port = fakePort({ 'remote:a': Date.now() });
    const { player, stamp, store, ready } = boot({ signedIn: false, port });
    await ready;
    store.start();
    stamp('remote:b');
    await settle(10_000);

    expect(port.pull).not.toHaveBeenCalled();
    expect(port.push).not.toHaveBeenCalled();
    expect(player.mergeRemoteExclusions).not.toHaveBeenCalled();
  });

  it('retries a failed push after 30 seconds', async () => {
    const port = fakePort();
    port.push.mockRejectedValueOnce(new Error('offline'));
    const { stamp, storage, store, ready } = boot({ signedIn: true, port });
    await ready;
    store.start();
    await settle();

    const at = Date.now();
    stamp('remote:a', at);
    await settle(2_000);
    expect(port.push).toHaveBeenCalledTimes(1);

    await settle(29_999);
    expect(port.push).toHaveBeenCalledTimes(1);

    await settle(1);
    expect(port.push).toHaveBeenCalledTimes(2);
    expect(port.push).toHaveBeenLastCalledWith([{ trackId: 'remote:a', at }]);
    // Recorded only after the write that succeeded.
    const saved = (await storage.settings.get(SETTINGS_KEYS.exclusionSync)) as {
      userId: string;
      times: Record<string, number>;
    };
    expect(saved.userId).toBe('u1');
    expect(saved.times['remote:a']).toBe(at);
  });

  it('a smaller remote time does not lower what was pushed, so no repeat push', async () => {
    const port = fakePort();
    const { stamp, store, ready } = boot({ signedIn: true, port });
    await ready;
    store.start();
    await settle();

    const at = Date.now();
    stamp('remote:a', at);
    await settle(2_000);
    expect(port.push).toHaveBeenCalledTimes(1);

    // The account now reports an older time for the same song.
    port.pull.mockResolvedValue({ 'remote:a': at - HOUR });
    await store.pull();
    await settle(10_000);
    expect(port.push).toHaveBeenCalledTimes(1);
  });

  it('first sign-in clears stored state of another account before pushing', async () => {
    const user = signal<{ id: string } | null>(null);
    const port = fakePort();
    const { player, stamp, storage, store, ready } = boot({
      signedIn: false,
      port,
      user,
    });
    await ready;
    store.start();
    // A's state is still on the device (its session expired while the app was closed).
    await storage.settings.set(SETTINGS_KEYS.exclusionSync, {
      userId: 'u1',
      times: { 'remote:a': Date.now() },
    });
    stamp('remote:a');
    await settle();

    user.set({ id: 'u2' });
    await settle(10_000);

    expect(player.clearRecentExclusions).toHaveBeenCalledTimes(1);
    expect(port.push).not.toHaveBeenCalled();
    expect(player.recentExclusions()).toEqual({});
    const saved = (await storage.settings.get(SETTINGS_KEYS.exclusionSync)) as {
      userId: string;
    };
    expect(saved.userId).toBe('u2');
  });

  it('first sign-in keeps stored state of the same account', async () => {
    const user = signal<{ id: string } | null>(null);
    const port = fakePort();
    const { player, storage, store, ready } = boot({
      signedIn: false,
      port,
      user,
    });
    await ready;
    store.start();
    await storage.settings.set(SETTINGS_KEYS.exclusionSync, {
      userId: 'u2',
      times: {},
    });
    await settle();

    user.set({ id: 'u2' });
    await settle(10_000);

    expect(player.clearRecentExclusions).not.toHaveBeenCalled();
  });

  it('a switch from account A to B forgets A’s songs and pulls B’s', async () => {
    const user = signal<{ id: string } | null>({ id: 'u1' });
    const port = fakePort();
    const { player, stamp, storage, store, ready } = boot({
      signedIn: true,
      port,
      user,
    });
    await ready;
    store.start();
    await settle();

    const aAt = Date.now();
    stamp('remote:a', aAt);
    await settle(2_000);
    expect(port.push).toHaveBeenCalledTimes(1);

    // B's account holds a different song; A's must not carry over.
    const bAt = Date.now() - HOUR;
    port.pull.mockResolvedValue({ 'remote:b': bAt });
    user.set({ id: 'u2' });
    await settle(10_000);

    expect(player.clearRecentExclusions).toHaveBeenCalledTimes(1);
    expect(player.recentExclusions()).toEqual({ 'remote:b': bAt });
    // A's song was not pushed to B's account.
    expect(port.push).toHaveBeenCalledTimes(1);
    const saved = (await storage.settings.get(SETTINGS_KEYS.exclusionSync)) as {
      userId: string;
      times: Record<string, number>;
    };
    expect(saved.userId).toBe('u2');
    expect(saved.times).toEqual({ 'remote:b': bAt });
  });
});
