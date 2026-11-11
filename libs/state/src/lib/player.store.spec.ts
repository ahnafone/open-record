import { computed, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type {
  CommandResult,
  SessionCommand,
  SessionEntry,
  Track,
} from '@open-record/models';
import { PlayerService } from '@open-record/player';
import type { PlayerStatus, RepeatMode, StackEntry } from '@open-record/player';
import { StoragePort, createInMemoryStorage } from '@open-record/storage';
import { LibraryStore } from './library.store';
import { PlayCountsStore } from './play-counts.store';
import { PlaylistsStore } from './playlists.store';
import {
  PlayerStore,
  QUEUE_SAVE_INTERVAL_MS,
  SessionRefusedError,
} from './player.store';
import { SessionStore } from './session.store';
import { toSessionTrack } from './session-track';

const queue: Track[] = [
  { id: 'fake:a', providerId: 'fake', title: 'A', artist: 'X' },
  { id: 'fake:b', providerId: 'fake', title: 'B', artist: 'Y' },
];

function manyTracks(count: number): Track[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `fake:${i}`,
    providerId: 'fake',
    title: `Title ${i}`,
    artist: 'Artist',
  }));
}

/** Just enough of `PlayerService`'s engine for `PlayerStore`. */
/** A Your Stack slot in the fake queue: its entry id and queue index. */
interface FakeSlot {
  entryId: string;
  index: number;
}

/**
 * Engine stand-in with real Your Stack semantics: stack entries sit physically
 * in the queue, after the cursor, and are tracked as slots. Spies wrap the
 * behaviour so tests can also assert the calls.
 */
function fakeEngine() {
  const queue = signal<readonly Track[]>([]);
  const currentIndex = signal(-1);
  const slots = signal<readonly FakeSlot[]>([]);
  const current = computed(() => queue()[currentIndex()] ?? null);
  const status = signal<PlayerStatus>('idle');
  const stackEntries = computed(() =>
    slots().map((slot) => ({
      entryId: slot.entryId,
      track: queue()[slot.index],
    })),
  );
  const upcomingEntries = computed(() =>
    queue()
      .slice(currentIndex() + 1)
      .map((track, i) => {
        const queueIndex = currentIndex() + 1 + i;
        return {
          track,
          queueIndex,
          stackEntryId: slots().find((s) => s.index === queueIndex)?.entryId ?? null,
        };
      }),
  );
  const keepSpinningEntries = computed(() =>
    upcomingEntries().filter((entry) => entry.stackEntryId === null),
  );
  const loadSeq = signal(0);
  let entrySeq = 0;
  const newEntryId = () => `fake-entry-${++entrySeq}`;
  const stackIndexes = () => slots().map((slot) => slot.index);
  /** Where a stack entry added to the end lands. */
  const stackTail = () =>
    currentIndex() < 0
      ? queue().length
      : Math.max(currentIndex(), ...stackIndexes()) + 1;

  /** Insert entries at `at`, shifting later queue entries and slots. */
  const insertStack = (at: number, entries: readonly StackEntry[]) => {
    const n = entries.length;
    const shift = (i: number) => (i >= at ? i + n : i);
    queue.update((q) => [
      ...q.slice(0, at),
      ...entries.map((e) => e.track),
      ...q.slice(at),
    ]);
    const shifted = slots().map((s) => ({ entryId: s.entryId, index: shift(s.index) }));
    const added = entries.map((e, k) => ({ entryId: e.entryId, index: at + k }));
    slots.set([...shifted, ...added].sort((a, b) => a.index - b.index));
  };

  /** Drop queue entries by index (never the cursor), renumbering the rest. */
  const removeIndices = (drop: ReadonlySet<number>): boolean => {
    if (!drop.size) return false;
    const before = (i: number) => [...drop].filter((d) => d < i).length;
    const cursor = currentIndex();
    queue.update((q) => q.filter((_, i) => !drop.has(i)));
    slots.update((s) =>
      s
        .filter((slot) => !drop.has(slot.index))
        .map((slot) => ({ entryId: slot.entryId, index: slot.index - before(slot.index) })),
    );
    if (cursor >= 0) currentIndex.set(cursor - before(cursor));
    return true;
  };

  return {
    queue,
    currentIndex,
    current,
    upcomingEntries,
    keepSpinningEntries,
    stackEntries,
    upcoming: computed(() => upcomingEntries().map((entry) => entry.track)),
    shuffle: signal(false),
    repeat: signal<RepeatMode>('off'),
    status,
    isPlaying: computed(() => status() === 'playing'),
    position: signal(0),
    duration: signal(0),
    error: signal<{ trackId: string; message: string } | null>(null),
    hasNext: computed(() => currentIndex() < queue().length - 1),
    hasPrevious: computed(() => currentIndex() > 0),
    volume: signal(1),
    muted: signal(false),
    canSetVolume: false,
    lastPlay: signal<{ seq: number; track: Track; at: number } | null>(null),
    loadSeq,
    setQueue: vi.fn(
      async (
        tracks: readonly Track[],
        opts?: { startIndex?: number; keepStack?: readonly StackEntry[] },
      ) => {
        queue.set([...tracks]);
        slots.set([]);
        currentIndex.set(opts?.startIndex ?? 0);
        if (opts?.keepStack?.length) insertStack(stackTail(), opts.keepStack);
        loadSeq.update((value) => value + 1);
      },
    ),
    setShuffle: vi.fn(),
    setRepeat: vi.fn(),
    toggleShuffle: vi.fn(),
    cycleRepeat: vi.fn(),
    add: vi.fn((tracks: readonly Track[]) => {
      queue.update((q) => [...q, ...tracks]);
    }),
    dropPlayed: vi.fn(),
    playNext: vi.fn((track: Track) => {
      insertStack(currentIndex() + 1, [{ entryId: newEntryId(), track }]);
    }),
    addToStack: vi.fn((track: Track) => {
      insertStack(stackTail(), [{ entryId: newEntryId(), track }]);
    }),
    removeStackEntry: vi.fn((entryId: string) => {
      const slot = slots().find((s) => s.entryId === entryId);
      return slot ? removeIndices(new Set([slot.index])) : false;
    }),
    clearStack: vi.fn(() => {
      removeIndices(new Set(stackIndexes()));
    }),
    clearKeepSpinning: vi.fn(() => {
      const stacked = new Set(stackIndexes());
      const drop = queue()
        .map((_, i) => i)
        .filter((i) => i > currentIndex() && !stacked.has(i));
      removeIndices(new Set(drop));
    }),
    setStack: vi.fn((entries: readonly StackEntry[]) => {
      removeIndices(new Set(stackIndexes()));
      if (entries.length) insertStack(stackTail(), entries);
    }),
    startStack: vi.fn(async () => {
      const first = slots()[0];
      if (currentIndex() >= 0 || !first) return false;
      currentIndex.set(first.index);
      slots.update((s) => s.slice(1));
      return true;
    }),
    removeTracks: vi.fn((ids: ReadonlySet<string>) => {
      const drop = new Set<number>();
      queue().forEach((t, i) => {
        if (i !== currentIndex() && ids.has(t.id)) drop.add(i);
      });
      return removeIndices(drop);
    }),
    removeUpcoming: vi.fn(() => true),
    replaceUpcoming: vi.fn((oldId: string, next: Track) => {
      const tracks = queue();
      if (!tracks.some((t) => t.id === oldId)) return false;
      queue.set(tracks.map((t) => (t.id === oldId ? next : t)));
      return true;
    }),
    playAt: vi.fn(async () => undefined),
    play: vi.fn(async () => undefined),
    pause: vi.fn(async () => undefined),
    togglePlay: vi.fn(async () => undefined),
    next: vi.fn(async () => true),
    previous: vi.fn(async () => undefined),
    seek: vi.fn(async () => undefined),
    clear: vi.fn(async () => undefined),
    setVolume: vi.fn(),
    setMuted: vi.fn(),
    toggleMute: vi.fn(),
    seekIfDrifted: vi.fn(async () => undefined),
    applyOrder: vi.fn(async () => ({ reloaded: false, moved: false })),
  };
}

