import { computed, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type {
  CommandResult,
  SessionCommand,
  SessionEntry,
  Track,
} from '@open-record/models';
import { PlayerService } from '@open-record/player';
import type { PlayerStatus, RepeatMode } from '@open-record/player';
import { StoragePort, createInMemoryStorage } from '@open-record/storage';
import { LibraryStore } from './library.store';
import { PlayCountsStore } from './play-counts.store';
import { PlaylistsStore } from './playlists.store';
import { PlayerStore, QUEUE_SAVE_INTERVAL_MS } from './player.store';
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
function fakeEngine() {
  const queue = signal<readonly Track[]>([]);
  const currentIndex = signal(-1);
  const current = computed(() => queue()[currentIndex()] ?? null);
  const status = signal<PlayerStatus>('idle');
  const playNextIndices = signal<readonly number[]>([]);
  const upcomingEntries = computed(() =>
    queue()
      .slice(currentIndex() + 1)
      .map((track, i) => ({
        track,
        queueIndex: currentIndex() + 1 + i,
        playNext: false,
      })),
  );
  return {
    queue,
    currentIndex,
    current,
    upcomingEntries,
    upcoming: computed(() => upcomingEntries().map((entry) => entry.track)),
    playNextIndices,
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
    loadSeq: signal(0),
    setQueue: vi.fn(async (tracks: readonly Track[], opts?: { startIndex?: number }) => {
      queue.set([...tracks]);
      currentIndex.set(opts?.startIndex ?? 0);
    }),
    setShuffle: vi.fn(),
    setRepeat: vi.fn(),
    toggleShuffle: vi.fn(),
    cycleRepeat: vi.fn(),
    add: vi.fn(),
    dropPlayed: vi.fn(),
    playNext: vi.fn(),
    removeUpcoming: vi.fn(() => true),
    markPlayNext: vi.fn(),
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
      { track: queue[1], queueIndex: 1, playNext: false },
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
    expect(session.report).toHaveBeenLastCalledWith('tick');

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
    session.startSession.mockImplementation(async () => {
      session.error.set('Sessions are not available.');
      return null;
    });
    configure(engine, session);
    const player = TestBed.inject(PlayerStore);

    await player.playTracks(queue, 1, { shuffle: true, autoplay: false });

    expect(session.startSession).toHaveBeenCalled();
    expect(engine.setShuffle).toHaveBeenCalledWith(true);
    expect(engine.setQueue).toHaveBeenCalledWith([queue[1], queue[0]], {
      startIndex: 0,
      autoplay: false,
    });
    // The local queue is live rather than blocked by the failed session.
    expect(player.queue()).toEqual([queue[1], queue[0]]);
    expect(player.currentIndex()).toBe(0);
    expect(player.error()).toEqual({
      trackId: '',
      code: 'unknown',
      message: 'Playing on this device only — Sessions are not available.',
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
    });

    await player.playTracks(tracks, 30);
    const [windowed, opts] = engine.setQueue.mock.calls[1] ?? [];
    expect(windowed).toHaveLength(71);
    expect(windowed?.[0]?.id).toBe('fake:10');
    expect(windowed?.[20]?.id).toBe('fake:30');
    expect(opts).toEqual({ startIndex: 20, autoplay: true });
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
      { track: queue[0], queueIndex: 1, playNext: false },
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
    });
    expect(session.command).not.toHaveBeenCalled();
  });

  it('replaceTrack leaves a replaced non-current local record paused and returns false', async () => {
    const engine = fakeEngine();
    const session = fakeSession();
    configure(engine, session);
    const player = TestBed.inject(PlayerStore);
    const next: Track = { ...queue[0], id: 'fake:new' };
    engine.queue.set(queue);
    engine.currentIndex.set(1);
    engine.status.set('paused');

    expect(await player.replaceTrack(queue[0].id, next, { playCurrent: true })).toBe(false);

    expect(engine.setQueue).toHaveBeenCalledWith([next, queue[1]], {
      startIndex: 1,
      autoplay: false,
    });
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
});
