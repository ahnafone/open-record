// @vitest-environment-options { "url": "https://server.test/" }
import { computed, signal } from '@angular/core';
import type { Provider } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type {
  CommandResult,
  SessionClientMessage,
  SessionCommand,
  SessionDevice,
  SessionReportMessage,
  SessionServerMessage,
  SessionState,
  SessionTarget,
  SessionTrack,
  Track,
} from '@open-record/models';
import { PlayerService } from '@open-record/player';
import type { PlayerStatus } from '@open-record/player';
import { StoragePort, createInMemoryStorage } from '@open-record/storage';
import { AuthStore } from './auth.store';
import type { AuthStatus } from './auth.store';
import { LibraryStore } from './library.store';
import { PlayCountsStore } from './play-counts.store';
import { PlayerStore } from './player.store';
import { PlaylistsStore } from './playlists.store';
import {
  CastFilePort,
  CastUploadPort,
  SessionPort,
} from './ports';
import type { SessionConnectionState } from './ports';
import { SessionStore } from './session.store';
import { SettingsStore } from './settings.store';

type ApplyOptions = {
  autoplay?: boolean;
  positionSec?: number;
  sessionMode?: boolean;
};

function fakeEngine(options: { blocked?: boolean } = {}) {
  const queue = signal<readonly Track[]>([]);
  const currentIndex = signal(-1);
  const status = signal<PlayerStatus>('idle');
  const position = signal(0);
  const duration = signal(0);
  const current = computed(() => queue()[currentIndex()] ?? null);
  const isPlaying = computed(() => status() === 'playing');
  /** Play order as queue indices; null means queue order (no shuffle). */
  const playOrder = signal<readonly number[] | null>(null);
  /** Whether the current track's media is in the engine (PlayerEngine.mediaLoaded). */
  const loaded = signal(true);
  const upcomingEntries = computed(() => {
    const indexes = playOrder() ?? queue().map((_, i) => i);
    const position = indexes.indexOf(currentIndex());
    return indexes.slice(position + 1).map((queueIndex) => ({
      track: queue()[queueIndex] as Track,
      queueIndex,
      playNext: false,
    }));
  });

  const applyOrder = vi.fn(
    async (
      order: readonly Track[],
      cursor: number,
      opts: ApplyOptions = {},
    ) => {
      // The same song already loaded keeps its position (no reload).
      const sameTrack =
        cursor >= 0 && current()?.id === order[cursor]?.id;
      queue.set([...order]);
      currentIndex.set(cursor);
      position.set(
        opts.positionSec ?? (sameTrack ? position() : 0),
      );
      duration.set(order[cursor]?.durationSec ?? 0);
      status.set(
        opts.autoplay && !options.blocked
          ? 'playing'
          : cursor >= 0
            ? 'paused'
            : 'idle',
      );
      return { reloaded: true, moved: true };
    },
  );
  const play = vi.fn(async () => {
    if (options.blocked) throw new Error('blocked');
    if (currentIndex() >= 0) status.set('playing');
  });
  const pause = vi.fn(async () => {
    if (status() === 'playing') status.set('paused');
  });
  const seekIfDrifted = vi.fn(async (target: number, tolerance = 2) => {
    if (Math.abs(position() - target) > tolerance) position.set(target);
  });
  const playAt = vi.fn(async (index: number) => {
    currentIndex.set(index);
    status.set('playing');
  });
  const next = vi.fn(async () => {
    if (currentIndex() + 1 >= queue().length) return false;
    currentIndex.set(currentIndex() + 1);
    return true;
  });

  return {
    playAt,
    next,
    queue,
    currentIndex,
    current,
    status,
    position,
    duration,
    isPlaying,
    intendsToPlay: false,
    applyOrder,
    /** PlayerStore wires the Keep Spinning dedupe into the engine; no events here. */
    setExclusionListener: vi.fn(),
    play,
    pause,
    seekIfDrifted,
    upcoming: computed(() => upcomingEntries().map((entry) => entry.track)),
    upcomingEntries,
    playOrder,
    playNextIndices: signal<readonly number[]>([]),
    shuffle: signal(false),
    repeat: signal('off'),
    hasNext: computed(() => false),
    hasPrevious: computed(() => false),
    lastPlay: signal(null),
    loadSeq: signal(0),
    error: signal(null),
    volume: signal(1),
    muted: signal(false),
    loaded,
    /** Mirrors PlayerEngine.mediaLoaded; tests flip `loaded` to model a load. */
    get mediaLoaded() {
      return loaded() && current() !== null;
    },
    canSetVolume: false,
  };
}

class FakePort implements SessionPort {
  connectionState: SessionConnectionState = 'off';
  connectedProfile?: SessionDevice;
  connectCalls = 0;
  disconnectCalls = 0;
  commands: { id: string; command: SessionCommand }[] = [];
  sent: SessionClientMessage[] = [];
  result: (command: SessionCommand) => CommandResult = () => ({ ok: true });

  private readonly changeListeners = new Set<
    (state: SessionConnectionState) => void
  >();
  private readonly messageListeners = new Set<
    (message: SessionServerMessage) => void
  >();

  available(): boolean {
    return true;
  }

  connection(): SessionConnectionState {
    return this.connectionState;
  }

  onChange(listener: (state: SessionConnectionState) => void): () => void {
    this.changeListeners.add(listener);
    return () => {
      this.changeListeners.delete(listener);
    };
  }

  onMessage(listener: (message: SessionServerMessage) => void): () => void {
    this.messageListeners.add(listener);
    return () => {
      this.messageListeners.delete(listener);
    };
  }

  connect(profile: SessionDevice): () => void {
    this.connectCalls++;
    this.connectedProfile = profile;
    this.connectionState = 'open';
    this.emitConnection();
    return () => {
      this.disconnectCalls++;
      this.connectionState = 'off';
      this.emitConnection();
    };
  }

  send(message: SessionClientMessage): void {
    this.sent.push(message);
  }

  async command(id: string, command: SessionCommand): Promise<CommandResult> {
    this.commands.push({ id, command });
    return this.result(command);
  }

  push(message: SessionServerMessage): void {
    for (const listener of [...this.messageListeners]) listener(message);
  }

  emitConnection(state?: SessionConnectionState): void {
    if (state) this.connectionState = state;
    for (const listener of [...this.changeListeners]) {
      listener(this.connectionState);
    }
  }

  reports(): SessionReportMessage[] {
    return this.sent.filter(
      (message): message is SessionReportMessage => message.type === 'report',
    );
  }
}

function catalogTrack(id: string): Track {
  return { id, providerId: 'catalog', title: `Song ${id}`, artist: 'Artist' };
}

function wire(
  entryId: string,
  id: string,
  extra: Partial<SessionTrack> = {},
): SessionTrack {
  return {
    entryId,
    id,
    providerId: 'catalog',
    title: `Song ${id}`,
    artist: 'Artist',
    durationSec: 180,
    ...extra,
  };
}

function session(overrides: Partial<SessionState> = {}): SessionState {
  return {
    revision: 1,
    target: null,
    order: [],
    cursor: -1,
    positionSec: 0,
    playing: false,
    shuffle: false,
    repeat: 'off',
    updatedAt: Date.now(),
    updatedBy: null,
    ...overrides,
  };
}

function device(store: SessionStore, overrides: Partial<SessionState> = {}) {
  const target: SessionTarget = {
    kind: 'device',
    clientId: store.clientId(),
    deviceId: 'device-1',
  };
  return session({ ...overrides, target });
}

function remoteTarget(): SessionTarget {
  return { kind: 'device', clientId: 'other-client', deviceId: 'device-2' };
}

function welcome(
  store: SessionStore,
  state: SessionState | null,
  devices: SessionDevice[] = [],
  serverTime = Date.now(),
): SessionServerMessage {
  return {
    type: 'welcome',
    serverTime,
    clientId: store.clientId(),
    deviceId: 'device-1',
    devicesRevision: 1,
    session: state,
    devices,
  };
}

async function settle(rounds = 8): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await Promise.resolve();
    TestBed.tick();
  }
}

interface SetupOptions {
  blocked?: boolean;
  port?: FakePort | null;
  uploads?: CastUploadPort;
  files?: CastFilePort;
  serverUrl?: string;
}

async function setup(options: SetupOptions = {}) {
  const engine = fakeEngine({ blocked: options.blocked });
  const port = options.port === undefined ? new FakePort() : options.port;
  const tracks = signal<ReadonlyMap<string, Track>>(new Map());
  const status = signal<AuthStatus>('signedIn');
  const deviceName = signal('Pixel 8');
  const serverUrl = signal(options.serverUrl ?? 'https://server.test');
  const sessionEnabled = signal(true);
  const settings = {
    ready: vi.fn(async () => undefined),
    deviceId: signal('device-1'),
    deviceName,
    sessionEnabled,
    castEnabled: signal(true),
    downloadServerUrl: serverUrl,
  };
  const auth = {
    status,
    signedIn: computed(() => status() === 'signedIn'),
    accessToken: vi.fn(async () => 'token'),
  };
  const library = {
    trackMap: computed(() => tracks()),
    track: (id: string) => tracks().get(id),
  };

  const providers: Provider[] = [
    { provide: PlayerService, useValue: { engine } },
    { provide: AuthStore, useValue: auth },
    { provide: SettingsStore, useValue: settings },
    { provide: LibraryStore, useValue: library },
    { provide: StoragePort, useValue: createInMemoryStorage() },
    { provide: PlaylistsStore, useValue: {} },
    {
      provide: PlayCountsStore,
      useValue: { recordPlay: vi.fn(async () => undefined) },
    },
  ];
  if (port) providers.push({ provide: SessionPort, useValue: port });
  if (options.uploads) {
    providers.push({ provide: CastUploadPort, useValue: options.uploads });
  }
  if (options.files) {
    providers.push({ provide: CastFilePort, useValue: options.files });
  }

  TestBed.configureTestingModule({ providers });
  const store = TestBed.inject(SessionStore);
  store.start();
  await settle();

  return {
    store,
    engine,
    // Tests that pass `port: null` never use this field.
    port: port as FakePort,
    settings,
    auth,
    deviceName,
    serverUrl,
    tracks,
  };
}