/** Signals and spies for the parts of `SessionStore` the facade uses. */
function fakeSession() {
  return {
    available: signal(false),
    mirroring: signal(false),
    ownsPlayback: signal(false),
    isTarget: signal(false),
    remoteEntries: signal<readonly SessionEntry[]>([]),
    remoteTracks: signal<readonly Track[]>([]),
    remoteCurrent: signal<Track | null>(null),
    remoteCursor: signal(-1),
    currentEntryId: signal<string | undefined>(undefined),
    remotePlaying: signal(false),
    remoteStatus: signal<PlayerStatus>('idle'),
    remotePosition: signal(0),
    remoteDuration: signal(0),
    remoteShuffle: signal(false),
    remoteRepeat: signal<RepeatMode>('off'),
    remoteError: signal<string | null>(null),
    error: signal<string | null>(null),
    entryIdAt: vi.fn<(index: number) => string | undefined>(),
    removeAt: vi.fn(async (): Promise<CommandResult> => ({ ok: true })),
    replaceAt: vi.fn(async (): Promise<CommandResult> => ({ ok: true })),
    command: vi.fn<(command: SessionCommand) => Promise<CommandResult>>(
      async () => ({ ok: true }),
    ),
    startSession: vi.fn<
      (
        tracks: readonly Track[],
        startIndex: number,
        opts: { shuffle: boolean; repeat: RepeatMode; autoplay: boolean },
      ) => Promise<readonly string[] | null>
    >(async (tracks) => tracks.map((_, i) => `entry:${i}`)),
    report: vi.fn(),
    reportSeek: vi.fn(),
  };
}

type FakeSession = ReturnType<typeof fakeSession>;
type FakeEngine = ReturnType<typeof fakeEngine>;

function configure(
  engine: FakeEngine,
  session: FakeSession,
  storage = createInMemoryStorage(),
  library: Record<string, unknown> = {},
  counts: Record<string, unknown> = {},
) {
  TestBed.configureTestingModule({
    providers: [
      { provide: StoragePort, useValue: storage },
      { provide: PlayerService, useValue: { engine } },
      {
        provide: LibraryStore,
        useValue: {
          ready: async () => undefined,
          remember: vi.fn(),
          resolveIds: vi.fn(() => []),
          trackMap: signal<ReadonlyMap<string, Track>>(new Map()),
          ...library,
        },
      },
      { provide: PlaylistsStore, useValue: {} },
      {
        provide: PlayCountsStore,
        useValue: {
          recordPlay: vi.fn(async () => undefined),
          recordStart: vi.fn(async () => undefined),
          ...counts,
        },
      },
      { provide: SessionStore, useValue: session },
    ],
  });
}

