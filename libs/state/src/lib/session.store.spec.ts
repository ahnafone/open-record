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

  const applyOrder = vi.fn(
    async (
      order: readonly Track[],
      cursor: number,
      opts: ApplyOptions = {},
    ) => {
      queue.set([...order]);
      currentIndex.set(cursor);
      position.set(opts.positionSec ?? 0);
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

  return {
    queue,
    currentIndex,
    current,
    status,
    position,
    duration,
    isPlaying,
    applyOrder,
    play,
    pause,
    seekIfDrifted,
    upcoming: computed(() => []),
    upcomingEntries: computed(() => []),
    playNextIndices: signal<readonly number[]>([]),
    shuffle: signal(false),
    repeat: signal('off'),
    hasNext: computed(() => false),
    hasPrevious: computed(() => false),
    lastPlay: signal(null),
    error: signal(null),
    volume: signal(1),
    muted: signal(false),
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
}

async function setup(options: SetupOptions = {}) {
  const engine = fakeEngine({ blocked: options.blocked });
  const port = options.port === undefined ? new FakePort() : options.port;
  const tracks = signal<ReadonlyMap<string, Track>>(new Map());
  const status = signal<AuthStatus>('signedIn');
  const deviceName = signal('Pixel 8');
  const serverUrl = signal('https://server.test');
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

  it('aborts before transfer when setRepeat fails', async () => {
    const { store, port } = await setup();
    port.result = (command) =>
      command.type === 'setRepeat'
        ? { ok: false, error: 'repeat-denied' }
        : { ok: true };

    await store.startSession([catalogTrack('catalog:a')], 0, {
      shuffle: false,
      repeat: 'one',
      autoplay: true,
    });

    expect(port.commands.map((entry) => entry.command.type)).toEqual([
      'setQueue',
      'setRepeat',
    ]);
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

  it('refuses a cast transfer of local entries without upload ports', async () => {
    const { store, port } = await setup();
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

  it('uploads local entries before a cast transfer and clears the cast cache', async () => {
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

    const ok = await store.transferTo({ kind: 'cast', castId: 'cast-1' });

    expect(ok).toBe(true);
    expect(files.bytes).toHaveBeenCalledWith(full);
    expect(uploads.upload).toHaveBeenCalledTimes(1);
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