describe('SessionStore', () => {
  beforeEach(() => TestBed.resetTestingModule());
  afterEach(() => vi.useRealTimers());

  it('connects once with the seeded device profile and applies welcome', async () => {
    const { store, port } = await setup();

    expect(store.clientId()).not.toBe('');
    expect(store.deviceId()).toBe('device-1');
    expect(store.connection()).toBe('open');
    expect(port.connectCalls).toBe(1);
    expect(port.connectedProfile).toMatchObject({
      id: store.clientId(),
      deviceId: 'device-1',
      name: 'Pixel 8',
      online: true,
      capabilities: { cast: true, localFiles: false },
    });
    expect(port.connectedProfile?.platform).toBe('web');

    const phone: SessionDevice = {
      id: store.clientId(),
      deviceId: 'device-1',
      name: 'Pixel 8',
      platform: 'web',
      online: true,
      lastSeenAt: 1,
      capabilities: { cast: true, localFiles: false },
    };
    port.push(
      welcome(
        store,
        session({ revision: 4, order: [wire('e1', 'catalog:a')] }),
        [phone],
      ),
    );
    await settle();

    expect(store.devices()).toEqual([phone]);
    expect(store.session()?.revision).toBe(4);
    expect(store.remoteTracks().map((track) => track.id)).toEqual([
      'catalog:a',
    ]);

    // start() is idempotent and does not open a second connection.
    store.start();
    expect(port.connectCalls).toBe(1);
  });

  it('applies the server order to the engine when this client is the target', async () => {
    const { store, port, engine } = await setup();
    port.push(
      welcome(
        store,
        device(store, {
          revision: 3,
          order: [wire('e1', 'catalog:a'), wire('e2', 'catalog:b')],
          cursor: 1,
          positionSec: 42,
          playing: true,
          updatedAt: Date.now(),
        }),
      ),
    );
    await settle();

    expect(engine.applyOrder).toHaveBeenCalledTimes(1);
    const call = engine.applyOrder.mock.calls.at(0);
    if (!call) throw new Error('applyOrder was not called');
    const [tracks, cursor, opts] = call;
    expect(tracks.map((track) => track.id)).toEqual([
      'catalog:a',
      'catalog:b',
    ]);
    expect(cursor).toBe(1);
    expect(opts).toMatchObject({
      autoplay: true,
      positionSec: 42,
      sessionMode: true,
    });
    expect(engine.status()).toBe('playing');
    expect(store.needsGesture()).toBe(false);
    expect(store.isTarget()).toBe(true);
    expect(store.mirroring()).toBe(false);
  });

  it('applies the state order even when a newer session order has arrived', async () => {
    const { store, port, engine } = await setup();
    const base = engine.applyOrder.getMockImplementation();
    if (!base) throw new Error('fake engine has no applyOrder');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    // Hold the first apply in flight so a newer session state can land first.
    engine.applyOrder.mockImplementationOnce(async (order, cursor, opts) => {
      await gate;
      return base(order, cursor, opts);
    });

    port.push(
      welcome(
        store,
        device(store, {
          revision: 1,
          order: [wire('e0', 'catalog:a')],
          cursor: 0,
        }),
      ),
    );
    await settle();

    port.push({
      type: 'state',
      session: device(store, {
        revision: 2,
        order: [wire('e1', 'catalog:b'), wire('e2', 'catalog:c')],
        cursor: 1,
      }),
    });
    await settle();
    expect(store.remoteTracks().map((track) => track.id)).toEqual([
      'catalog:b',
      'catalog:c',
    ]);

    release();
    await settle();

    // The in-flight apply used its own state's order, not the newest session.
    const first = engine.applyOrder.mock.calls.at(0);
    if (!first) throw new Error('applyOrder was not called');
    expect(first[0].map((track) => track.id)).toEqual(['catalog:a']);
    expect(first[1]).toBe(0);
    // The queued newer state then applied its own order.
    const last = engine.applyOrder.mock.calls.at(-1);
    if (!last) throw new Error('applyOrder was not called twice');
    expect(last[0].map((track) => track.id)).toEqual([
      'catalog:b',
      'catalog:c',
    ]);
    expect(last[1]).toBe(1);
  });

  it('re-applies the server state once when the engine lands on a different entry', async () => {
    const { store, port, engine } = await setup();
    const base = engine.applyOrder.getMockImplementation();
    if (!base) throw new Error('fake engine has no applyOrder');
    // Simulate a stale load winning: the engine always ends up on another entry.
    engine.applyOrder.mockImplementation(async (order, cursor, opts) => {
      const result = await base(order, cursor, opts);
      engine.currentIndex.set(cursor === 0 ? 1 : 0);
      return result;
    });

    port.push(
      welcome(
        store,
        device(store, {
          revision: 3,
          order: [wire('e0', 'catalog:a'), wire('e1', 'catalog:b')],
          cursor: 0,
          playing: false,
        }),
      ),
    );
    await settle();

    // One server-authoritative retry, then the artifact is left alone.
    expect(engine.applyOrder).toHaveBeenCalledTimes(2);
    expect(
      port.reports().filter((report) => report.reason === 'native-skip'),
    ).toHaveLength(0);
  });

  it('reports an automatic advance as playing while the next media loads', async () => {
    const { store, port, engine } = await setup();
    port.push(
      welcome(
        store,
        device(store, {
          revision: 1,
          order: [wire('e0', 'catalog:a'), wire('e1', 'catalog:b')],
          cursor: 0,
          playing: true,
        }),
      ),
    );
    await settle();
    port.sent.length = 0;

    engine.intendsToPlay = true;
    engine.status.set('loading');
    engine.currentIndex.set(1);
    await settle();

    expect(port.reports().at(-1)).toMatchObject({
      reason: 'native-skip',
      entryId: 'e1',
      playing: true,
    });
  });

  it('reports paused when playback fails terminally, but not during retries', async () => {
    const { store, port, engine } = await setup();
    port.push(
      welcome(
        store,
        device(store, {
          order: [wire('e0', 'catalog:a')],
          cursor: 0,
          playing: false,
        }),
      ),
    );
    await settle();
    port.sent.length = 0;

    // A retry is `loading`, not a terminal failure: no report.
    engine.status.set('loading');
    await settle();
    expect(port.reports()).toHaveLength(0);

    engine.status.set('error');
    await settle();
    expect(port.reports().find((report) => report.reason === 'playing')).toMatchObject(
      { entryId: 'e0', playing: false },
    );
  });

  it('mirrors a remote target without touching the engine or reporting', async () => {
    const { store, port, engine } = await setup();
    port.push(
      welcome(
        store,
        session({
          target: remoteTarget(),
          order: [wire('e1', 'catalog:a'), wire('e2', 'catalog:b')],
          cursor: 0,
          playing: true,
        }),
      ),
    );
    await settle();

    expect(store.mirroring()).toBe(true);
    expect(store.ownsPlayback()).toBe(true);
    expect(store.remoteTracks()).toHaveLength(2);
    expect(engine.applyOrder).not.toHaveBeenCalled();
    expect(engine.play).not.toHaveBeenCalled();
    expect(engine.pause).not.toHaveBeenCalled();

    store.report('tick');
    store.report('native-skip');
    expect(port.reports()).toHaveLength(0);
  });

  it('ignores state revisions older than the applied one', async () => {
    const { store, port } = await setup();
    port.push(
      welcome(
        store,
        session({
          revision: 5,
          target: remoteTarget(),
          order: [wire('e1', 'catalog:a')],
          cursor: 0,
        }),
      ),
    );
    await settle();

    port.push({
      type: 'state',
      session: session({
        revision: 4,
        target: remoteTarget(),
        order: [wire('e2', 'catalog:b')],
        cursor: 0,
      }),
    });
    await settle();
    expect(store.session()?.revision).toBe(5);
    expect(store.remoteTracks().map((track) => track.id)).toEqual([
      'catalog:a',
    ]);

    port.push({
      type: 'state',
      session: session({
        revision: 6,
        target: remoteTarget(),
        order: [wire('e2', 'catalog:b')],
        cursor: 0,
      }),
    });
    await settle();
    expect(store.session()?.revision).toBe(6);
    expect(store.remoteTracks().map((track) => track.id)).toEqual([
      'catalog:b',
    ]);
  });

  it('extrapolates the remote position on the render clock and clamps it', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const { store, port } = await setup();
    port.push(
      welcome(
        store,
        session({
          target: remoteTarget(),
          order: [wire('e1', 'catalog:a', { durationSec: 200 })],
          cursor: 0,
          positionSec: 10,
          playing: true,
          updatedAt: 1_000_000,
        }),
        [],
        1_000_000,
      ),
    );
    await settle();
    expect(store.remotePosition()).toBe(10);

    vi.advanceTimersByTime(3000);
    expect(store.remotePosition()).toBe(13);

    port.push({
      type: 'state',
      session: session({
        revision: 2,
        target: remoteTarget(),
        order: [wire('e1', 'catalog:a', { durationSec: 12 })],
        cursor: 0,
        positionSec: 10,
        playing: true,
        updatedAt: 1_003_000,
      }),
    });
    await settle();
    vi.advanceTimersByTime(3000);
    expect(store.remotePosition()).toBe(12);
  });

  it('freezes a stale mirrored target: no extrapolation and not playing', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const { store, port } = await setup();
    port.push(
      welcome(
        store,
        session({
          target: remoteTarget(),
          targetStale: true,
          order: [wire('e1', 'catalog:a', { durationSec: 200 })],
          cursor: 0,
          positionSec: 10,
          playing: true,
          updatedAt: 1_000_000,
        }),
        [],
        1_000_000,
      ),
    );
    await settle();

    vi.advanceTimersByTime(3000);
    expect(store.mirroring()).toBe(true);
    expect(store.remotePosition()).toBe(10);
    expect(store.remotePlaying()).toBe(false);
    expect(store.remoteStatus()).toBe('paused');
  });

  it('rehydrates local entries from the library and exposes unavailable sets', async () => {
    const { store, port, tracks } = await setup();
    const full: Track = {
      id: 'local:a',
      providerId: 'local',
      title: 'Local A',
      artist: 'Artist',
      sourceFile: 'imported/a.mp3',
    };
    tracks.set(new Map([['local:a', full]]));
    port.push(
      welcome(
        store,
        session({
          target: remoteTarget(),
          order: [
            wire('e1', 'local:a', { providerId: 'local', local: true }),
            wire('e2', 'local:b', {
              providerId: 'local',
              local: true,
              title: 'Missing local',
            }),
          ],
          cursor: 0,
          unavailable: ['e2'],
        }),
      ),
    );
    await settle();

    expect(store.remoteTracks()[0]).toBe(full);
    expect(store.remoteTracks()[1]?.title).toBe('Missing local');
    expect(store.remoteTracks()[1]?.sourceFile).toBeUndefined();
    expect(store.localUnavailable()).toBeInstanceOf(Set);
    expect([...store.localUnavailable()]).toEqual(['local:b']);
    expect(store.remoteUnavailable()).toBeInstanceOf(Set);
    expect(store.remoteUnavailable().has('e2')).toBe(true);
    expect(store.remoteError()).toBe('Not available on the speaker');
  });

  it('keeps mapped Track objects stable across ticks and states', async () => {
    const { store, port } = await setup();
    port.push(
      welcome(
        store,
        session({
          target: remoteTarget(),
          order: [wire('e1', 'catalog:a')],
          cursor: 0,
          playing: true,
        }),
      ),
    );
    await settle();
    const first = store.remoteTracks()[0];
    expect(first).toBeDefined();

    port.push({
      type: 'tick',
      revision: 1,
      positionSec: 12,
      playing: true,
      updatedAt: Date.now(),
    });
    await settle();
    expect(store.remoteTracks()[0]).toBe(first);

    port.push({
      type: 'state',
      session: session({
        revision: 2,
        target: remoteTarget(),
        order: [wire('e1', 'catalog:a')],
        cursor: 0,
        playing: true,
      }),
    });
    await settle();
    expect(store.remoteTracks()[0]).toBe(first);
  });

  it('maps display indices to entry ids for removal and replacement', async () => {
    const { store, port } = await setup();
    port.push(
      welcome(
        store,
        session({
          target: remoteTarget(),
          order: [
            wire('e0', 'catalog:a'),
            wire('e1', 'catalog:b'),
            wire('e2', 'catalog:c'),
          ],
          cursor: 1,
        }),
      ),
    );
    await settle();

    expect(store.currentEntryId()).toBe('e1');
    expect(store.entryIdAt(1)).toBe('e1');
    expect(store.entryIdAt(9)).toBeUndefined();

    const removed = await store.removeAt(2);
    expect(removed.ok).toBe(true);
    expect(port.commands.at(-1)?.command).toEqual({
      type: 'remove',
      entryId: 'e2',
    });

    const next = catalogTrack('catalog:next');
    const replaced = await store.replaceAt(0, next);
    expect(replaced.ok).toBe(true);
    expect(port.commands.at(-1)?.command).toEqual({
      type: 'replace',
      entryId: 'e0',
      track: expect.objectContaining({
        entryId: 'e0',
        id: 'catalog:next',
        title: 'Song catalog:next',
      }),
    });

    port.result = () => ({ ok: false, error: 'entry-not-found' });
    const stale = await store.removeAt(0);
    expect(stale).toMatchObject({ ok: false, error: 'entry-not-found' });

    const before = port.commands.length;
    const missing = await store.removeAt(9);
    expect(missing).toMatchObject({ ok: false, error: 'entry-not-found' });
    expect(port.commands).toHaveLength(before);
  });

  it('starts a fresh track at 0 instead of seeking to its stale anchor', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(2_000_000);
    const { store, port, engine } = await setup();
    // Just started by a command: the anchor is at 0 and fresh at receipt.
    port.push(
      welcome(
        store,
        device(store, {
          order: [wire('e0', 'catalog:a')],
          cursor: 0,
          playing: true,
          positionSec: 0,
          updatedAt: Date.now(),
          revision: 1,
        }),
      ),
    );
    await settle();
    expect(engine.seekIfDrifted).not.toHaveBeenCalled();
    // The fresh start re-bases the server anchor with a forced tick.
    expect(port.reports()).toContainEqual(
      expect.objectContaining({ reason: 'tick' }),
    );
  });

  it('seeks to the live position when the anchor at 0 is stale', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(2_000_000);
    const { store, port, engine } = await setup();
    // Anchored at 0 but 30 s old: the song has been playing, so this is a join.
    port.push(
      welcome(
        store,
        device(store, {
          order: [wire('e0', 'catalog:a')],
          cursor: 0,
          playing: true,
          positionSec: 0,
          updatedAt: Date.now() - 30_000,
          revision: 1,
        }),
      ),
    );
    await settle();
    expect(engine.seekIfDrifted).toHaveBeenCalledWith(
      30,
      expect.anything(),
      expect.anything(),
    );
  });

  it('seeks a join whose anchor at 0 was already 8 s old on receipt, with no forced tick', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(2_000_000);
    const { store, port, engine } = await setup();
    port.push(
      welcome(
        store,
        device(store, {
          order: [wire('e0', 'catalog:a')],
          cursor: 0,
          playing: true,
          positionSec: 0,
          updatedAt: Date.now() - 8000,
          revision: 1,
        }),
      ),
    );
    await settle();
    expect(engine.seekIfDrifted).toHaveBeenCalledWith(
      8,
      expect.anything(),
      expect.anything(),
    );
    expect(port.reports().some((r) => r.reason === 'tick')).toBe(false);
  });

  it('keeps a fresh command start at 0 when the load takes 6 s after receipt', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(2_000_000);
    const { store, port, engine } = await setup();
    // Fresh at receipt; the slow load then ages the anchor past any bound.
    const base = engine.applyOrder.getMockImplementation();
    if (!base) throw new Error('fake engine has no applyOrder');
    engine.applyOrder.mockImplementationOnce(async (order, cursor, opts) => {
      vi.advanceTimersByTime(6000);
      return base(order, cursor, opts);
    });
    port.push(
      welcome(
        store,
        device(store, {
          order: [wire('e0', 'catalog:a')],
          cursor: 0,
          playing: true,
          positionSec: 0,
          updatedAt: Date.now(),
          revision: 1,
        }),
      ),
    );
    await settle();
    expect(engine.seekIfDrifted).not.toHaveBeenCalled();
    expect(port.reports()).toContainEqual(
      expect.objectContaining({ reason: 'tick' }),
    );
  });

  it('does not catch-up seek a fresh track on a later echo of its start', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(2_000_000);
    const { store, port, engine } = await setup();
    const start = device(store, {
      order: [wire('e0', 'catalog:a')],
      cursor: 0,
      playing: true,
      positionSec: 0,
      updatedAt: Date.now(),
      revision: 1,
    });
    port.push(welcome(store, start));
    await settle();
    engine.seekIfDrifted.mockClear();
    // Playback ran 5 s; a repeat of the start's state still anchors at 0.
    vi.advanceTimersByTime(5000);
    port.push({ type: 'state', session: { ...start, revision: 2 } });
    await settle();
    expect(engine.seekIfDrifted).not.toHaveBeenCalled();
  });

  it('does not report a refusal while the load it started is still in flight', async () => {
    const { store, port, engine } = await setup();
    // applyOrder returns while the load is still in flight: play() is a no-op.
    const base = engine.applyOrder.getMockImplementation();
    if (!base) throw new Error('fake engine has no applyOrder');
    engine.applyOrder.mockImplementationOnce(async (order, cursor, opts) => {
      const result = await base(order, cursor, opts);
      engine.status.set('loading');
      engine.intendsToPlay = true;
      return result;
    });
    engine.play.mockImplementationOnce(async () => undefined);
    port.push(
      welcome(
        store,
        device(store, {
          order: [wire('e0', 'catalog:a')],
          cursor: 0,
          playing: true,
          revision: 1,
        }),
      ),
    );
    await settle();
    expect(store.needsGesture()).toBe(false);
    expect(
      port.reports().some((r) => r.reason === 'playing' && r.playing === false),
    ).toBe(false);
  });

  it('sends the fresh-start re-base tick once, after a still-loading start plays', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(2_000_000);
    const { store, port, engine } = await setup();
    const forced = () =>
      emit.mock.calls.filter(([reason, , force]) => reason === 'tick' && force === true)
        .length;
    const emit = vi.spyOn(
      store as unknown as { emitReport: (...args: unknown[]) => void },
      'emitReport',
    );
    const base = engine.applyOrder.getMockImplementation();
    if (!base) throw new Error('fake engine has no applyOrder');
    // The start's audio is still loading when its state is applied.
    engine.applyOrder.mockImplementationOnce(async (order, cursor, opts) => {
      const result = await base(order, cursor, opts);
      engine.status.set('loading');
      engine.intendsToPlay = true;
      return result;
    });
    engine.play.mockImplementationOnce(async () => undefined);
    port.push(
      welcome(
        store,
        device(store, {
          order: [wire('e0', 'catalog:a')],
          cursor: 0,
          playing: true,
          positionSec: 0,
          updatedAt: Date.now(),
          revision: 1,
        }),
      ),
    );
    await settle();
    expect(forced()).toBe(0);

    engine.intendsToPlay = false;
    engine.status.set('playing');
    await settle();
    expect(forced()).toBe(1);

    // Pausing and resuming the same track does not send it again.
    engine.status.set('paused');
    await settle();
    engine.status.set('playing');
    await settle();
    expect(forced()).toBe(1);
  });

  it('a newer same-song state after a fresh start still seeks', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(2_000_000);
    const { store, port, engine } = await setup();
    const start = device(store, {
      order: [wire('e0', 'catalog:a')],
      cursor: 0,
      playing: true,
      positionSec: 0,
      updatedAt: Date.now(),
      revision: 1,
    });
    port.push(welcome(store, start));
    await settle();
    engine.seekIfDrifted.mockClear();
    // A remote seek to 30 s is newer than the start: it must correct the engine.
    vi.advanceTimersByTime(1000);
    port.push({
      type: 'state',
      session: { ...start, positionSec: 30, updatedAt: Date.now(), revision: 2 },
    });
    await settle();
    expect(engine.seekIfDrifted).toHaveBeenCalledWith(
      30,
      expect.anything(),
      expect.anything(),
    );
  });

  it('reports a local seek at once and ignores in-flight stale ticks', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(2_000_000);
    const { store, port, engine } = await setup();
    port.push(
      welcome(
        store,
        device(store, {
          order: [wire('e0', 'catalog:a')],
          cursor: 0,
          playing: true,
          revision: 1,
        }),
      ),
    );
    await settle();
    // The fresh start re-bases the anchor with a report: clear its throttle.
    vi.advanceTimersByTime(2001);
    port.sent.length = 0;

    engine.status.set('playing');
    engine.position.set(5);
    store.report('tick'); // opens the throttle window
    engine.position.set(81);
    store.reportSeek(); // inside the window: must still go out
    expect(port.reports()).toHaveLength(2);
    expect(port.reports()[1]).toMatchObject({ reason: 'tick', positionSec: 81 });

    engine.seekIfDrifted.mockClear();
    port.push({
      type: 'tick',
      revision: 1,
      positionSec: 242,
      playing: true,
      updatedAt: Date.now(),
    });
    await settle();
    expect(engine.seekIfDrifted).not.toHaveBeenCalled();
  });

  it('reports target observations immediately and throttles ticks', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(2_000_000);
    const { store, port, engine } = await setup();
    port.push(
      welcome(
        store,
        device(store, {
          order: [wire('e0', 'catalog:a'), wire('e1', 'catalog:b')],
          cursor: 0,
          playing: true,
        }),
      ),
    );
    await settle();
    // The fresh start re-bases the anchor with a report: clear its throttle.
    vi.advanceTimersByTime(2001);
    port.sent.length = 0;

    engine.status.set('playing');
    engine.position.set(5);
    store.report('tick');
    store.report('tick');
    expect(port.reports()).toHaveLength(1);
    expect(port.reports()[0]).toMatchObject({
      reason: 'tick',
      entryId: 'e0',
      playing: true,
      positionSec: 5,
    });

    vi.advanceTimersByTime(2001);
    store.report('tick');
    expect(port.reports()).toHaveLength(2);

    store.report('native-skip');
    expect(port.reports().at(-1)).toMatchObject({
      reason: 'native-skip',
      entryId: 'e0',
    });
    store.report('native-skip');
    expect(port.reports()).toHaveLength(3);

    store.report('ended');
    expect(port.reports().at(-1)).toMatchObject({ reason: 'ended' });
    store.report('playing');
    expect(port.reports().at(-1)).toMatchObject({ reason: 'playing' });
    expect(port.reports()).toHaveLength(5);
  });

  it('reports position 0 while the current media is not loaded yet', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(2_000_000);
    const { store, port, engine } = await setup();
    port.push(
      welcome(
        store,
        device(store, {
          order: [wire('e0', 'catalog:a')],
          cursor: 0,
          playing: true,
          revision: 1,
        }),
      ),
    );
    await settle();
    vi.advanceTimersByTime(2001);
    port.sent.length = 0;

    // The previous track's position is still in the engine while this one loads.
    engine.loaded.set(false);
    engine.position.set(42);
    store.reportSeek();

    expect(port.reports().at(-1)).toMatchObject({
      reason: 'tick',
      entryId: 'e0',
      positionSec: 0,
    });
  });

  it('stays paused and asks for a gesture when autoplay is refused', async () => {
    const { store, port, engine } = await setup({ blocked: true });
    port.push(
      welcome(
        store,
        device(store, {
          order: [wire('e0', 'catalog:a')],
          cursor: 0,
          playing: true,
        }),
      ),
    );
    await settle();

    expect(engine.status()).toBe('paused');
    expect(store.needsGesture()).toBe(true);
    const refused = port
      .reports()
      .find((report) => report.reason === 'playing');
    expect(refused).toMatchObject({ playing: false, entryId: 'e0' });
  });

  it('disconnects and clears on sign-out', async () => {
    const { store, port, auth, engine } = await setup();
    port.push(
      welcome(
        store,
        device(store, {
          order: [wire('e0', 'catalog:a')],
          cursor: 0,
          playing: true,
        }),
      ),
    );
    await settle();
    expect(store.session()).not.toBeNull();

    auth.status.set('signedOut');
    await settle();

    expect(store.available()).toBe(false);
    expect(store.connection()).toBe('off');
    expect(store.session()).toBeNull();
    expect(store.devices()).toEqual([]);
    expect(port.disconnectCalls).toBe(1);
    expect(engine.pause).toHaveBeenCalled();
  });

  it('reconnects with the same client id when the device name changes', async () => {
    const { store, port, deviceName } = await setup();
    const firstClientId = store.clientId();

    deviceName.set('Living room');
    await settle();

    expect(port.connectCalls).toBe(2);
    expect(port.connectedProfile?.name).toBe('Living room');
    expect(store.clientId()).toBe(firstClientId);
  });

  it('sends a natural setQueue and transfers to this client; entry ids survive a retry', async () => {
    const { store, port } = await setup();
    let setQueueCalls = 0;
    port.result = (command) => {
      if (command.type === 'setQueue') {
        setQueueCalls++;
        return setQueueCalls === 1 ? { ok: false, error: 'busy' } : { ok: true };
      }
      return { ok: true };
    };

    await store.startSession(
      [catalogTrack('catalog:a'), catalogTrack('catalog:b')],
      0,
      { shuffle: true, repeat: 'off', autoplay: true },
    );

    const queues = port.commands.filter(
      (entry) => entry.command.type === 'setQueue',
    );
    expect(queues).toHaveLength(2);
    const first = queues.at(0)?.command;
    const second = queues.at(1)?.command;
    if (first?.type !== 'setQueue' || second?.type !== 'setQueue') {
      throw new Error('expected two setQueue commands');
    }
    const firstOrder = first;
    const secondOrder = second;
    expect(firstOrder.order.map((entry) => entry.entryId)).toEqual(
      secondOrder.order.map((entry) => entry.entryId),
    );
    expect(secondOrder).toMatchObject({
      cursor: 0,
      autoplay: true,
      shuffle: true,
    });
    expect(secondOrder.order.map((entry) => entry.id)).toEqual([
      'catalog:a',
      'catalog:b',
    ]);
    expect(port.commands.at(-1)?.command).toEqual({
      type: 'transfer',
      target: {
        kind: 'device',
        clientId: store.clientId(),
        deviceId: 'device-1',
      },
    });
  });

  it('sends setQueue, then setRepeat, then transfer when starting a session', async () => {
    const { store, port } = await setup();

    await store.startSession([catalogTrack('catalog:a')], 0, {
      shuffle: false,
      repeat: 'all',
      autoplay: true,
    });

    expect(port.commands.map((entry) => entry.command.type)).toEqual([
      'setQueue',
      'setRepeat',
      'transfer',
    ]);
    expect(port.commands[1]?.command).toEqual({
      type: 'setRepeat',
      repeat: 'all',
    });
    expect(store.error()).toBeNull();
  });

  it('does not record a transport failure when starting a queue', async () => {
    const { store, port } = await setup();
    port.result = () => ({ ok: false, error: 'offline' });

    const ids = await store.startSession([catalogTrack('catalog:a')], 0, {
      shuffle: false,
      repeat: 'off',
      autoplay: true,
    });

    expect(ids).toBeNull();
    expect(store.error()).toBeNull();
  });

  it('aborts before transfer and rolls back the queue when setRepeat fails', async () => {
    const { store, port } = await setup();
    port.result = (command) =>
      command.type === 'setRepeat'
        ? { ok: false, error: 'repeat-denied' }
        : { ok: true };

    const ids = await store.startSession([catalogTrack('catalog:a')], 0, {
      shuffle: false,
      repeat: 'one',
      autoplay: true,
    });

    expect(ids).toBeNull();
    expect(port.commands.map((entry) => entry.command.type)).toEqual([
      'setQueue',
      'setRepeat',
      'setQueue',
    ]);
    // The rollback empties only the queue; it must not clear the target.
    expect(port.commands.at(-1)?.command).toMatchObject({
      type: 'setQueue',
      order: [],
      cursor: -1,
    });
    expect(store.error()).toBe('repeat-denied');
    expect(
      port.commands.some((entry) => entry.command.type === 'transfer'),
    ).toBe(false);
  });

  it('starts a new queue on a responsive remote target without taking playback', async () => {
    const { store, port } = await setup();
    port.push(
      welcome(
        store,
        session({
          target: remoteTarget(),
          order: [wire('e0', 'catalog:a')],
          cursor: 0,
          playing: true,
        }),
      ),
    );
    await settle();
    port.commands.length = 0;

    const ids = await store.startSession([catalogTrack('catalog:a')], 0, {
      shuffle: false,
      repeat: 'off',
      autoplay: true,
    });

    expect(ids).not.toBeNull();
    expect(port.commands.map((entry) => entry.command.type)).toEqual([
      'setQueue',
      'setRepeat',
    ]);
    expect(store.error()).toBeNull();
    expect(store.isTarget()).toBe(false);
    expect(store.mirroring()).toBe(true);
  });

  it('takes playback over from a stale target', async () => {
    const { store, port } = await setup();
    port.push(
      welcome(
        store,
        session({
          target: remoteTarget(),
          targetStale: true,
          order: [wire('e0', 'catalog:a')],
          cursor: 0,
          playing: true,
        }),
      ),
    );
    await settle();
    port.commands.length = 0;

    await store.startSession([catalogTrack('catalog:a')], 0, {
      shuffle: false,
      repeat: 'off',
      autoplay: true,
    });

    expect(port.commands.map((entry) => entry.command.type)).toEqual([
      'setQueue',
      'setRepeat',
      'transfer',
    ]);
    const transfer = port.commands.at(-1)?.command;
    if (transfer?.type !== 'transfer') {
      throw new Error('expected a transfer command');
    }
    expect(transfer.target).toEqual({
      kind: 'device',
      clientId: store.clientId(),
      deviceId: 'device-1',
    });
  });

  it('takes playback over from an earlier instance of this device', async () => {
    const { store, port } = await setup();
    port.push(
      welcome(
        store,
        session({
          target: {
            kind: 'device',
            clientId: 'old-client',
            deviceId: 'device-1',
          },
          order: [wire('e0', 'catalog:a')],
          cursor: 0,
          playing: true,
        }),
      ),
    );
    await settle();
    port.commands.length = 0;

    await store.startSession([catalogTrack('catalog:a')], 0, {
      shuffle: false,
      repeat: 'off',
      autoplay: true,
    });

    const transfer = port.commands.at(-1)?.command;
    if (transfer?.type !== 'transfer') {
      throw new Error('expected a transfer command');
    }
    expect(transfer.target).toMatchObject({
      kind: 'device',
      clientId: store.clientId(),
    });
  });

  it('adopts a stale earlier instance of this device paused, without autoplay', async () => {
    const { store, port, engine } = await setup();
    port.push(
      welcome(
        store,
        session({
          target: { kind: 'device', clientId: 'old-client', deviceId: 'device-1' },
          targetStale: true,
          order: [wire('e0', 'catalog:a')],
          cursor: 0,
          positionSec: 42,
          playing: true,
          updatedAt: Date.now(),
        }),
      ),
    );
    await settle();

    expect(port.commands.map((entry) => entry.command.type)).toEqual([
      'pause',
      'transfer',
    ]);
    expect(port.commands.at(-1)?.command).toEqual({
      type: 'transfer',
      target: { kind: 'device', clientId: store.clientId(), deviceId: 'device-1' },
    });

    // The server applies the transfer: this client is the target, now paused.
    port.push({
      type: 'state',
      session: device(store, {
        revision: 2,
        order: [wire('e0', 'catalog:a')],
        cursor: 0,
        positionSec: 42,
        playing: false,
        updatedAt: Date.now(),
      }),
    });
    await settle();

    expect(store.isTarget()).toBe(true);
    expect(engine.play).not.toHaveBeenCalled();
    expect(engine.status()).not.toBe('playing');
    expect(port.commands).toHaveLength(2);
  });

  it('retries only the transfer after a failed transfer, and resets on sign-out', async () => {
    const { store, port, auth } = await setup();
    const staleOld = session({
      target: { kind: 'device', clientId: 'old-client', deviceId: 'device-1' },
      targetStale: true,
      order: [wire('e0', 'catalog:a')],
      cursor: 0,
      positionSec: 42,
      playing: true,
      updatedAt: Date.now(),
    });
    let transfers = 0;
    port.result = (command) => {
      if (command.type !== 'transfer') return { ok: true };
      transfers++;
      return transfers === 1 ? { ok: false, error: 'busy' } : { ok: true };
    };
    port.push(welcome(store, staleOld));
    await settle();
    expect(port.commands.map((entry) => entry.command.type)).toEqual(['pause', 'transfer']);

    // A later state retries; the pause already succeeded, so only the transfer repeats.
    port.push({ type: 'state', session: { ...staleOld, revision: 2, playing: false } });
    await settle();
    expect(port.commands.map((entry) => entry.command.type)).toEqual([
      'pause',
      'transfer',
      'transfer',
    ]);

    // Adopted: the same old target no longer triggers another attempt.
    port.push({ type: 'state', session: { ...staleOld, revision: 3, playing: false } });
    await settle();
    expect(port.commands).toHaveLength(3);

    // Sign-out then sign-in starts adoption fresh: the pause runs again.
    auth.status.set('signedOut');
    await settle();
    auth.status.set('signedIn');
    await settle();
    port.commands.length = 0;
    transfers = 1;
    port.push(welcome(store, { ...staleOld, revision: 4, playing: true }));
    await settle();
    expect(port.commands.map((entry) => entry.command.type)).toEqual(['pause', 'transfer']);
  });

  it('aborts the transfer when the target moved during the pause', async () => {
    const { store, port } = await setup();
    port.result = (command) => {
      if (command.type === 'pause') {
        port.push(welcome(store, session({ target: remoteTarget(), playing: false })));
      }
      return { ok: true };
    };
    port.push(
      welcome(
        store,
        session({
          target: { kind: 'device', clientId: 'old-client', deviceId: 'device-1' },
          targetStale: true,
          order: [wire('e0', 'catalog:a')],
          cursor: 0,
          playing: true,
          updatedAt: Date.now(),
        }),
      ),
    );
    await settle();

    expect(port.commands.map((entry) => entry.command.type)).toEqual(['pause']);
  });

  it('refuses a phone local entry before any network call (no file port)', async () => {
    const uploads: CastUploadPort = {
      upload: vi.fn(async () => ({
        uploadId: 'upload-1',
        sizeBytes: 10,
        expiresAt: 0,
      })),
      usage: vi.fn(async () => ({ bytes: 0, count: 0, cap: 100 })),
      clear: vi.fn(async () => ({ freedBytes: 0, retainedBytes: 0 })),
    };
    const { store, port } = await setup({ uploads });
    port.push(
      welcome(
        store,
        session({
          target: remoteTarget(),
          order: [wire('e0', 'local:a', { providerId: 'local', local: true })],
          cursor: 0,
        }),
      ),
    );
    await settle();
    port.commands.length = 0;

    const ok = await store.transferTo({ kind: 'cast', castId: 'cast-1' });

    expect(ok).toBe(false);
    expect(store.error()).toBe('cast-local-pc-only');
    expect(uploads.upload).not.toHaveBeenCalled();
    expect(port.commands).toHaveLength(0);
  });

  it('refuses a local cast upload from a page on another origin', async () => {
    const uploads: CastUploadPort = {
      upload: vi.fn(async () => ({
        uploadId: 'upload-1',
        sizeBytes: 10,
        expiresAt: 0,
      })),
      usage: vi.fn(async () => ({ bytes: 0, count: 0, cap: 100 })),
      clear: vi.fn(async () => ({ freedBytes: 0, retainedBytes: 0 })),
    };
    const files: CastFilePort = {
      bytes: vi.fn(async () => new Blob(['audio'])),
    };
    const { store, port } = await setup({
      uploads,
      files,
      serverUrl: 'https://other.test',
    });
    port.push(
      welcome(
        store,
        session({
          target: remoteTarget(),
          order: [wire('e0', 'local:a', { providerId: 'local', local: true })],
          cursor: 0,
        }),
      ),
    );
    await settle();
    port.commands.length = 0;

    const ok = await store.transferTo({ kind: 'cast', castId: 'cast-1' });

    expect(ok).toBe(false);
    expect(store.error()).toBe('cast-local-pc-only');
    expect(files.bytes).not.toHaveBeenCalled();
    expect(uploads.upload).not.toHaveBeenCalled();
    expect(port.commands).toHaveLength(0);
  });

  it('refuses a cast transfer of local entries when the upload adapter is missing', async () => {
    const files: CastFilePort = {
      bytes: vi.fn(async () => new Blob(['audio'])),
    };
    const { store, port } = await setup({ files });
    port.push(
      welcome(
        store,
        session({
          target: remoteTarget(),
          order: [wire('e0', 'local:a', { providerId: 'local', local: true })],
          cursor: 0,
        }),
      ),
    );
    await settle();
    port.commands.length = 0;

    const ok = await store.transferTo({ kind: 'cast', castId: 'cast-1' });

    expect(ok).toBe(false);
    expect(store.error()).toBe('cast-upload-unavailable');
    expect(port.commands).toHaveLength(0);
    expect(store.session()?.order[0]?.uploadId).toBeUndefined();
  });

  it('uploads a local entry once and reuses the upload id on a retry', async () => {
    const uploads: CastUploadPort = {
      upload: vi.fn(async () => ({
        uploadId: 'upload-1',
        sizeBytes: 10,
        expiresAt: Date.now() + 1000,
      })),
      usage: vi.fn(async () => ({ bytes: 10, count: 1, cap: 100 })),
      clear: vi.fn(async () => ({ freedBytes: 10, retainedBytes: 0 })),
    };
    const files: CastFilePort = {
      bytes: vi.fn(async () => new Blob(['audio'])),
    };
    const { store, port, tracks } = await setup({ uploads, files });
    const full: Track = {
      id: 'local:a',
      providerId: 'local',
      title: 'Local A',
      artist: 'Artist',
      sourceFile: 'imported/a.mp3',
    };
    tracks.set(new Map([['local:a', full]]));
    port.push(
      welcome(
        store,
        session({
          target: remoteTarget(),
          order: [wire('e0', 'local:a', { providerId: 'local', local: true })],
          cursor: 0,
        }),
      ),
    );
    await settle();

    await expect(
      store.transferTo({ kind: 'cast', castId: 'cast-1' }),
    ).resolves.toBe(true);
    await expect(
      store.transferTo({ kind: 'cast', castId: 'cast-1' }),
    ).resolves.toBe(true);

    // Read and upload once; the second transfer only re-sends the replace.
    expect(files.bytes).toHaveBeenCalledTimes(1);
    expect(uploads.upload).toHaveBeenCalledTimes(1);
    const replaces = port.commands.filter(
      (entry) => entry.command.type === 'replace',
    );
    expect(replaces).toHaveLength(2);
    expect(replaces[0]?.command).toEqual({
      type: 'replace',
      entryId: 'e0',
      track: expect.objectContaining({ uploadId: 'upload-1' }),
    });
    expect(port.commands.at(-1)?.command).toEqual({
      type: 'transfer',
      target: { kind: 'cast', castId: 'cast-1' },
    });
  });

  it('aborts the previous upload batch when a new transfer starts', async () => {
    let firstSignal: AbortSignal | undefined;
    let uploadCalls = 0;
    const upload = vi.fn(
      async (
        _file: Blob,
        _name: string,
        opts?: {
          signal?: AbortSignal;
          onProgress?: (fraction: number) => void;
        },
      ) => {
        uploadCalls++;
        if (uploadCalls === 1) {
          firstSignal = opts?.signal;
          opts?.onProgress?.(0.5);
          await new Promise<void>((_resolve, reject) => {
            opts?.signal?.addEventListener(
              'abort',
              () => reject(new DOMException('aborted', 'AbortError')),
              { once: true },
            );
          });
        }
        return {
          uploadId: `upload-${uploadCalls}`,
          sizeBytes: 10,
          expiresAt: 0,
        };
      },
    );
    const uploads: CastUploadPort = {
      upload,
      usage: vi.fn(async () => ({ bytes: 0, count: 0, cap: 100 })),
      clear: vi.fn(async () => ({ freedBytes: 0, retainedBytes: 0 })),
    };
    const files: CastFilePort = {
      bytes: vi.fn(async () => new Blob(['audio'])),
    };
    const { store, port } = await setup({ uploads, files });
    port.push(
      welcome(
        store,
        session({
          target: remoteTarget(),
          order: [wire('e0', 'local:a', { providerId: 'local', local: true })],
          cursor: 0,
        }),
      ),
    );
    await settle();

    const first = store.transferTo({ kind: 'cast', castId: 'cast-1' });
    await settle();
    expect(firstSignal).toBeDefined();
    expect(store.castUpload()).toEqual({
      done: 0,
      total: 1,
      fraction: 0.5,
    });

    const second = store.transferTo({ kind: 'cast', castId: 'cast-1' });
    await expect(first).resolves.toBe(false);
    expect(firstSignal?.aborted).toBe(true);
    // A cancelled batch never surfaces an error toast.
    expect(store.error()).toBeNull();

    await expect(second).resolves.toBe(true);
    expect(uploadCalls).toBe(2);
    expect(store.castUpload()).toBeNull();
  });

  it('uploads local entries before a cast transfer and clears the cast cache', async () => {
    const upload = vi.fn(async (_file: Blob, _name: string) => ({
      uploadId: 'upload-1',
      sizeBytes: 10,
      expiresAt: Date.now() + 1000,
    }));
    const uploads: CastUploadPort = {
      upload,
      usage: vi.fn(async () => ({ bytes: 10, count: 1, cap: 100 })),
      clear: vi.fn(async () => ({ freedBytes: 10, retainedBytes: 0 })),
    };
    const files: CastFilePort = {
      bytes: vi.fn(async () => new Blob(['audio'])),
    };
    const { store, port, tracks } = await setup({ uploads, files });
    const full: Track = {
      id: 'local:a',
      providerId: 'local',
      title: 'Local A',
      artist: 'Artist',
      sourceFile: 'imported/a.mp3',
    };
    tracks.set(new Map([['local:a', full]]));
    port.push(
      welcome(
        store,
        session({
          target: remoteTarget(),
          order: [wire('e0', 'local:a', { providerId: 'local', local: true })],
          cursor: 0,
        }),
      ),
    );
    await settle();

    const ok = await store.transferTo({ kind: 'cast', castId: 'cast-1' });

    expect(ok).toBe(true);
    expect(files.bytes).toHaveBeenCalledWith(full);
    expect(uploads.upload).toHaveBeenCalledTimes(1);
    // The stored path's real extension reaches the multipart filename: the
    // server derives the cast file type from it.
    expect(upload.mock.calls[0]?.[0]).toBeInstanceOf(Blob);
    expect(upload.mock.calls[0]?.[1].endsWith('.mp3')).toBe(true);
    expect(port.commands.at(-2)?.command).toEqual({
      type: 'replace',
      entryId: 'e0',
      track: expect.objectContaining({ uploadId: 'upload-1' }),
    });
    expect(port.commands.at(-1)?.command).toEqual({
      type: 'transfer',
      target: { kind: 'cast', castId: 'cast-1' },
    });

    await expect(store.clearCastCache()).resolves.toEqual({
      freedBytes: 10,
      retainedBytes: 0,
    });
  });

  it('falls back to the blob mime type when the track has no sourceFile', async () => {
    const upload = vi.fn(async (_file: Blob, _name: string) => ({
      uploadId: 'upload-1',
      sizeBytes: 10,
      expiresAt: 0,
    }));
    const uploads: CastUploadPort = {
      upload,
      usage: vi.fn(async () => ({ bytes: 0, count: 0, cap: 100 })),
      clear: vi.fn(async () => ({ freedBytes: 0, retainedBytes: 0 })),
    };
    const blob = new Blob(['audio'], { type: 'audio/flac' });
    const files: CastFilePort = {
      bytes: vi.fn(async () => blob),
    };
    const { store, port, tracks } = await setup({ uploads, files });
    const full: Track = {
      id: 'local:b',
      providerId: 'local',
      title: 'Local B',
      artist: 'Artist',
    };
    tracks.set(new Map([['local:b', full]]));
    port.push(
      welcome(
        store,
        session({
          target: remoteTarget(),
          order: [wire('e1', 'local:b', { providerId: 'local', local: true })],
          cursor: 0,
        }),
      ),
    );
    await settle();

    await expect(
      store.transferTo({ kind: 'cast', castId: 'cast-1' }),
    ).resolves.toBe(true);

    expect(upload.mock.calls[0]?.[0]).toBe(blob);
    expect(upload.mock.calls[0]?.[1].endsWith('.flac')).toBe(true);
  });

  it('uploads a new queue local import before queueing it on a cast target', async () => {
    const uploads: CastUploadPort = {
      upload: vi.fn(async () => ({
        uploadId: 'upload-1',
        sizeBytes: 10,
        expiresAt: 0,
      })),
      usage: vi.fn(async () => ({ bytes: 0, count: 0, cap: 100 })),
      clear: vi.fn(async () => ({ freedBytes: 0, retainedBytes: 0 })),
    };
    const files: CastFilePort = {
      bytes: vi.fn(async () => new Blob(['audio'])),
    };
    const { store, port, tracks } = await setup({ uploads, files });
    const full: Track = {
      id: 'local:a',
      providerId: 'local',
      title: 'Local A',
      artist: 'Artist',
      sourceFile: 'imported/a.mp3',
    };
    tracks.set(new Map([['local:a', full]]));
    port.push(
      welcome(
        store,
        session({
          target: { kind: 'cast', castId: 'cast-1' },
          order: [],
          cursor: -1,
          playing: true,
        }),
      ),
    );
    await settle();
    port.commands.length = 0;

    const ids = await store.startSession([full], 0, {
      shuffle: false,
      repeat: 'off',
      autoplay: true,
    });

    expect(ids).not.toBeNull();
    expect(files.bytes).toHaveBeenCalledWith(full);
    expect(uploads.upload).toHaveBeenCalledTimes(1);
    const setQueue = port.commands.find(
      (entry) => entry.command.type === 'setQueue',
    )?.command;
    if (setQueue?.type !== 'setQueue') throw new Error('expected setQueue');
    expect(setQueue.order[0]).toMatchObject({
      id: 'local:a',
      local: true,
      uploadId: 'upload-1',
    });
    // The queue follows the speaker; this client does not take playback over.
    expect(
      port.commands.some((entry) => entry.command.type === 'transfer'),
    ).toBe(false);
  });

  it('reuses a queued upload when the same cast is transferred to later', async () => {
    const uploads: CastUploadPort = {
      upload: vi.fn(async () => ({
        uploadId: 'upload-1',
        sizeBytes: 10,
        expiresAt: 0,
      })),
      usage: vi.fn(async () => ({ bytes: 0, count: 0, cap: 100 })),
      clear: vi.fn(async () => ({ freedBytes: 0, retainedBytes: 0 })),
    };
    const files: CastFilePort = {
      bytes: vi.fn(async () => new Blob(['audio'])),
    };
    const { store, port, tracks } = await setup({ uploads, files });
    const full: Track = {
      id: 'local:a',
      providerId: 'local',
      title: 'Local A',
      artist: 'Artist',
      sourceFile: 'imported/a.mp3',
    };
    tracks.set(new Map([['local:a', full]]));
    port.push(
      welcome(
        store,
        session({
          target: { kind: 'cast', castId: 'cast-1' },
          order: [],
          cursor: -1,
          playing: true,
        }),
      ),
    );
    await settle();

    await store.startSession([full], 0, {
      shuffle: false,
      repeat: 'off',
      autoplay: true,
    });
    expect(uploads.upload).toHaveBeenCalledTimes(1);
    expect(files.bytes).toHaveBeenCalledTimes(1);

    // The server now holds the queued entry (as it would after setQueue).
    port.push(
      welcome(
        store,
        session({
          target: { kind: 'cast', castId: 'cast-1' },
          order: [
            wire('e0', 'local:a', { providerId: 'local', local: true }),
          ],
          cursor: 0,
          playing: true,
        }),
      ),
    );
    await settle();
    port.commands.length = 0;

    await expect(
      store.transferTo({ kind: 'cast', castId: 'cast-1' }),
    ).resolves.toBe(true);

    // The accepted setQueue upload is reused: no second read or upload.
    expect(files.bytes).toHaveBeenCalledTimes(1);
    expect(uploads.upload).toHaveBeenCalledTimes(1);
    const replaced = port.commands.find(
      (entry) => entry.command.type === 'replace',
    )?.command;
    if (replaced?.type !== 'replace') throw new Error('expected replace');
    expect(replaced.track).toMatchObject({ uploadId: 'upload-1' });
    expect(port.commands.at(-1)?.command).toEqual({
      type: 'transfer',
      target: { kind: 'cast', castId: 'cast-1' },
    });
  });

  it('refuses to queue a phone local import on a cast before any command', async () => {
    const uploads: CastUploadPort = {
      upload: vi.fn(async () => ({
        uploadId: 'upload-1',
        sizeBytes: 10,
        expiresAt: 0,
      })),
      usage: vi.fn(async () => ({ bytes: 0, count: 0, cap: 100 })),
      clear: vi.fn(async () => ({ freedBytes: 0, retainedBytes: 0 })),
    };
    const files: CastFilePort = {
      bytes: vi.fn(async () => new Blob(['audio'])),
    };
    const { store, port, tracks } = await setup({
      uploads,
      files,
      serverUrl: 'https://other.test',
    });
    const full: Track = {
      id: 'local:a',
      providerId: 'local',
      title: 'Local A',
      artist: 'Artist',
      sourceFile: 'imported/a.mp3',
    };
    tracks.set(new Map([['local:a', full]]));
    port.push(
      welcome(
        store,
        session({
          target: { kind: 'cast', castId: 'cast-1' },
          order: [],
          cursor: -1,
          playing: true,
        }),
      ),
    );
    await settle();
    port.commands.length = 0;

    const ids = await store.startSession([full], 0, {
      shuffle: false,
      repeat: 'off',
      autoplay: true,
    });

    expect(ids).toBeNull();
    expect(store.error()).toBe('cast-local-pc-only');
    expect(uploads.upload).not.toHaveBeenCalled();
    expect(port.commands).toHaveLength(0);
  });

  it('skips uploads when the cast target is stale and still queues', async () => {
    const uploads: CastUploadPort = {
      upload: vi.fn(async () => ({
        uploadId: 'upload-1',
        sizeBytes: 10,
        expiresAt: 0,
      })),
      usage: vi.fn(async () => ({ bytes: 0, count: 0, cap: 100 })),
      clear: vi.fn(async () => ({ freedBytes: 0, retainedBytes: 0 })),
    };
    const files: CastFilePort = {
      bytes: vi.fn(async () => new Blob(['audio'])),
    };
    const { store, port, tracks } = await setup({ uploads, files });
    const full: Track = {
      id: 'local:a',
      providerId: 'local',
      title: 'Local A',
      artist: 'Artist',
      sourceFile: 'imported/a.mp3',
    };
    tracks.set(new Map([['local:a', full]]));
    port.push(
      welcome(
        store,
        session({
          target: { kind: 'cast', castId: 'cast-1' },
          targetStale: true,
          order: [],
          cursor: -1,
          playing: true,
        }),
      ),
    );
    await settle();
    port.commands.length = 0;

    const ids = await store.startSession([full], 0, {
      shuffle: false,
      repeat: 'off',
      autoplay: true,
    });

    expect(ids).not.toBeNull();
    expect(files.bytes).not.toHaveBeenCalled();
    expect(uploads.upload).not.toHaveBeenCalled();
    const setQueue = port.commands.find(
      (entry) => entry.command.type === 'setQueue',
    )?.command;
    if (setQueue?.type !== 'setQueue') throw new Error('expected setQueue');
    expect(setQueue.order[0]?.uploadId).toBeUndefined();
    // The speaker is stale, so this client takes playback over.
    expect(
      port.commands.some((entry) => entry.command.type === 'transfer'),
    ).toBe(true);
  });

  it('publishes local playback on play and keeps it playing after the server session is wiped', async () => {
    const { store, port, engine } = await setup();
    const player = TestBed.inject(PlayerStore);
    engine.queue.set([catalogTrack('a'), catalogTrack('b')]);
    engine.currentIndex.set(0);
    engine.position.set(30);

    // Local-only start: no session target yet, so play publishes this queue.
    await player.play();
    await settle(40);

    const sent = () => port.commands.map((entry) => entry.command.type);
    expect(sent()).toEqual(['setQueue', 'setRepeat', 'seek', 'transfer']);
    const setQueue = port.commands[0]?.command;
    if (setQueue?.type !== 'setQueue') throw new Error('expected setQueue');
    expect(setQueue.order.map((entry) => entry.id)).toEqual(['a', 'b']);
    expect(setQueue.cursor).toBe(0);

    // The server echoes the published state: this device is the target now.
    port.push({
      type: 'state',
      session: device(store, {
        revision: 2,
        order: setQueue.order,
        cursor: 0,
        positionSec: 30,
        playing: true,
        updatedAt: Date.now(),
      }),
    });
    await settle(40);
    expect(store.isTarget()).toBe(true);

    // The server restarts: the reconnect welcome has no session. Keep playing
    // and publish the queue again instead of pausing.
    port.push(welcome(store, null));
    await settle(40);

    expect(sent().filter((type) => type === 'setQueue')).toHaveLength(2);
    expect(sent().filter((type) => type === 'transfer')).toHaveLength(2);
    expect(engine.pause).not.toHaveBeenCalled();
    expect(engine.status()).toBe('playing');
  });

  it('pauses the published session when the engine paused during publish', async () => {
    const { port, engine } = await setup();
    const player = TestBed.inject(PlayerStore);
    engine.queue.set([catalogTrack('a'), catalogTrack('b')]);
    engine.currentIndex.set(0);
    port.result = (command) => {
      // The user pauses while the queue is being sent.
      if (command.type === 'setQueue') void player.pause();
      return { ok: true };
    };

    await player.play();
    await settle(40);

    const types = port.commands.map((entry) => entry.command.type);
    expect(types).toEqual(['setQueue', 'setRepeat', 'transfer', 'pause']);
    const setQueue = port.commands[0]?.command;
    if (setQueue?.type !== 'setQueue') throw new Error('expected setQueue');
    expect(setQueue.autoplay).toBe(true);
    expect(setQueue.shuffle).toBe(false);
    expect(engine.status()).toBe('paused');
  });

  it('republishes once from the new track when a skip lands during publish', async () => {
    const { port, engine } = await setup();
    const player = TestBed.inject(PlayerStore);
    engine.queue.set([catalogTrack('a'), catalogTrack('b')]);
    engine.currentIndex.set(0);
    let skipped = false;
    port.result = (command) => {
      // The user skips to the next track while the first queue is sent.
      if (command.type === 'setQueue' && !skipped) {
        skipped = true;
        void player.next();
      }
      return { ok: true };
    };

    await player.play();
    await settle(60);

    const setQueues = port.commands.flatMap((entry) =>
      entry.command.type === 'setQueue' ? [entry.command] : [],
    );
    expect(setQueues).toHaveLength(2);
    expect(setQueues[0]?.order.map((entry) => entry.id)).toEqual(['a', 'b']);
    expect(setQueues[1]?.order.map((entry) => entry.id)).toEqual(['b']);
    expect(setQueues[1]?.cursor).toBe(0);
    expect(engine.current()?.id).toBe('b');
  });

  it('keeps the engine on a track skipped during publish, and republishes it', async () => {
    const { store, port, engine } = await setup();
    const player = TestBed.inject(PlayerStore);
    engine.queue.set([catalogTrack('a'), catalogTrack('b')]);
    engine.currentIndex.set(0);
    let skipped = false;
    let echoed = false;
    port.result = (command) => {
      if (command.type === 'setQueue' && !skipped) {
        skipped = true;
        void player.next();
      }
      // Mid-publish the server echoes the first queue (cursor on `a`) and
      // this client as target. That echo must not rewind the skip.
      if (command.type === 'transfer' && !echoed) {
        echoed = true;
        port.push({
          type: 'state',
          session: device(store, {
            revision: 2,
            order: [wire('e1', 'a')],
            cursor: 0,
            playing: true,
            updatedAt: Date.now(),
          }),
        });
      }
      return { ok: true };
    };

    await player.play();
    await settle(60);

    const setQueues = port.commands.flatMap((entry) =>
      entry.command.type === 'setQueue' ? [entry.command] : [],
    );
    expect(setQueues).toHaveLength(2);
    expect(setQueues[1]?.order.map((entry) => entry.id)).toEqual(['b']);
    expect(engine.current()?.id).toBe('b');
    expect(engine.applyOrder).not.toHaveBeenCalled();
  });

  it('publishes a shuffled queue in play order, flagged as shuffled', async () => {
    const { port, engine } = await setup();
    const player = TestBed.inject(PlayerStore);
    engine.queue.set([catalogTrack('b'), catalogTrack('a')]);
    engine.currentIndex.set(0);
    engine.shuffle.set(true);

    await player.play();
    await settle(40);

    const setQueue = port.commands[0]?.command;
    if (setQueue?.type !== 'setQueue') throw new Error('expected setQueue');
    expect(setQueue.order.map((entry) => entry.id)).toEqual(['b', 'a']);
    expect(setQueue.shuffle).toBe(true);
    expect(setQueue.shuffled).toBe(true);
  });

  it('sends the natural order with a shuffled publish so shuffle off can restore it', async () => {
    const { port, engine } = await setup();
    const player = TestBed.inject(PlayerStore);
    engine.queue.set([catalogTrack('a'), catalogTrack('b'), catalogTrack('c'), catalogTrack('d')]);
    engine.currentIndex.set(2);
    engine.playOrder.set([2, 3, 0, 1]);
    engine.shuffle.set(true);

    await player.play();
    await settle(40);

    const setQueue = port.commands[0]?.command;
    if (setQueue?.type !== 'setQueue') throw new Error('expected setQueue');
    expect(setQueue.order.map((entry) => entry.id)).toEqual(['c', 'd', 'a', 'b']);
    // The natural order a, b, c, d, as the same entry ids in queue order.
    const [c, d, a, b] = setQueue.order;
    expect(setQueue.baseOrderIds).toEqual([
      a?.entryId,
      b?.entryId,
      c?.entryId,
      d?.entryId,
    ]);
  });

  it('reports nothing for the publish window when the engine index is past the published queue', async () => {
    const { store, port, engine } = await setup();
    const player = TestBed.inject(PlayerStore);
    engine.queue.set([catalogTrack('a'), catalogTrack('b'), catalogTrack('c'), catalogTrack('d')]);
    engine.currentIndex.set(2);
    engine.playOrder.set([2, 3, 0, 1]);
    engine.shuffle.set(true);
    let order: SessionTrack[] = [];
    let echoed = false;
    port.result = (command) => {
      if (command.type === 'setQueue') order = command.order;
      if (command.type === 'transfer' && !echoed) {
        echoed = true;
        // The echo makes this client the target while the engine is still on
        // `c`, which sits at index 2 of the full queue but index 0 here.
        port.push({
          type: 'state',
          session: device(store, {
            revision: 2,
            order,
            cursor: 0,
            playing: true,
            updatedAt: Date.now(),
          }),
        });
        engine.position.set(12);
      }
      return { ok: true };
    };

    await player.play();
    await settle(60);

    expect(store.isTarget()).toBe(true);
    expect(port.reports()).toEqual([]);
  });

  it('applies a remote command that lands mid-publish', async () => {
    const { store, port, engine } = await setup();
    const player = TestBed.inject(PlayerStore);
    engine.queue.set([catalogTrack('a'), catalogTrack('b'), catalogTrack('c')]);
    engine.currentIndex.set(0);
    let order: SessionTrack[] = [];
    let pushed = false;
    port.result = (command) => {
      if (command.type === 'setQueue') order = command.order;
      if (command.type === 'transfer' && !pushed) {
        pushed = true;
        // Another controller pressed next after the queue was sent: cursor on `b`.
        port.push({
          type: 'state',
          session: device(store, {
            revision: 2,
            order,
            cursor: 1,
            playing: true,
            updatedAt: Date.now(),
          }),
        });
      }
      return { ok: true };
    };

    await player.play();
    await settle(60);

    expect(port.commands.filter((entry) => entry.command.type === 'setQueue')).toHaveLength(1);
    expect(engine.current()?.id).toBe('b');
  });

  it('settles the held state from the first pass when the second pass fails', async () => {
    const { store, port, engine } = await setup();
    const player = TestBed.inject(PlayerStore);
    engine.queue.set([catalogTrack('a'), catalogTrack('b'), catalogTrack('c')]);
    engine.currentIndex.set(0);
    let order: SessionTrack[] = [];
    let skipped = false;
    let echoed = false;
    port.result = (command) => {
      if (command.type === 'setQueue') {
        if (!skipped) {
          order = command.order;
          skipped = true;
          void player.next();
        } else {
          // The re-pass is refused, so no second echo follows.
          return { ok: false, error: 'refused' };
        }
      }
      if (command.type === 'transfer' && !echoed) {
        echoed = true;
        port.push({
          type: 'state',
          session: device(store, {
            revision: 2,
            order,
            cursor: 0,
            playing: true,
            updatedAt: Date.now(),
          }),
        });
      }
      return { ok: true };
    };

    await player.play();
    await settle(60);

    // The first pass stays published, so the skip to `b` is reported and the
    // held first-pass echo (cursor `a`) must not rewind it. The refusal shows.
    expect(store.error()).toBe('refused');
    expect(engine.current()?.id).toBe('b');
    expect(port.reports().at(-1)).toMatchObject({
      reason: 'native-skip',
      entryId: order[1]?.entryId,
    });
    expect(engine.applyOrder).not.toHaveBeenCalled();
  });

  it('does not republish when the server echoes the queue with no target', async () => {
    const { port, engine } = await setup();
    const player = TestBed.inject(PlayerStore);
    engine.queue.set([catalogTrack('a'), catalogTrack('b')]);
    engine.currentIndex.set(0);
    port.result = (command) => {
      if (command.type === 'setQueue') {
        // The server broadcasts the queue to its sender before any target exists.
        port.push({
          type: 'state',
          session: session({
            revision: 2,
            order: command.order,
            cursor: 0,
            playing: true,
            updatedAt: Date.now(),
          }),
        });
      }
      return { ok: true };
    };

    await player.play();
    await settle(60);

    expect(port.commands.filter((entry) => entry.command.type === 'setQueue')).toHaveLength(1);
  });

  it('reports a skip that landed during the second pass once the hold ends', async () => {
    const { store, port, engine } = await setup();
    const player = TestBed.inject(PlayerStore);
    engine.queue.set([catalogTrack('a'), catalogTrack('b'), catalogTrack('c'), catalogTrack('d')]);
    engine.currentIndex.set(0);
    let order: SessionTrack[] = [];
    let setQueues = 0;
    port.result = (command) => {
      if (command.type === 'setQueue') {
        setQueues++;
        order = command.order;
        // A skip during each pass: a -> b in the first, b -> c in the second.
        void player.next();
      }
      if (command.type === 'transfer' && setQueues === 2) {
        port.push({
          type: 'state',
          session: device(store, {
            revision: 2,
            order,
            cursor: 0,
            playing: true,
            updatedAt: Date.now(),
          }),
        });
      }
      return { ok: true };
    };

    await player.play();
    await settle(60);

    expect(setQueues).toBe(2);
    expect(engine.current()?.id).toBe('c');
    // The server still has `b` as the cursor: tell it about the skip to `c`.
    expect(port.reports().at(-1)).toMatchObject({
      reason: 'native-skip',
      entryId: order[1]?.entryId,
    });
  });

  it('sends a seek made during a publish once the hold ends', async () => {
    const { store, port, engine } = await setup();
    const player = TestBed.inject(PlayerStore);
    engine.queue.set([catalogTrack('a'), catalogTrack('b')]);
    engine.currentIndex.set(0);
    engine.position.set(30);
    let order: SessionTrack[] = [];
    port.result = (command) => {
      if (command.type === 'setQueue') order = command.order;
      if (command.type === 'transfer') {
        port.push({
          type: 'state',
          session: device(store, {
            revision: 2,
            order,
            cursor: 0,
            positionSec: 30,
            playing: true,
            updatedAt: Date.now(),
          }),
        });
        // The user seeks while the publish is still held.
        engine.position.set(90);
        store.reportSeek();
        expect(port.reports()).toEqual([]);
      }
      return { ok: true };
    };

    await player.play();
    await settle(60);

    expect(port.reports().at(-1)).toMatchObject({
      reason: 'tick',
      entryId: order[0]?.entryId,
      positionSec: 90,
    });
    // The held echo (anchored at 30) must not drag the engine back.
    expect(engine.position()).toBe(90);
  });

  it('records a seek made before the transfer echo and reports it at the end', async () => {
    const { store, port, engine } = await setup();
    const player = TestBed.inject(PlayerStore);
    engine.queue.set([catalogTrack('a'), catalogTrack('b')]);
    engine.currentIndex.set(0);
    engine.position.set(30);
    let order: SessionTrack[] = [];
    port.result = (command) => {
      if (command.type === 'setQueue') order = command.order;
      if (command.type === 'transfer') {
        // Seek while this client is not yet the target (echo still pending).
        engine.position.set(90);
        store.reportSeek();
        port.push({
          type: 'state',
          session: device(store, {
            revision: 2,
            order,
            cursor: 0,
            positionSec: 30,
            playing: true,
            updatedAt: Date.now(),
          }),
        });
      }
      return { ok: true };
    };

    await player.play();
    await settle(60);

    expect(port.reports().at(-1)).toMatchObject({
      reason: 'tick',
      entryId: order[0]?.entryId,
      positionSec: 90,
    });
    expect(engine.position()).toBe(90);
  });

  it('replays an end of track that happened while the publish was held', async () => {
    const { store, port, engine } = await setup();
    const player = TestBed.inject(PlayerStore);
    engine.queue.set([catalogTrack('a'), catalogTrack('b')]);
    engine.currentIndex.set(0);
    let order: SessionTrack[] = [];
    port.result = (command) => {
      if (command.type === 'setQueue') order = command.order;
      if (command.type === 'transfer') {
        port.push({
          type: 'state',
          session: device(store, {
            revision: 2,
            order,
            cursor: 0,
            playing: true,
            updatedAt: Date.now(),
          }),
        });
        // The track finishes while the publish is still held.
        engine.status.set('ended');
      }
      return { ok: true };
    };

    await player.play();
    await settle(60);

    expect(port.reports()).toContainEqual(
      expect.objectContaining({ reason: 'ended', entryId: order[0]?.entryId }),
    );
    expect(port.reports().filter((report) => report.reason === 'ended')).toHaveLength(1);
  });

  it('keeps the first pass when the second pass fails after discarding, then republishes', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(3_000_000);
    const { store, port, engine } = await setup();
    const player = TestBed.inject(PlayerStore);
    engine.queue.set([catalogTrack('a'), catalogTrack('b'), catalogTrack('c')]);
    engine.currentIndex.set(0);
    let order: SessionTrack[] = [];
    let queues = 0;
    let repeats = 0;
    let revision = 1;
    port.result = (command) => {
      if (command.type === 'setQueue' && command.order.length === 0) {
        // The discard empties the queue; the server keeps this client as target.
        port.push({
          type: 'state',
          session: device(store, { revision: ++revision, order: [], cursor: -1 }),
        });
        return { ok: true };
      }
      if (command.type === 'setQueue') {
        queues++;
        order = command.order;
        // A skip during pass 1; pass 2 then fails and discards its queue.
        if (queues === 1) engine.currentIndex.set(1);
      }
      if (command.type === 'setRepeat') {
        repeats++;
        if (repeats === 2) return { ok: false, error: 'repeat-denied' };
      }
      if (command.type === 'transfer' && queues === 1) {
        port.push({
          type: 'state',
          session: device(store, {
            revision: ++revision,
            order,
            cursor: 0,
            playing: true,
            updatedAt: Date.now(),
          }),
        });
      }
      return { ok: true };
    };

    await player.play();
    await settle(60);

    // Pass 2 failed: the error shows, and the skip to `b` stays on the engine.
    expect(store.error()).toBe('repeat-denied');
    expect(engine.current()?.id).toBe('b');
    // The discarded server queue is not republished before the back-off ends.
    expect(queues).toBe(2);

    vi.advanceTimersByTime(15_000);
    await settle(40);

    // Republished from the engine's current track.
    expect(queues).toBe(3);
    const last = port.commands.filter(
      (entry) => entry.command.type === 'setQueue' && entry.command.order.length > 0,
    ).at(-1)?.command;
    if (last?.type !== 'setQueue') throw new Error('expected setQueue');
    expect(last.order.map((entry) => entry.id)).toEqual(['b', 'c']);
    expect(engine.current()?.id).toBe('b');
  });

  it('republishes after the back-off when the server loses its owner mid-publish', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(4_000_000);
    const { store, port, engine } = await setup();
    engine.queue.set([catalogTrack('a'), catalogTrack('b')]);
    engine.currentIndex.set(0);
    engine.status.set('playing');
    let failTransfer = true;
    port.result = (command) => {
      if (command.type === 'transfer' && failTransfer) {
        failTransfer = false;
        // The server restarts mid-publish: its reconnect welcome has no session.
        port.push(welcome(store, null));
        return { ok: false, error: 'busy' };
      }
      return { ok: true };
    };
    const queues = () =>
      port.commands.filter(
        (entry) => entry.command.type === 'setQueue' && entry.command.order.length > 0,
      ).length;

    expect(await store.publishLocal()).toBe(false);
    await settle(40);
    // The failed publish is not retried before the back-off ends, and the
    // engine keeps playing locally.
    expect(queues()).toBe(1);
    expect(engine.status()).toBe('playing');

    vi.advanceTimersByTime(15_000);
    await settle(40);

    expect(queues()).toBe(2);
    expect(store.isTarget()).toBe(false);
    expect(engine.status()).toBe('playing');
  });

  it('does not republish again when a persistent transfer refusal follows the queue echo', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(5_000_000);
    const { port, engine } = await setup();
    const player = TestBed.inject(PlayerStore);
    engine.queue.set([catalogTrack('a'), catalogTrack('b')]);
    engine.currentIndex.set(0);
    port.result = (command) => {
      if (command.type === 'setQueue' && command.order.length > 0) {
        // The server echoes the queue to its sender before any target exists.
        port.push({
          type: 'state',
          session: session({
            revision: 2,
            order: command.order,
            cursor: 0,
            playing: true,
            updatedAt: Date.now(),
          }),
        });
      }
      // Every transfer is refused, so this device never gets the target.
      return command.type === 'transfer'
        ? { ok: false, error: 'refused' }
        : { ok: true };
    };

    await player.play();
    await settle(40);
    vi.advanceTimersByTime(120_000);
    await settle(40);

    const queues = port.commands.filter(
      (entry) => entry.command.type === 'setQueue' && entry.command.order.length > 0,
    );
    expect(queues).toHaveLength(1);
    expect(engine.status()).toBe('playing');
  });

  it('replays play when a local resume happened during the held publish', async () => {
    const { store, port, engine } = await setup();
    const player = TestBed.inject(PlayerStore);
    engine.queue.set([catalogTrack('a'), catalogTrack('b')]);
    engine.currentIndex.set(0);
    let order: SessionTrack[] = [];
    port.result = (command) => {
      if (command.type === 'setQueue') order = command.order;
      if (command.type === 'transfer') {
        // The user pauses and resumes while the publish is held.
        engine.status.set('paused');
        TestBed.tick();
        engine.status.set('playing');
        TestBed.tick();
        port.push({
          type: 'state',
          session: device(store, {
            revision: 2,
            order,
            cursor: 0,
            playing: false,
            updatedAt: Date.now(),
          }),
        });
      }
      return { ok: true };
    };

    await player.play();
    await settle(60);

    expect(port.commands.map((entry) => entry.command.type)).toContain('play');
    expect(engine.status()).toBe('playing');
  });

  it('applies a remote pause that lands during the held publish', async () => {
    const { store, port, engine } = await setup();
    const player = TestBed.inject(PlayerStore);
    engine.queue.set([catalogTrack('a'), catalogTrack('b')]);
    engine.currentIndex.set(0);
    let order: SessionTrack[] = [];
    port.result = (command) => {
      if (command.type === 'setQueue') order = command.order;
      if (command.type === 'transfer') {
        // Another controller paused; the engine was never paused locally.
        port.push({
          type: 'state',
          session: device(store, {
            revision: 2,
            order,
            cursor: 0,
            playing: false,
            updatedAt: Date.now(),
          }),
        });
      }
      return { ok: true };
    };

    await player.play();
    await settle(60);

    expect(port.commands.map((entry) => entry.command.type)).not.toContain('play');
    expect(engine.status()).toBe('paused');
  });

  it('pauses and tells the server when a replayed play is refused', async () => {
    const { store, port, engine } = await setup();
    const player = TestBed.inject(PlayerStore);
    engine.queue.set([catalogTrack('a'), catalogTrack('b')]);
    engine.currentIndex.set(0);
    let order: SessionTrack[] = [];
    // The refusal travels over the network, so it lands after the local apply.
    const answer = port.command.bind(port);
    port.command = async (id, command) => {
      const result = await answer(id, command);
      if (command.type === 'play') await new Promise((done) => setTimeout(done, 0));
      return result;
    };
    port.result = (command) => {
      if (command.type === 'setQueue') order = command.order;
      if (command.type === 'play') return { ok: false, error: 'refused' };
      if (command.type === 'transfer') {
        engine.status.set('paused');
        TestBed.tick();
        engine.status.set('playing');
        TestBed.tick();
        port.push({
          type: 'state',
          session: device(store, {
            revision: 2,
            order,
            cursor: 0,
            playing: false,
            updatedAt: Date.now(),
          }),
        });
      }
      return { ok: true };
    };

    await player.play();
    await settle(60);
    await new Promise((done) => setTimeout(done, 0));
    await settle(10);

    expect(store.error()).toBe('refused');
    expect(engine.status()).toBe('paused');
    expect(port.reports().at(-1)).toMatchObject({ reason: 'playing', playing: false });
  });

  it('keeps playing when a replayed play fails on the transport', async () => {
    const { store, port, engine } = await setup();
    const player = TestBed.inject(PlayerStore);
    engine.queue.set([catalogTrack('a'), catalogTrack('b')]);
    engine.currentIndex.set(0);
    let order: SessionTrack[] = [];
    port.result = (command) => {
      if (command.type === 'setQueue') order = command.order;
      if (command.type === 'play') return { ok: false, error: 'unavailable' };
      if (command.type === 'transfer') {
        engine.status.set('paused');
        TestBed.tick();
        engine.status.set('playing');
        TestBed.tick();
        port.push({
          type: 'state',
          session: device(store, {
            revision: 2,
            order,
            cursor: 0,
            playing: false,
            updatedAt: Date.now(),
          }),
        });
      }
      return { ok: true };
    };

    await player.play();
    await settle(60);

    // A transport failure is not a refusal: no error, no pause, no playing:false.
    expect(port.commands.map((entry) => entry.command.type)).toContain('play');
    expect(store.error()).toBeNull();
    expect(engine.status()).toBe('playing');
    expect(port.reports().some((report) => report.playing === false)).toBe(false);
  });

  it('republishes a genuine owner loss that follows a successful publish', async () => {
    const { store, port, engine } = await setup();
    engine.queue.set([catalogTrack('a'), catalogTrack('b')]);
    engine.currentIndex.set(0);
    engine.status.set('playing');
    let transfers = 0;
    let order: SessionTrack[] = [];
    port.result = (command) => {
      if (command.type === 'setQueue') order = command.order;
      if (command.type === 'transfer') {
        transfers++;
        if (transfers === 1) {
          // Another controller takes the session: target cleared, a foreign queue.
          port.push({
            type: 'state',
            session: session({
              revision: 2,
              order: [wire('foreign', 'x')],
              cursor: 0,
              playing: true,
              updatedAt: Date.now(),
            }),
          });
        } else {
          port.push({
            type: 'state',
            session: device(store, {
              revision: 3,
              order,
              cursor: 0,
              playing: true,
              updatedAt: Date.now(),
            }),
          });
        }
      }
      return { ok: true };
    };
    const queues = () =>
      port.commands.filter(
        (entry) => entry.command.type === 'setQueue' && entry.command.order.length > 0,
      ).length;

    expect(await store.publishLocal()).toBe(true);
    await settle(60);

    // The publish succeeded, but the owner was lost before it ended: publish again.
    expect(queues()).toBe(2);
    expect(store.isTarget()).toBe(true);
    expect(engine.status()).toBe('playing');
  });

  it('stays inert without a SessionPort (local-only mode)', async () => {
    const engine = fakeEngine();
    const status = signal<AuthStatus>('signedIn');
    const settings = {
      ready: vi.fn(async () => undefined),
      deviceId: signal('device-1'),
      deviceName: signal('Pixel 8'),
      sessionEnabled: signal(true),
      castEnabled: signal(true),
      downloadServerUrl: signal('https://server.test'),
    };
    TestBed.configureTestingModule({
      providers: [
        { provide: PlayerService, useValue: { engine } },
        {
          provide: AuthStore,
          useValue: {
            status,
            signedIn: computed(() => status() === 'signedIn'),
            accessToken: vi.fn(async () => 'token'),
          },
        },
        { provide: SettingsStore, useValue: settings },
        {
          provide: LibraryStore,
          useValue: {
            trackMap: computed(() => new Map<string, Track>()),
            track: () => undefined,
          },
        },
      ],
    });
    const store = TestBed.inject(SessionStore);
    store.start();
    await settle();

    expect(store.available()).toBe(false);
    expect(store.connection()).toBe('off');
    expect(store.session()).toBeNull();
    store.report('tick');
    await expect(store.command({ type: 'play' })).resolves.toMatchObject({
      ok: false,
    });
    await expect(store.clearCastCache()).resolves.toEqual({
      freedBytes: 0,
      retainedBytes: 0,
    });
  });

  it('injects alongside PlayerStore without a DI cycle', async () => {
    await setup();
    expect(() => TestBed.inject(PlayerStore)).not.toThrow();
    expect(TestBed.inject(PlayerStore)).toBeTruthy();
  });
});