describe('PlayerStore', () => {
  beforeEach(() => TestBed.resetTestingModule());
  afterEach(() => vi.useRealTimers());

  it('does not rewrite the queue on every position tick, and saves the exact position on pause', async () => {
    const engine = fakeEngine();
    const session = fakeSession();
    const storage = createInMemoryStorage();
    const save = vi.spyOn(storage.queueState, 'save');
    configure(engine, session, storage);
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
    const session = fakeSession();
    const recordPlay = vi.fn(async () => undefined);
    TestBed.configureTestingModule({
      providers: [
        { provide: StoragePort, useValue: createInMemoryStorage() },
        { provide: PlayerService, useValue: { engine } },
        {
          provide: LibraryStore,
          useValue: { ready: async () => undefined, remember: vi.fn() },
        },
        { provide: PlaylistsStore, useValue: {} },
        { provide: PlayCountsStore, useValue: { recordPlay, recordStart: vi.fn(async () => undefined) } },
        { provide: SessionStore, useValue: session },
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

  it('mirrors remote reads and sends transport commands without touching the engine', async () => {
    const engine = fakeEngine();
    const session = fakeSession();
    session.available.set(true);
    session.mirroring.set(true);
    session.ownsPlayback.set(true);
    session.remoteEntries.set([
      { entryId: 'e1', track: queue[0] },
      { entryId: 'e2', track: queue[1] },
    ]);
    session.remoteTracks.set(queue);
    session.remoteCurrent.set(queue[0]);
    session.remoteCursor.set(0);
    session.currentEntryId.set('e1');
    session.remotePlaying.set(true);
    session.remoteStatus.set('playing');
    session.remotePosition.set(30);
    session.remoteDuration.set(120);
    session.remoteShuffle.set(true);
    session.remoteRepeat.set('all');
    session.remoteError.set('Remote error');
    configure(engine, session);
    // The engine's local state must not leak into the facade.
    engine.queue.set([{ id: 'fake:local', providerId: 'fake', title: 'L', artist: 'X' }]);
    engine.currentIndex.set(0);
    engine.status.set('playing');
    engine.position.set(99);
    engine.duration.set(100);

    const player = TestBed.inject(PlayerStore);

    expect(player.queue()).toEqual(queue);
    expect(player.current()).toEqual(queue[0]);
    expect(player.currentIndex()).toBe(0);
    expect(player.currentEntryId()).toBe('e1');
    expect(player.isPlaying()).toBe(true);
    expect(player.status()).toBe('playing');
    expect(player.position()).toBe(30);
    expect(player.duration()).toBe(120);
    expect(player.progress()).toBe(0.25);
    expect(player.shuffle()).toBe(true);
    expect(player.repeat()).toBe('all');
    expect(player.error()).toEqual({
      trackId: '',
      code: 'unknown',
      message: 'Remote error',
    });
    expect(player.upcoming()).toEqual([queue[1]]);
    expect(player.upcomingEntries()).toEqual([
      { track: queue[1], queueIndex: 1, stackEntryId: null },
    ]);
    expect(player.hasNext()).toBe(true);
    expect(player.hasPrevious()).toBe(false);
    expect(player.isCurrent(queue[0].id)).toBe(true);
    expect(player.isCurrent('fake:local')).toBe(false);

    await player.pause();
    await player.togglePlay();
    expect(await player.next()).toBe(true);
    await player.previous();
    await player.seek(45);
    await player.seekBy(5);
    await player.playAt(1);

    expect(session.command.mock.calls.map(([command]) => command)).toEqual([
      { type: 'pause' },
      { type: 'toggle' },
      { type: 'next' },
      { type: 'previous' },
      { type: 'seek', positionSec: 45 },
      { type: 'seek', positionSec: 35 },
      { type: 'playIndex', index: 1 },
    ]);
    expect(engine.pause).not.toHaveBeenCalled();
    expect(engine.togglePlay).not.toHaveBeenCalled();
    expect(engine.next).not.toHaveBeenCalled();
    expect(engine.previous).not.toHaveBeenCalled();
    expect(engine.seek).not.toHaveBeenCalled();
    expect(engine.playAt).not.toHaveBeenCalled();
    expect(session.report).not.toHaveBeenCalled();

    // The remote status gates loading too.
    session.remoteStatus.set('loading');
    expect(player.isLoading()).toBe(true);
  });

  it('target transport calls the engine and reports, wrapping repeat-all via a command', async () => {
    const engine = fakeEngine();
    const session = fakeSession();
    session.available.set(true);
    session.isTarget.set(true);
    session.ownsPlayback.set(true);
    session.remoteRepeat.set('all');
    session.currentEntryId.set('e1');
    engine.queue.set(queue);
    engine.currentIndex.set(0);
    engine.status.set('playing');
    configure(engine, session);
    const player = TestBed.inject(PlayerStore);

    expect(player.queue()).toEqual(queue);
    expect(player.repeat()).toBe('all');
    expect(player.currentEntryId()).toBe('e1');

    engine.next.mockResolvedValueOnce(true);
    expect(await player.next()).toBe(true);
    expect(session.report).toHaveBeenCalledWith('native-skip');

    // No local next entry, but the server's repeat-all wraps.
    engine.next.mockResolvedValueOnce(false);
    expect(await player.next()).toBe(true);
    expect(session.command).toHaveBeenCalledWith({ type: 'next' });
    expect(session.report).toHaveBeenCalledTimes(1);

    await player.pause();
    expect(engine.pause).toHaveBeenCalledTimes(1);
    expect(session.report).toHaveBeenLastCalledWith('playing');

    await player.seek(12);
    expect(engine.seek).toHaveBeenCalledWith(12);
    expect(session.reportSeek).toHaveBeenCalledTimes(1);

    await player.playAt(1);
    expect(engine.playAt).toHaveBeenCalledWith(1);
    expect(session.report).toHaveBeenLastCalledWith('native-skip');
  });

  it('session shuffle play starts the session and never writes engine modes', async () => {
    const engine = fakeEngine();
    const session = fakeSession();
    session.available.set(true);
    const library = { remember: vi.fn() };
    configure(engine, session, createInMemoryStorage(), library);
    const player = TestBed.inject(PlayerStore);

    await player.playTracks(queue, 1, { shuffle: true, autoplay: false });

    // Shuffled builds start at the tapped track and keep the rest in the window.
    expect(library.remember).toHaveBeenCalledWith(queue);
    expect(session.startSession).toHaveBeenCalledWith(
      [queue[1], queue[0]],
      0,
      {
        shuffle: true,
        repeat: 'off',
        autoplay: false,
      },
    );
    expect(engine.setShuffle).not.toHaveBeenCalled();
    expect(engine.setQueue).not.toHaveBeenCalled();
  });

  it('falls back to local playback when starting the session fails', async () => {
    const engine = fakeEngine();
    const session = fakeSession();
    session.available.set(true);
    session.startSession.mockImplementation(async () => null);
    configure(engine, session);
    const player = TestBed.inject(PlayerStore);

    await player.playTracks(queue, 1, { shuffle: true, autoplay: false });

    expect(session.startSession).toHaveBeenCalled();
    expect(engine.setShuffle).toHaveBeenCalledWith(true);
    expect(engine.setQueue).toHaveBeenCalledWith([queue[1], queue[0]], {
      startIndex: 0,
      autoplay: false,
      history: 'before-start',
    });
    // The local queue is live rather than blocked by the failed session.
    expect(player.queue()).toEqual([queue[1], queue[0]]);
    expect(player.currentIndex()).toBe(0);
    expect(player.error()).toBeNull();
  });

  it('shows one human notice when the server refuses the queue', async () => {
    const engine = fakeEngine();
    const session = fakeSession();
    session.available.set(true);
    session.startSession.mockImplementation(async () => {
      session.error.set('queue-too-large');
      return null;
    });
    configure(engine, session);
    const player = TestBed.inject(PlayerStore);

    await player.playTracks(queue, 1, { shuffle: true, autoplay: false });

    // The queue still plays locally; the refusal is one readable notice.
    expect(engine.setQueue).toHaveBeenCalled();
    expect(player.error()).toEqual({
      trackId: '',
      code: 'unknown',
      message:
        'Playing on this device — the server could not start synced playback.',
    });
  });

  it('starts a bounded auto window, keeping 20 played entries behind the cursor', async () => {
    const engine = fakeEngine();
    const session = fakeSession();
    configure(engine, session);
    const player = TestBed.inject(PlayerStore);
    const tracks = manyTracks(200);

    await player.playTracks(tracks, 0);
    expect(engine.setQueue.mock.calls[0]?.[0]).toHaveLength(51);
    expect(engine.setQueue.mock.calls[0]?.[0]?.[0]?.id).toBe('fake:0');
    expect(engine.setQueue.mock.calls[0]?.[1]).toEqual({
      startIndex: 0,
      autoplay: true,
      history: 'before-start',
    });

    await player.playTracks(tracks, 30);
    const [windowed, opts] = engine.setQueue.mock.calls[1] ?? [];
    expect(windowed).toHaveLength(71);
    expect(windowed?.[0]?.id).toBe('fake:10');
    expect(windowed?.[20]?.id).toBe('fake:30');
    expect(opts).toEqual({
      startIndex: 20,
      autoplay: true,
      history: 'before-start',
    });
  });

  it('keeps 100 upcoming tracks for a playlist queue', async () => {
    const engine = fakeEngine();
    const session = fakeSession();
    configure(engine, session);
    const player = TestBed.inject(PlayerStore);

    await player.playTracks(manyTracks(200), 0, { queue: 'playlist' });

    expect(engine.setQueue.mock.calls[0]?.[0]).toHaveLength(101);
  });

  it('tops the local queue up from its window and drops old history', async () => {
    const engine = fakeEngine();
    const session = fakeSession();
    configure(engine, session);
    const player = TestBed.inject(PlayerStore);
    const tracks = manyTracks(200);
    await player.playTracks(tracks, 0);

    // The cursor reaches the end of the first chunk: 0 upcoming.
    engine.currentIndex.set(50);
    TestBed.tick();

    expect(engine.add).toHaveBeenCalledTimes(1);
    expect(
      engine.add.mock.calls[0]?.[0]?.map((track: Track) => track.id),
    ).toEqual(tracks.slice(51, 101).map((track) => track.id));
    expect(engine.dropPlayed).toHaveBeenCalledWith(20);
  });

  it('starts the session with the window and remembers the entry ids it created', async () => {
    const engine = fakeEngine();
    const session = fakeSession();
    session.available.set(true);
    const tracks = manyTracks(200);
    session.startSession.mockImplementation(async (built) =>
      built.map((_, i) => `entry:${i}`),
    );
    configure(engine, session);
    const player = TestBed.inject(PlayerStore);

    await player.playTracks(tracks, 0);
    const built = session.startSession.mock.calls[0]?.[0] ?? [];
    expect(built).toHaveLength(51);
    expect(session.startSession.mock.calls[0]?.[1]).toBe(0);
    expect(engine.setQueue).not.toHaveBeenCalled();

    // The session order still holds ids this client created, so the top-up
    // keeps the window and enqueues the next chunk.
    session.ownsPlayback.set(true);
    session.remoteEntries.set(
      built.map((track, i) => ({ entryId: `entry:${i}`, track })),
    );
    session.remoteCursor.set(10);
    TestBed.tick();

    const enqueue = session.command.mock.calls.find(
      ([command]) => command.type === 'enqueue',
    )?.[0];
    expect(enqueue?.type).toBe('enqueue');
    if (enqueue?.type !== 'enqueue') return;
    expect(enqueue.tracks).toHaveLength(10);
    expect(enqueue.next).toBe(false);
  });

  it('puts tracks back when the enqueue was refused, so the next top-up sends them', async () => {
    const engine = fakeEngine();
    const session = fakeSession();
    session.available.set(true);
    const tracks = manyTracks(200);
    session.startSession.mockImplementation(async (built) =>
      built.map((_, i) => `entry:${i}`),
    );
    configure(engine, session);
    const player = TestBed.inject(PlayerStore);
    const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
    const enqueues = () =>
      session.command.mock.calls
        .map(([command]) => command)
        .filter((command) => command.type === 'enqueue');

    await player.playTracks(tracks, 0);
    const built = session.startSession.mock.calls[0]?.[0] ?? [];
    session.ownsPlayback.set(true);
    session.remoteEntries.set(
      built.map((track, i) => ({ entryId: `entry:${i}`, track })),
    );
    session.remoteCursor.set(10);

    // The first enqueue never reaches the server: nothing was applied.
    session.command.mockResolvedValueOnce({ ok: false, error: 'offline' });
    TestBed.tick();
    await flush();
    const first = enqueues()[0];
    expect(first?.type === 'enqueue' && first.tracks).toHaveLength(10);

    // The next top-up re-sends the same tracks first, not the ones after them.
    session.remoteCursor.set(11);
    TestBed.tick();
    await flush();
    const second = enqueues()[1];
    if (first?.type !== 'enqueue' || second?.type !== 'enqueue') {
      throw new Error('expected two enqueue commands');
    }
    expect(second.tracks.slice(0, 10).map((t) => t.id)).toEqual(
      first.tracks.map((t) => t.id),
    );
  });

  it('ignores a superseded playTracks that finishes its engine load late', async () => {
    const engine = fakeEngine();
    const session = fakeSession();
    configure(engine, session);
    const player = TestBed.inject(PlayerStore);

    // The first load stalls until the test lets it finish.
    let finishFirst!: () => void;
    const firstLoad = new Promise<void>((resolve) => (finishFirst = resolve));
    engine.setQueue.mockImplementationOnce(async () => {
      await firstLoad;
    });

    const first = player.playTracks(queue, 0);
    const second = player.playTracks(manyTracks(120), 0);
    await second;
    finishFirst();
    await first;

    // The newer play's window (120 tracks, 51 built) must survive: the stale
    // play's 2-track window would leave nothing to top up.
    expect(player['queueSource']()?.window.remaining).toBe(69);
  });

  it('records a recently-played start once per load while playing, never while mirroring', async () => {
    const engine = fakeEngine();
    const session = fakeSession();
    const counts = { recordStart: vi.fn(async () => undefined) };
    configure(engine, session, createInMemoryStorage(), {}, counts);
    TestBed.inject(PlayerStore);
    engine.queue.set(queue);
    engine.currentIndex.set(0);

    engine.loadSeq.set(1);
    engine.status.set('loading');
    TestBed.tick();
    expect(counts.recordStart).not.toHaveBeenCalled();

    engine.status.set('playing');
    TestBed.tick();
    expect(counts.recordStart).toHaveBeenCalledTimes(1);
    expect(counts.recordStart).toHaveBeenCalledWith(queue[0]);

    // Pausing and resuming the same load is not a new start.
    engine.status.set('paused');
    TestBed.tick();
    engine.status.set('playing');
    TestBed.tick();
    expect(counts.recordStart).toHaveBeenCalledTimes(1);

    // A replay (new load) records again.
    engine.loadSeq.set(2);
    TestBed.tick();
    expect(counts.recordStart).toHaveBeenCalledTimes(2);

    // A mirrored load plays on another device, not here.
    session.mirroring.set(true);
    engine.loadSeq.set(3);
    TestBed.tick();
    expect(counts.recordStart).toHaveBeenCalledTimes(2);
  });

  it('restores the saved queue paused at its saved position', async () => {
    const engine = fakeEngine();
    const session = fakeSession();
    const storage = createInMemoryStorage();
    await storage.queueState.save({
      trackIds: queue.map((t) => t.id),
      index: 0,
      positionSec: 42,
      shuffle: false,
      repeat: 'off',
    });
    configure(engine, session, storage, { resolveIds: () => queue });
    engine.setQueue.mockImplementationOnce(async (tracks, opts) => {
      engine.queue.set([...tracks]);
      engine.currentIndex.set(opts?.startIndex ?? 0);
      engine.loadSeq.update((value) => value + 1);
      engine.status.set('paused');
    });
    const player = TestBed.inject(PlayerStore);

    await player.restore();

    expect(engine.queue()).toEqual(queue);
    expect(engine.currentIndex()).toBe(0);
    expect(engine.status()).toBe('paused');
    expect(engine.seek).toHaveBeenCalledWith(42);
  });

  it('does not seek a restored position over a play started during restore', async () => {
    const engine = fakeEngine();
    const session = fakeSession();
    const storage = createInMemoryStorage();
    await storage.queueState.save({
      trackIds: queue.map((t) => t.id),
      index: 0,
      positionSec: 42,
      shuffle: false,
      repeat: 'off',
    });
    configure(engine, session, storage, { resolveIds: () => queue });
    // The restore's own load plus a user load that landed while it resolved.
    engine.setQueue.mockImplementationOnce(async (tracks) => {
      engine.queue.set([...tracks]);
      engine.currentIndex.set(1);
      engine.loadSeq.update((value) => value + 2);
      engine.status.set('playing');
    });
    const player = TestBed.inject(PlayerStore);

    await player.restore();

    expect(engine.seek).not.toHaveBeenCalled();
  });

  it('does not save or flush the local queue while a session owns playback', async () => {
    const engine = fakeEngine();
    const session = fakeSession();
    session.ownsPlayback.set(true);
    const storage = createInMemoryStorage();
    const save = vi.spyOn(storage.queueState, 'save');
    configure(engine, session, storage);
    const player = TestBed.inject(PlayerStore);
    await player.restore();

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    engine.queue.set(queue);
    engine.currentIndex.set(0);
    engine.status.set('playing');
    TestBed.tick();
    await vi.advanceTimersByTimeAsync(QUEUE_SAVE_INTERVAL_MS);
    expect(save).not.toHaveBeenCalled();

    await player.flush();
    expect(save).not.toHaveBeenCalled();

    // Once the session ends, the local queue persists again.
    session.ownsPlayback.set(false);
    engine.status.set('paused');
    TestBed.tick();
    await vi.advanceTimersByTimeAsync(QUEUE_SAVE_INTERVAL_MS);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('removeUpcoming resolves the entry id and returns false when the queue moved', async () => {
    const engine = fakeEngine();
    const session = fakeSession();
    session.ownsPlayback.set(true);
    session.entryIdAt.mockReturnValueOnce('e5').mockReturnValue(undefined);
    configure(engine, session);
    const player = TestBed.inject(PlayerStore);

    expect(await player.removeUpcoming(2)).toBe(true);
    expect(session.removeAt).toHaveBeenCalledWith(2);
    expect(engine.removeUpcoming).not.toHaveBeenCalled();

    // Entry gone from the rendered order: no command, just false.
    expect(await player.removeUpcoming(2)).toBe(false);
    expect(session.removeAt).toHaveBeenCalledTimes(1);

    // The server also answers entry-not-found.
    session.entryIdAt.mockReturnValue('e6');
    session.removeAt.mockResolvedValueOnce({ ok: false, error: 'entry-not-found' });
    expect(await player.removeUpcoming(2)).toBe(false);

    // Local playback still removes by engine index.
    session.ownsPlayback.set(false);
    engine.removeUpcoming.mockReturnValue(true);
    expect(await player.removeUpcoming(2)).toBe(true);
    expect(engine.removeUpcoming).toHaveBeenCalledWith(2);
  });

  it('keeps duplicate queue entries distinct and highlights only the current index', () => {
    const engine = fakeEngine();
    const session = fakeSession();
    session.mirroring.set(true);
    session.ownsPlayback.set(true);
    session.remoteEntries.set([
      { entryId: 'e1', track: queue[0] },
      { entryId: 'e2', track: queue[0] },
    ]);
    session.remoteTracks.set([queue[0], queue[0]]);
    session.remoteCurrent.set(queue[0]);
    session.remoteCursor.set(0);
    session.currentEntryId.set('e1');
    configure(engine, session);
    const player = TestBed.inject(PlayerStore);

    expect(player.queue()).toHaveLength(2);
    expect(player.currentIndex()).toBe(0);
    expect(player.currentEntryId()).toBe('e1');
    expect(player.upcomingEntries()).toEqual([
      { track: queue[0], queueIndex: 1, stackEntryId: null },
    ]);
    // Library rows intentionally highlight every copy of the current track.
    expect(player.isCurrent(queue[0].id)).toBe(true);
  });

  it('replaceTrack restarts a replaced local current record when asked', async () => {
    const engine = fakeEngine();
    const session = fakeSession();
    configure(engine, session);
    const player = TestBed.inject(PlayerStore);
    const next: Track = { ...queue[0], id: 'fake:new', source: { site: 'test', url: '/new.mp3' } };
    engine.queue.set(queue);
    engine.currentIndex.set(0);
    engine.status.set('paused');

    expect(await player.replaceTrack(queue[0].id, next, { playCurrent: true })).toBe(true);

    expect(engine.setQueue).toHaveBeenCalledWith([next, queue[1]], {
      startIndex: 0,
      autoplay: true,
      history: 'before-start',
    });
    expect(session.command).not.toHaveBeenCalled();
  });

  it('replaceTrack swaps a replaced non-current local record in place and returns false', async () => {
    const engine = fakeEngine();
    const session = fakeSession();
    configure(engine, session);
    const player = TestBed.inject(PlayerStore);
    const next: Track = { ...queue[0], id: 'fake:new' };
    engine.queue.set(queue);
    engine.currentIndex.set(1);
    engine.status.set('paused');

    expect(
      await player.replaceTrack(queue[0].id, next, { playCurrent: true }),
    ).toBe(false);

    expect(engine.replaceUpcoming).toHaveBeenCalledWith(queue[0].id, next);
    expect(engine.setQueue).not.toHaveBeenCalled();
    // Only the upcoming entry changes; the current track keeps playing.
    expect(engine.queue()).toEqual([next, queue[1]]);
    expect(engine.currentIndex()).toBe(1);
  });

  it('replaceTrack replaces session entries by id, then starts the current entry on the target', async () => {
    const engine = fakeEngine();
    const session = fakeSession();
    session.ownsPlayback.set(true);
    session.isTarget.set(true);
    session.remoteEntries.set([
      { entryId: 'e1', track: queue[0] },
      { entryId: 'e2', track: queue[1] },
    ]);
    session.remoteCursor.set(0);
    session.currentEntryId.set('e1');
    configure(engine, session);
    const player = TestBed.inject(PlayerStore);
    const next: Track = { ...queue[0], id: 'fake:new', source: { site: 'test', url: '/new.mp3' } };

    expect(await player.replaceTrack(queue[0].id, next, { playCurrent: true })).toBe(true);

    expect(session.command.mock.calls.map(([command]) => command)).toEqual([
      { type: 'replace', entryId: 'e1', track: toSessionTrack(next, 'e1') },
      { type: 'playEntry', entryId: 'e1' },
    ]);
    expect(session.replaceAt).not.toHaveBeenCalled();
  });

  it('replaceTrack rejects and does not start playback when a session replace fails', async () => {
    const engine = fakeEngine();
    const session = fakeSession();
    session.ownsPlayback.set(true);
    session.isTarget.set(true);
    session.remoteEntries.set([{ entryId: 'e1', track: queue[0] }]);
    session.remoteCursor.set(0);
    session.currentEntryId.set('e1');
    session.command.mockResolvedValueOnce({ ok: false, error: 'entry-not-found' });
    configure(engine, session);
    const player = TestBed.inject(PlayerStore);

    await expect(
      player.replaceTrack(queue[0].id, { ...queue[0], id: 'fake:new' }, { playCurrent: true }),
    ).rejects.toThrow('Could not update the playback queue. Try again.');
    expect(session.command).toHaveBeenCalledTimes(1);
    expect(session.command).not.toHaveBeenCalledWith({ type: 'playEntry', entryId: 'e1' });
  });

  it('replaceTrack does not start playback while mirroring another target', async () => {
    const engine = fakeEngine();
    const session = fakeSession();
    session.ownsPlayback.set(true);
    session.mirroring.set(true);
    session.remoteEntries.set([{ entryId: 'e1', track: queue[0] }]);
    session.remoteCursor.set(0);
    session.currentEntryId.set('e1');
    configure(engine, session);
    const player = TestBed.inject(PlayerStore);

    expect(
      await player.replaceTrack(queue[0].id, { ...queue[0], id: 'fake:new' }, { playCurrent: true }),
    ).toBe(false);
    expect(session.command.mock.calls.map(([command]) => command)).toEqual([
      { type: 'replace', entryId: 'e1', track: toSessionTrack({ ...queue[0], id: 'fake:new' }, 'e1') },
    ]);
  });

  describe('Your Stack and Keep Spinning', () => {
    const stackTrack = (id: string): Track => ({
      id: `fake:${id}`,
      providerId: 'fake',
      title: id,
      artist: 'X',
    });
    const ids = (tracks: readonly Track[]) => tracks.map((t) => t.id);
    const stackIds = (player: PlayerStore) =>
      player.stackEntries().map((entry) => entry.track.id);

    it('playNext goes to the front of the stack and addToStack to its end', async () => {
      const engine = fakeEngine();
      configure(engine, fakeSession());
      const player = TestBed.inject(PlayerStore);
      await player.playTracks(manyTracks(3), 0);

      await player.addToStack(stackTrack('x'));
      await player.addToStack(stackTrack('y'));
      await player.playNext(stackTrack('z'));

      expect(stackIds(player)).toEqual(['fake:z', 'fake:x', 'fake:y']);
      expect(ids(player.upcoming())).toEqual([
        'fake:z',
        'fake:x',
        'fake:y',
        'fake:1',
        'fake:2',
      ]);
      expect(player.keepSpinningEntries().map((e) => e.track.id)).toEqual([
        'fake:1',
        'fake:2',
      ]);
    });

    it('starts playback when nothing is loaded instead of adding to an empty stack', async () => {
      const engine = fakeEngine();
      configure(engine, fakeSession());
      const player = TestBed.inject(PlayerStore);

      await player.playNext(stackTrack('x'));

      expect(engine.playNext).not.toHaveBeenCalled();
      expect(engine.setQueue).toHaveBeenCalledWith(
        [stackTrack('x')],
        expect.objectContaining({ startIndex: 0 }),
      );
    });

    it('a stack applied while idle is not an empty queue: adds start the stack', async () => {
      const engine = fakeEngine();
      configure(engine, fakeSession());
      const player = TestBed.inject(PlayerStore);
      engine.setStack([{ entryId: 'r1', track: stackTrack('r') }]);

      await player.addToStack(stackTrack('x'));

      expect(engine.setQueue).not.toHaveBeenCalled();
      expect(engine.startStack).toHaveBeenCalledTimes(1);
      expect(engine.currentIndex()).toBe(0);
      expect(stackIds(player)).toEqual(['fake:x']);
    });

    it('a new play keeps Your Stack; clearStack still empties it', async () => {
      const engine = fakeEngine();
      configure(engine, fakeSession());
      const player = TestBed.inject(PlayerStore);
      await player.playTracks(manyTracks(3), 0);
      await player.addToStack(stackTrack('x'));

      const fresh = Array.from({ length: 3 }, (_, i) => ({
        id: `new:${i}`,
        providerId: 'fake',
        title: `New ${i}`,
        artist: 'X',
      }));
      await player.playTracks(fresh, 0);

      expect(stackIds(player)).toEqual(['fake:x']);
      expect(ids(player.upcoming())).toEqual(['fake:x', 'new:1', 'new:2']);

      player.clearStack();
      expect(player.stackEntries()).toEqual([]);
      expect(ids(player.upcoming())).toEqual(['new:1', 'new:2']);
    });

    it('play next and add to stack enqueue on the session while it owns playback', async () => {
      const engine = fakeEngine();
      const session = fakeSession();
      session.ownsPlayback.set(true);
      configure(engine, session);
      const player = TestBed.inject(PlayerStore);

      expect(player.addGoesToQueue()).toBe(true);
      await player.playNext(stackTrack('x'));
      await player.addToStack(stackTrack('y'));

      const sent = session.command.mock.calls.map(([c]) => c);
      expect(sent).toEqual([
        {
          type: 'enqueue',
          tracks: [expect.objectContaining({ id: 'fake:x' })],
          next: true,
        },
        {
          type: 'enqueue',
          tracks: [expect.objectContaining({ id: 'fake:y' })],
          next: false,
        },
      ]);
      // Each session entry gets its own id, distinct from the other.
      const [first, second] = sent;
      if (first?.type !== 'enqueue' || second?.type !== 'enqueue') {
        throw new Error('expected two enqueue commands');
      }
      expect(first.tracks[0].entryId).not.toBe(second.tracks[0].entryId);

      // The session queue is separate: nothing reaches the local engine or stack.
      expect(engine.playNext).not.toHaveBeenCalled();
      expect(engine.addToStack).not.toHaveBeenCalled();
      expect(player.stackEntries()).toEqual([]);
    });

    it('a session-refused play next throws a short reason and changes nothing locally', async () => {
      const engine = fakeEngine();
      const session = fakeSession();
      session.ownsPlayback.set(true);
      session.command.mockResolvedValueOnce({ ok: false, error: 'queue-too-large' });
      configure(engine, session);
      const player = TestBed.inject(PlayerStore);

      await expect(player.playNext(stackTrack('x'))).rejects.toThrow(
        'the session queue is full',
      );
      await expect(player.addToStack(stackTrack('y'))).resolves.toBeUndefined();

      expect(engine.playNext).not.toHaveBeenCalled();
      expect(engine.addToStack).not.toHaveBeenCalled();
    });

    it('an unreachable session throws SessionRefusedError for the toast', async () => {
      const session = fakeSession();
      session.ownsPlayback.set(true);
      session.command.mockResolvedValueOnce({ ok: false, error: 'unavailable' });
      configure(fakeEngine(), session);
      const player = TestBed.inject(PlayerStore);

      await expect(player.addToStack(stackTrack('x'))).rejects.toBeInstanceOf(
        SessionRefusedError,
      );
    });

    it('stack removal and clearing stay no-ops while a session owns playback', async () => {
      const engine = fakeEngine();
      const session = fakeSession();
      configure(engine, session);
      const player = TestBed.inject(PlayerStore);
      await player.playTracks(manyTracks(3), 0);
      await player.addToStack(stackTrack('x'));
      const entryId = player.stackEntries()[0].entryId;

      session.ownsPlayback.set(true);
      player.clearStack();
      expect(player.removeStackEntry(entryId)).toBe(false);
      expect(engine.clearStack).not.toHaveBeenCalled();
      expect(engine.removeStackEntry).not.toHaveBeenCalled();
    });

    it('keeps duplicates, including the song that is playing, as separate entries', async () => {
      const engine = fakeEngine();
      configure(engine, fakeSession());
      const player = TestBed.inject(PlayerStore);
      await player.playTracks(manyTracks(2), 0);
      const playing = engine.current();
      if (!playing) throw new Error('expected a current track');

      await player.addToStack(playing);
      await player.addToStack(playing);

      const [first, second] = player.stackEntries();
      expect(stackIds(player)).toEqual(['fake:0', 'fake:0']);
      expect(first.entryId).not.toBe(second.entryId);
      expect(player.current()?.id).toBe('fake:0');
    });

    it('clearStack empties Your Stack and leaves Keep Spinning alone', async () => {
      const engine = fakeEngine();
      configure(engine, fakeSession());
      const player = TestBed.inject(PlayerStore);
      await player.playTracks(manyTracks(4), 0);
      await player.playNext(stackTrack('x'));
      await player.addToStack(stackTrack('y'));

      player.clearStack();

      expect(player.stackEntries()).toEqual([]);
      expect(ids(player.upcoming())).toEqual(['fake:1', 'fake:2', 'fake:3']);
    });

    it('clearKeepSpinning empties the window and stops the refill', async () => {
      const engine = fakeEngine();
      configure(engine, fakeSession());
      const player = TestBed.inject(PlayerStore);
      await player.playTracks(manyTracks(60), 0);
      await player.addToStack(stackTrack('x'));

      await player.clearKeepSpinning();
      expect(player.keepSpinningEntries()).toEqual([]);
      expect(stackIds(player)).toEqual(['fake:x']);

      // The cursor advances, but no top-up runs: the window is gone for good.
      engine.add.mockClear();
      engine.currentIndex.set(1);
      TestBed.tick();
      await Promise.resolve();
      expect(engine.add).not.toHaveBeenCalled();
    });

    it('a new play action after clearKeepSpinning re-enables autoplay', async () => {
      const engine = fakeEngine();
      configure(engine, fakeSession());
      const player = TestBed.inject(PlayerStore);
      await player.playTracks(manyTracks(60), 0);
      await player.clearKeepSpinning();

      // Fresh ids, so nothing is held back by the 12h dedupe.
      const fresh = Array.from({ length: 60 }, (_, i) => ({
        id: `new:${i}`,
        providerId: 'fake',
        title: `New ${i}`,
        artist: 'X',
      }));
      await player.playTracks(fresh, 0);
      engine.add.mockClear();
      engine.currentIndex.set(50);
      TestBed.tick();

      expect(engine.add).toHaveBeenCalledTimes(1);
      expect(ids(engine.add.mock.calls[0]?.[0] ?? [])).toEqual(
        Array.from({ length: 9 }, (_, i) => `new:${51 + i}`),
      );
    });

    it('saves Your Stack with entry ids and tracks, outside trackIds', async () => {
      const engine = fakeEngine();
      const storage = createInMemoryStorage();
      configure(engine, fakeSession(), storage);
      const player = TestBed.inject(PlayerStore);
      await player.restore();
      await player.playTracks(manyTracks(3), 0);
      await player.playNext(stackTrack('x'));
      const entryId = player.stackEntries()[0].entryId;

      await player.flush();

      const saved = await storage.queueState.get();
      expect(saved?.trackIds).toEqual(['fake:0', 'fake:1', 'fake:2']);
      expect(saved?.stack).toEqual([{ entryId, track: stackTrack('x') }]);
    });

    it('restores Your Stack with its saved entry ids', async () => {
      const storage = createInMemoryStorage();
      const byId = new Map(
        [...manyTracks(3), stackTrack('x')].map((t) => [t.id, t]),
      );
      const resolveIds = (list: readonly string[]) =>
        list.flatMap((id) => (byId.get(id) ? [byId.get(id) as Track] : []));
      await storage.queueState.save({
        trackIds: ['fake:0', 'fake:1', 'fake:2'],
        index: 0,
        positionSec: 0,
        shuffle: false,
        repeat: 'off',
        stack: [{ entryId: 'saved-entry', track: stackTrack('x') }],
      });
      const engine = fakeEngine();
      configure(engine, fakeSession(), storage, { resolveIds });
      const player = TestBed.inject(PlayerStore);

      await player.restore();

      expect(player.stackEntries()).toEqual([
        { entryId: 'saved-entry', track: stackTrack('x') },
      ]);
      expect(ids(player.upcoming())).toEqual(['fake:x', 'fake:1', 'fake:2']);
    });

    it('migrates a legacy playNextIds save into Your Stack under new entry ids', async () => {
      const storage = createInMemoryStorage();
      const byId = new Map(
        [...manyTracks(3), stackTrack('x')].map((t) => [t.id, t]),
      );
      await storage.queueState.save({
        trackIds: ['fake:0', 'fake:x', 'fake:1', 'fake:2'],
        index: 0,
        positionSec: 0,
        shuffle: false,
        repeat: 'off',
        playNextIds: ['fake:x'],
      });
      const engine = fakeEngine();
      configure(engine, fakeSession(), storage, {
        resolveIds: (list: readonly string[]) =>
          list.flatMap((id) => (byId.get(id) ? [byId.get(id) as Track] : [])),
      });
      const player = TestBed.inject(PlayerStore);

      await player.restore();

      const [entry] = player.stackEntries();
      expect(player.stackEntries()).toHaveLength(1);
      expect(entry.track.id).toBe('fake:x');
      expect(entry.entryId).toEqual(expect.any(String));
      expect(ids(player.upcoming())).toEqual(['fake:x', 'fake:1', 'fake:2']);
    });

    describe('12h autoplay dedupe', () => {
      const day = 12 * 60 * 60 * 1000;

      afterEach(() => vi.useRealTimers());

      it('shuffle off: replaying the same list queues the next songs in list order', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
        const engine = fakeEngine();
        configure(engine, fakeSession());
        const player = TestBed.inject(PlayerStore);
        const tracks = manyTracks(60);
        await player.playTracks(tracks, 0);
        await player.playTracks(tracks, 0);

        // The replay starts at the top again, in list order.
        expect(ids(engine.setQueue.mock.calls.at(-1)?.[0] ?? [])).toEqual(
          ids(tracks.slice(0, 51)),
        );

        // Draining the queue refills with the next songs, not a random draw.
        engine.add.mockClear();
        engine.currentIndex.set(50);
        TestBed.tick();
        expect(ids(engine.add.mock.calls.flatMap(([t]) => t))).toEqual(
          ids(tracks.slice(51)),
        );
      });

      it('shuffle on: skips songs queued within 12h on a fresh autoplay fill, then allows them after', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
        const engine = fakeEngine();
        configure(engine, fakeSession());
        const player = TestBed.inject(PlayerStore);
        await player.playTracks(manyTracks(60), 0);
        // fake:0..fake:50 entered the first window.

        // Shuffled: the tapped track plus the only eligible songs, 51..59.
        engine.shuffle.set(true);
        await player.playTracks(manyTracks(60), 0);
        const second = ids(engine.setQueue.mock.calls.at(-1)?.[0] ?? []);
        expect(second[0]).toBe('fake:0');
        expect(second.slice(1).sort()).toEqual(
          Array.from({ length: 9 }, (_, i) => `fake:${51 + i}`),
        );

        // After 12h the recently queued songs are eligible again.
        vi.setSystemTime(new Date(Date.parse('2026-01-01T00:00:00Z') + day + 60_000));
        await player.playTracks(manyTracks(60), 0);
        const third = ids(engine.setQueue.mock.calls.at(-1)?.[0] ?? []);
        // 50 of the 59 others are drawn, so at least 41 come from fake:1..50.
        expect(
          third.filter((id) => Number(id.slice(5)) >= 1 && Number(id.slice(5)) <= 50)
            .length,
        ).toBeGreaterThan(0);
      });

      it('shuffle toggled off mid-window restores list order without filtering', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
        const engine = fakeEngine();
        configure(engine, fakeSession());
        const player = TestBed.inject(PlayerStore);
        const tracks = manyTracks(60);
        await player.playTracks(tracks, 0);

        engine.shuffle.set(true);
        await player.playTracks(tracks, 0);
        // The shuffled draw left fake:1..50 in the pool (all recently queued).
        engine.toggleShuffle.mockImplementationOnce(() => engine.shuffle.set(false));
        await player.toggleShuffle();

        engine.add.mockClear();
        engine.currentIndex.set(1);
        TestBed.tick();
        // Ahead of cursor 1 there are 8 queued; 42 more come in list order.
        expect(ids(engine.add.mock.calls.flatMap(([t]) => t))).toEqual(
          ids(tracks.slice(1, 43)),
        );
      });

      it('bypasses the dedupe when repeat is all', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
        const engine = fakeEngine();
        configure(engine, fakeSession());
        const player = TestBed.inject(PlayerStore);
        await player.playTracks(manyTracks(60), 0);

        engine.shuffle.set(true);
        engine.repeat.set('all');
        await player.playTracks(manyTracks(60), 0);

        const queued = ids(engine.setQueue.mock.calls.at(-1)?.[0] ?? []);
        expect(queued).toHaveLength(51);
        // Recently queued songs are drawn again under repeat-all.
        expect(
          queued.filter((id) => Number(id.slice(5)) >= 1 && Number(id.slice(5)) <= 50)
            .length,
        ).toBeGreaterThan(0);
      });

      it('stops strictly when nothing eligible is left, with no fallback draw', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
        const engine = fakeEngine();
        configure(engine, fakeSession());
        const player = TestBed.inject(PlayerStore);
        // fake:0..fake:50 are queued now, so they count as recently queued.
        await player.playTracks(manyTracks(51), 0);

        // Shuffled: the next play queues fake:0 and fake:51..59. The pool it
        // leaves is fake:1..50, all recently queued, so the window adds nothing.
        engine.shuffle.set(true);
        await player.playTracks(manyTracks(60), 0);
        engine.add.mockClear();
        engine.currentIndex.set(9);
        TestBed.tick();

        expect(engine.add).not.toHaveBeenCalled();
      });
    });
  });
});
