import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type SessionDevice,
  type SessionReportMessage,
  type SessionState,
  type SessionTrack,
} from '@open-record/models';
import type { ServerConfig } from '../config';
import type { CastDiscovery, DiscoveredCast } from './cast-discovery';
import type { CastStatus, CastTransport } from './cast-transport';
import { MediaRelay } from './media-relay';
import { CastBusyError, type SessionService } from './session';
import { CAST_LOST_GRACE_MS, CastService } from './cast';

const START = Date.parse('2026-01-01T00:00:00Z');
const BASE_URL = 'http://192.168.1.20:8787';

/** Temp dirs created by harnesses; removed after the suite. */
const tempDirs: string[] = [];

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

let now = START;

beforeEach(() => {
  now = START;
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

class FakeDiscovery {
  casts: DiscoveredCast[] = [
    { castId: 'cast-1', name: 'Kitchen', host: '10.0.0.5', port: 8009, model: 'Nest Mini' },
  ];

  list(): readonly DiscoveredCast[] {
    return this.casts;
  }
}

interface FakeLoad {
  url: string;
  title: string;
  contentType: string;
  startSec: number;
  autoplay: boolean;
}

class FakeTransport implements CastTransport {
  readonly calls: string[] = [];
  readonly loads: FakeLoad[] = [];
  readonly volumeCalls: number[] = [];
  connected: { host: string; port: number } | null = null;
  closed = false;
  current: CastStatus | null = { playing: false, positionSec: 0, volume: 1 };

  private readonly statusListeners = new Set<(status: CastStatus) => void>();
  private readonly disconnectListeners = new Set<() => void>();

  async getStatus(): Promise<CastStatus | null> {
    return this.current ? { ...this.current } : null;
  }

  async connect(host: string, port: number): Promise<void> {
    this.calls.push('connect');
    this.connected = { host, port };
    this.current = { playing: false, positionSec: 0, volume: 1 };
  }

  async load(
    media: Parameters<CastTransport['load']>[0],
    opts: Parameters<CastTransport['load']>[1],
  ): Promise<void> {
    this.calls.push('load');
    this.loads.push({
      url: media.url,
      title: media.title,
      contentType: media.contentType,
      startSec: opts.startSec ?? 0,
      autoplay: opts.autoplay,
    });
    this.current = {
      playing: opts.autoplay,
      positionSec: opts.startSec ?? 0,
      volume: this.current?.volume ?? 1,
    };
  }

  async play(): Promise<void> {
    this.calls.push('play');
    if (this.current) this.current = { ...this.current, playing: true };
  }

  async pause(): Promise<void> {
    this.calls.push('pause');
    if (this.current) this.current = { ...this.current, playing: false };
  }

  async stop(): Promise<void> {
    this.calls.push('stop');
    if (this.current) this.current = { ...this.current, playing: false, idle: true };
  }

  async seek(sec: number): Promise<void> {
    this.calls.push(`seek:${sec}`);
  }

  async setVolume(level: number): Promise<void> {
    this.calls.push(`volume:${level}`);
    this.volumeCalls.push(level);
    if (this.current) this.current = { ...this.current, volume: level };
  }

  status(): CastStatus | null {
    return this.current ? { ...this.current } : null;
  }

  onStatus(listener: (status: CastStatus) => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  onDisconnect(listener: () => void): () => void {
    this.disconnectListeners.add(listener);
    return () => this.disconnectListeners.delete(listener);
  }

  async close(): Promise<void> {
    this.calls.push('close');
    this.closed = true;
  }

  /** Test seam: deliver a receiver status event. */
  emitStatus(status: CastStatus): void {
    this.current = { ...status };
    for (const listener of [...this.statusListeners]) listener({ ...status });
  }

  /** Test seam: drop the socket. */
  emitDisconnect(): void {
    for (const listener of [...this.disconnectListeners]) listener();
  }
}

interface CallLog {
  unavailable: { userId: string; entryIds: string[] }[];
  reports: { userId: string; castId: string; report: SessionReportMessage }[];
  ended: { userId: string; castId: string }[];
  lost: { userId: string; castId: string }[];
}

interface Harness {
  service: CastService;
  relay: MediaRelay;
  transport: FakeTransport;
  sessions: {
    setUnavailable(userId: string, entryIds: readonly string[]): void;
    report(userId: string, castId: string, report: SessionReportMessage): void;
    castEnded(userId: string, castId: string): Promise<void>;
    castLost(userId: string, castId: string): void;
    snapshot(userId: string): SessionState | null;
  };
  calls: CallLog;
  state(): SessionState;
  setState(next: SessionState): void;
  advanceRelay(ms: number): void;
}

interface HarnessOptions {
  queue?: SessionTrack[];
  cursor?: number;
  playing?: boolean;
  repeat?: SessionState['repeat'];
  positionSec?: number;
  castEnabled?: boolean;
  castMediaBaseUrl?: string | null;
}

/** Mirrors `SessionService.castEnded`'s advance rules and its `onControl('play')`. */
function advance(state: SessionState): SessionState {
  const current = state.order[state.cursor];
  if (!current) return state;
  if (state.repeat === 'one') {
    return { ...state, positionSec: 0, playing: true, revision: state.revision + 1 };
  }
  if (state.cursor + 1 < state.order.length) {
    return { ...state, cursor: state.cursor + 1, positionSec: 0, playing: true, revision: state.revision + 1 };
  }
  if (state.repeat === 'all') {
    return { ...state, cursor: 0, positionSec: 0, playing: true, revision: state.revision + 1 };
  }
  return { ...state, positionSec: current.durationSec ?? 0, playing: false, revision: state.revision + 1 };
}

function createHarness(opts: HarnessOptions = {}): Harness {
  const dataDir = mkdtempSync(join(tmpdir(), 'cast-spec-'));
  tempDirs.push(dataDir);
  let relayNow = START;
  const relay = new MediaRelay({
    secret: randomBytes(32),
    dataDir,
    baseUrl: BASE_URL,
    ttlMs: 60_000,
    now: () => relayNow,
    pruneMs: 0,
  });

  const discovery = new FakeDiscovery();
  const transports: FakeTransport[] = [];
  const calls: CallLog = { unavailable: [], reports: [], ended: [], lost: [] };
  let state = makeState({
    order: opts.queue ?? [],
    cursor: opts.cursor ?? ((opts.queue?.length ?? 0) > 0 ? 0 : -1),
    playing: opts.playing ?? true,
    repeat: opts.repeat ?? 'off',
    positionSec: opts.positionSec ?? 0,
  });

  const config = {
    castEnabled: opts.castEnabled ?? true,
    castMediaBaseUrl: opts.castMediaBaseUrl === undefined ? BASE_URL : opts.castMediaBaseUrl,
    webDir: null,
  } as unknown as ServerConfig;

  const cast = new CastService({
    relay,
    discovery: discovery as unknown as CastDiscovery,
    config,
    transportFactory: () => {
      const transport = new FakeTransport();
      transports.push(transport);
      return transport;
    },
    now: () => now,
  });

  const sessions = {
    setUnavailable(userId: string, entryIds: readonly string[]): void {
      calls.unavailable.push({ userId, entryIds: [...entryIds] });
      state = { ...state, unavailable: entryIds.length > 0 ? [...entryIds] : undefined };
    },
    report(userId: string, castId: string, report: SessionReportMessage): void {
      calls.reports.push({ userId, castId, report });
      if (report.reason === 'playing') {
        state = { ...state, playing: report.playing, positionSec: report.positionSec, updatedAt: now };
      } else if (report.reason === 'tick') {
        state = { ...state, positionSec: report.positionSec, updatedAt: now };
      }
    },
    async castEnded(userId: string, castId: string): Promise<void> {
      calls.ended.push({ userId, castId });
      state = advance(state);
      await cast.control(userId, castId, { type: 'play' });
    },
    castLost(userId: string, castId: string): void {
      calls.lost.push({ userId, castId });
    },
    snapshot(): SessionState {
      return state;
    },
  };
  cast.setSession(sessions as unknown as SessionService);

  return {
    service: cast,
    relay,
    get transport(): FakeTransport {
      const transport = transports[transports.length - 1];
      if (!transport) throw new Error('no transport created');
      return transport;
    },
    sessions,
    calls,
    state: () => state,
    setState: (next) => {
      state = next;
    },
    advanceRelay: (ms) => {
      relayNow += ms;
    },
  };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
function remoteTrack(entryId: string, overrides: Partial<SessionTrack> = {}): SessionTrack {
  return {
    entryId,
    id: `remote:${entryId}`,
    providerId: 'remote',
    title: `Track ${entryId}`,
    artist: 'Artist',
    durationSec: 120,
    // A literal public IP: `planFor` validates it without DNS and never fetches it.
    source: { site: 'youtube', url: `https://8.8.8.8/${entryId}.m4a` },
    ...overrides,
  };
}

function requester(deviceId = 'dev-1', name = 'Phone 1'): SessionDevice {
  return {
    id: `client-${deviceId}`,
    deviceId,
    name,
    platform: 'web',
    online: true,
    lastSeenAt: now,
    capabilities: { cast: false, localFiles: false },
  };
}

function makeState(overrides: Partial<SessionState> = {}): SessionState {
  return {
    order: [],
    cursor: -1,
    playing: false,
    shuffle: false,
    repeat: 'off',
    target: { kind: 'cast', castId: 'cast-1' },
    revision: 1,
    positionSec: 0,
    updatedAt: now,
    updatedBy: null,
    ...overrides,
  };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

async function castTo(h: Harness, castId = 'cast-1'): Promise<void> {
  await h.service.setTarget('u1', requester(), null, { castId, state: h.state() });
}

// ---------------------------------------------------------------------------
// setTarget
// ---------------------------------------------------------------------------

describe('cast setTarget', () => {
  it('plans the queue, loads the current entry through the relay and marks unplayable rows', async () => {
    const h = createHarness({
      queue: [remoteTrack('a'), remoteTrack('b'), remoteTrack('c', { uploadId: 'upload-1' })],
      cursor: 0,
      playing: true,
    });

    await castTo(h);

    const transport = h.transport;
    expect(transport.connected).toEqual({ host: '10.0.0.5', port: 8009 });
    expect(transport.loads).toHaveLength(1);
    const loaded = transport.loads[0];
    expect(loaded?.title).toBe('Track a');
    expect(loaded?.startSec).toBe(0);
    expect(loaded?.autoplay).toBe(true);
    expect(loaded?.contentType).toBe('audio/mp4');
    expect(loaded?.url.startsWith(`${BASE_URL}/cast/relay/`)).toBe(true);

    const token = loaded?.url.slice(`${BASE_URL}/cast/relay/`.length) ?? '';
    expect(h.relay.verify(token)).toMatchObject({ userId: 'u1', trackId: 'remote:a' });

    // The unavailable list is written on the clone; setUnavailable is not called
    // during a transfer (SessionService has not committed the clone yet).
    expect(h.state().unavailable).toEqual(['c']);
    expect(h.calls.unavailable).toEqual([]);
  });

  it('applies the carried cast volume and stores the receiver-reported volume', async () => {
    const h = createHarness({ queue: [remoteTrack('a')], cursor: 0, playing: true });
    h.setState({ ...h.state(), castVolume: 0.35 });

    await castTo(h);

    expect(h.transport.volumeCalls).toEqual([0.35]);
    expect(h.state().castVolume).toBe(0.35);
  });

  it('rejects another user until force stops the owner and reports the loss', async () => {
    const h = createHarness({ queue: [remoteTrack('a'), remoteTrack('b')], cursor: 0, playing: true });
    await castTo(h);
    const first = h.transport;

    const busyState = makeState({ order: [remoteTrack('a')], cursor: 0, playing: true });
    h.setState(busyState);
    await expect(
      h.service.setTarget('u2', requester('dev-2', 'Phone 2'), 'cast-1', {
        castId: 'cast-1',
        state: busyState,
      }),
    ).rejects.toBeInstanceOf(CastBusyError);

    const lost: [string, string][] = [];
    h.service.setOnLost((userId, castId) => lost.push([userId, castId]));
    h.setState(makeState({ order: [remoteTrack('a')], cursor: 0, playing: true }));
    await h.service.setTarget(
      'u2',
      requester('dev-2', 'Phone 2'),
      'cast-1',
      { castId: 'cast-1', state: h.state() },
      { force: true },
    );

    expect(lost).toEqual([['u1', 'cast-1']]);
    expect(first.calls).toContain('stop');
    expect(first.closed).toBe(true);
    const second = h.transport;
    expect(second).not.toBe(first);
    expect(second.loads).toHaveLength(1);
  });

  it('stops and releases the cast on setTarget(null) for its owner only', async () => {
    const h = createHarness({ queue: [remoteTrack('a')], cursor: 0, playing: true });
    await castTo(h);
    const transport = h.transport;

    // A different user cannot release this speaker.
    await h.service.setTarget('u2', requester('dev-2'), 'cast-1', null);
    expect(transport.closed).toBe(false);

    await h.service.setTarget('u1', requester(), 'cast-1', null);
    expect(transport.calls).toContain('stop');
    expect(transport.closed).toBe(true);
  });

  it('throws unavailable when the current entry cannot be played', async () => {
    const h = createHarness({
      queue: [remoteTrack('a', { local: true })],
      cursor: 0,
      playing: true,
    });
    await expect(castTo(h)).rejects.toThrow('unavailable');
    expect(h.calls.unavailable).toEqual([]);
  });

  it('reflects discovery rows and stays empty when cast is disabled', () => {
    const enabled = createHarness();
    expect(enabled.service.devices()).toEqual([
      {
        id: 'cast-1',
        deviceId: 'cast-1',
        name: 'Kitchen',
        platform: 'cast',
        online: true,
        lastSeenAt: START,
        castId: 'cast-1',
        model: 'Nest Mini',
        capabilities: { cast: true, localFiles: false },
      },
    ]);

    const disabled = createHarness({ castEnabled: false });
    expect(disabled.service.devices()).toEqual([]);
  });

  it('requires a cast media base URL', () => {
    expect(() => createHarness({ castMediaBaseUrl: null })).toThrow('CAST_MEDIA_BASE_URL');
  });
});

// ---------------------------------------------------------------------------
// control
// ---------------------------------------------------------------------------

describe('cast control', () => {
  it('maps play, pause, seek, next, previous and volume to the transport', async () => {
    const h = createHarness({
      queue: [remoteTrack('a'), remoteTrack('b')],
      cursor: 0,
      playing: true,
    });
    await castTo(h);
    const transport = h.transport;

    h.setState({ ...h.state(), playing: false });
    await h.service.control('u1', 'cast-1', { type: 'pause' });
    expect(transport.calls).toContain('pause');

    h.setState({ ...h.state(), playing: true });
    await h.service.control('u1', 'cast-1', { type: 'play' });
    expect(transport.calls).toContain('play');

    await h.service.control('u1', 'cast-1', { type: 'seek', positionSec: 42 });
    expect(transport.calls).toContain('seek:42');

    await h.service.control('u1', 'cast-1', { type: 'setCastVolume', volume: 0.25 });
    expect(transport.volumeCalls).toContain(0.25);

    // SessionService moves the cursor before forwarding next/previous.
    h.setState({ ...h.state(), cursor: 1, positionSec: 0 });
    await h.service.control('u1', 'cast-1', { type: 'next' });
    expect(transport.loads.at(-1)?.title).toBe('Track b');

    h.setState({ ...h.state(), cursor: 0, positionSec: 0 });
    await h.service.control('u1', 'cast-1', { type: 'previous' });
    expect(transport.loads.at(-1)?.title).toBe('Track a');
  });

  it('ignores commands when the session no longer targets this cast', async () => {
    const h = createHarness({ queue: [remoteTrack('a')], cursor: 0, playing: true });
    await castTo(h);
    const transport = h.transport;
    const callsBefore = transport.calls.length;

    h.setState({ ...h.state(), target: null });
    await h.service.control('u1', 'cast-1', { type: 'play' });
    expect(transport.calls).toHaveLength(callsBefore);
  });

  it('mints a fresh relay URL on play once the old one has expired', async () => {
    const h = createHarness({ queue: [remoteTrack('a'), remoteTrack('b')], cursor: 0, playing: true });
    await castTo(h);
    const transport = h.transport;
    const firstUrl = transport.loads[0]?.url;
    h.setState({ ...h.state(), positionSec: 30, updatedAt: now });

    // Past the relay TTL: the transport may still hold the old URL.
    h.advanceRelay(61_000);
    await h.service.control('u1', 'cast-1', { type: 'play' });

    expect(transport.loads).toHaveLength(2);
    expect(transport.loads[1]?.url).not.toBe(firstUrl);
    expect(transport.loads[1]?.startSec).toBe(30);
    expect(transport.loads[1]?.autoplay).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Status and idle
// ---------------------------------------------------------------------------

describe('cast status and idle', () => {
  it('reports playing changes and periodic ticks while playing, but never idles', async () => {
    const h = createHarness({ queue: [remoteTrack('a')], cursor: 0, playing: true });
    await castTo(h);
    const transport = h.transport;

    transport.emitStatus({ playing: true, positionSec: 0.5, volume: 0.5 });
    expect(h.calls.reports.at(-1)?.report).toMatchObject({
      type: 'report',
      reason: 'playing',
      playing: true,
    });

    now += 3_000;
    transport.emitStatus({ playing: true, positionSec: 3.5, volume: 0.5 });
    expect(h.calls.reports.at(-1)?.report).toMatchObject({
      reason: 'tick',
      playing: true,
      positionSec: 3.5,
    });

    transport.emitStatus({ playing: false, positionSec: 3.5, volume: 0.5 });
    expect(h.calls.reports.at(-1)?.report).toMatchObject({
      reason: 'playing',
      playing: false,
      positionSec: 3.5,
    });
    expect(h.calls.reports.every((entry) => String(entry.report.reason) !== 'idle')).toBe(true);
  });

  it('advances once per FINISHED and reloads the next entry', async () => {
    const h = createHarness({ queue: [remoteTrack('a'), remoteTrack('b')], cursor: 0, playing: true });
    await castTo(h);
    const transport = h.transport;

    const finished: CastStatus = { playing: false, positionSec: 120, volume: 1, idle: true };
    transport.emitStatus(finished);
    transport.emitStatus(finished);
    await settle();

    expect(h.calls.ended).toHaveLength(1);
    expect(h.state().cursor).toBe(1);
    expect(transport.loads).toHaveLength(2);
    expect(transport.loads[1]?.title).toBe('Track b');
  });

  it('keeps the cursor and reloads the same entry for repeat-one', async () => {
    const h = createHarness({
      queue: [remoteTrack('a'), remoteTrack('b')],
      cursor: 0,
      playing: true,
      repeat: 'one',
    });
    await castTo(h);
    const transport = h.transport;

    transport.emitStatus({ playing: false, positionSec: 120, volume: 1, idle: true });
    await settle();

    expect(h.state().cursor).toBe(0);
    expect(transport.loads).toHaveLength(2);
    expect(transport.loads[1]?.title).toBe('Track a');
    expect(transport.loads[1]?.startSec).toBe(0);
    expect(transport.loads[1]?.autoplay).toBe(true);
  });

  it('stops the receiver at the end of a repeat-off queue', async () => {
    const h = createHarness({ queue: [remoteTrack('a')], cursor: 0, playing: true });
    await castTo(h);
    const transport = h.transport;

    transport.emitStatus({ playing: false, positionSec: 120, volume: 1, idle: true });
    await settle();

    expect(h.state().playing).toBe(false);
    expect(transport.calls).toContain('stop');
    expect(transport.loads).toHaveLength(1);
  });

  it('marks the entry unavailable and pauses when the reload after idle fails', async () => {
    const h = createHarness({ queue: [remoteTrack('a'), remoteTrack('b')], cursor: 0, playing: true });
    await castTo(h);
    const transport = h.transport;

    // The next entry becomes unplayable between setTarget and the auto-advance.
    h.setState({
      ...h.state(),
      order: [h.state().order[0] as SessionTrack, remoteTrack('b', { uploadId: 'upload-gone' })],
    });
    transport.emitStatus({ playing: false, positionSec: 120, volume: 1, idle: true });
    await settle();

    expect(h.state().cursor).toBe(1);
    expect(h.calls.unavailable.at(-1)?.entryIds).toContain('b');
    expect(h.calls.reports.at(-1)?.report).toMatchObject({ reason: 'playing', playing: false });
    expect(transport.calls).toContain('pause');
  });

  it('drops the cast offline and reports castLost after the grace period', async () => {
    const h = createHarness({ queue: [remoteTrack('a')], cursor: 0, playing: true });
    await castTo(h);
    const transport = h.transport;

    vi.useFakeTimers();
    transport.emitDisconnect();
    expect(h.calls.lost).toEqual([]);
    expect(h.service.devices().find((row) => row.castId === 'cast-1')?.online).toBe(false);

    vi.advanceTimersByTime(CAST_LOST_GRACE_MS - 1);
    expect(h.calls.lost).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(h.calls.lost).toEqual([{ userId: 'u1', castId: 'cast-1' }]);
    expect(transport.closed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// sync
// ---------------------------------------------------------------------------

describe('cast sync', () => {
  it('reloads on entry/content changes, not on reorder, and stops on an empty queue', async () => {
    const h = createHarness({
      queue: [remoteTrack('a'), remoteTrack('b')],
      cursor: 0,
      playing: true,
    });
    await castTo(h);
    const transport = h.transport;

    // setShuffle: same current entry, different order → no reload.
    h.setState({
      ...h.state(),
      order: [h.state().order[1] as SessionTrack, h.state().order[0] as SessionTrack],
      cursor: 1,
      shuffle: true,
    });
    await h.service.sync('u1', 'cast-1', h.state());
    expect(transport.loads).toHaveLength(1);

    // next: the shown entry changed → reload.
    h.setState({ ...h.state(), cursor: 0, positionSec: 0 });
    await h.service.sync('u1', 'cast-1', h.state());
    expect(transport.loads).toHaveLength(2);
    expect(transport.loads[1]?.title).toBe('Track b');

    // replace: same entryId, new media → reload.
    h.setState({
      ...h.state(),
      order: [
        remoteTrack('b', {
          id: 'remote:b2',
          title: 'Track b (remastered)',
          source: { site: 'youtube', url: 'https://8.8.8.8/b2.m4a' },
        }),
      ],
      cursor: 0,
    });
    await h.service.sync('u1', 'cast-1', h.state());
    expect(transport.loads).toHaveLength(3);
    expect(transport.loads[2]?.title).toBe('Track b (remastered)');

    // clear: nothing to play → stop.
    h.setState({ ...h.state(), order: [], cursor: -1, positionSec: 0, playing: false });
    await h.service.sync('u1', 'cast-1', h.state());
    expect(transport.calls).toContain('stop');
  });

  it('does nothing when the session no longer targets this cast', async () => {
    const h = createHarness({ queue: [remoteTrack('a'), remoteTrack('b')], cursor: 0, playing: true });
    await castTo(h);
    const transport = h.transport;

    h.setState({ ...h.state(), target: { kind: 'device', clientId: 'x', deviceId: 'x' } });
    h.setState({ ...h.state(), cursor: 1, positionSec: 0 });
    await h.service.sync('u1', 'cast-1', h.state());
    expect(transport.loads).toHaveLength(1);
  });
});
