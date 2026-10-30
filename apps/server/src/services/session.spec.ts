import {
  SESSION_MAX_ENTRIES,
  type SessionCommand,
  type SessionDevice,
  type SessionReportMessage,
  type SessionServerMessage,
  type SessionState,
  type SessionTrack,
} from '@open-record/models';
import {
  CastBusyError,
  SessionService,
  type SessionCastHooks,
  type SessionConnection,
} from './session';

const START = Date.parse('2026-01-01T00:00:00Z');

let now = START;
let connectionSeq = 0;
let service: SessionService;

beforeEach(() => {
  now = START;
  connectionSeq = 0;
  service = new SessionService({
    now: () => now,
    targetStaleAfterMs: 90_000,
    idleTimeoutMin: 120,
    targetStaleMin: 30,
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface Socket {
  conn: SessionConnection;
  messages: SessionServerMessage[];
  isClosed(): boolean;
}

function socket(clientId: string): Socket {
  const messages: SessionServerMessage[] = [];
  let closed = false;
  connectionSeq += 1;
  const conn: SessionConnection = {
    id: `conn-${connectionSeq}`,
    clientId,
    send(message) {
      // A real socket serialises immediately; clone so later mutations are visible.
      messages.push(JSON.parse(JSON.stringify(message)) as SessionServerMessage);
    },
    close() {
      closed = true;
    },
  };
  return { conn, messages, isClosed: () => closed };
}

function device(clientId: string, overrides: Partial<SessionDevice> = {}): SessionDevice {
  return {
    id: clientId,
    deviceId: `device-${clientId}`,
    name: `Device ${clientId}`,
    platform: 'web',
    online: true,
    lastSeenAt: now,
    capabilities: { cast: false, localFiles: false },
    ...overrides,
  };
}

function castDevice(castId: string): SessionDevice {
  return {
    id: castId,
    deviceId: castId,
    name: `Cast ${castId}`,
    platform: 'cast',
    online: true,
    lastSeenAt: now,
    castId,
    capabilities: { cast: true, localFiles: false },
  };
}

function track(entryId: string, overrides: Partial<SessionTrack> = {}): SessionTrack {
  return {
    entryId,
    id: `song:${entryId}`,
    providerId: 'remote',
    title: `Track ${entryId}`,
    artist: 'Artist',
    durationSec: 180,
    ...overrides,
  };
}

function join(userId: string, clientId: string, overrides: Partial<SessionDevice> = {}) {
  const joined = socket(clientId);
  const snapshot = service.join(userId, joined.conn, device(clientId, overrides));
  return { ...joined, snapshot };
}

function stateOf(userId = 'u'): SessionState {
  const state = service.snapshot(userId);
  if (!state) throw new Error(`no session for ${userId}`);
  return state;
}

function entryIds(userId = 'u'): string[] {
  return stateOf(userId).order.map((entry) => entry.entryId);
}

async function setQueue(
  ids: string[],
  cursor = 0,
  overrides: Partial<Extract<SessionCommand, { type: 'setQueue' }>> = {},
  clientId = 'a',
  userId = 'u',
) {
  return service.command(userId, clientId, {
    type: 'setQueue',
    order: ids.map((id) => track(id)),
    cursor,
    autoplay: true,
    shuffle: false,
    ...overrides,
  });
}

async function transferToDevice(targetClientId: string, clientId = 'a', userId = 'u') {
  return service.command(userId, clientId, {
    type: 'transfer',
    target: {
      kind: 'device',
      clientId: targetClientId,
      deviceId: `device-${targetClientId}`,
    },
  });
}

function report(
  sourceId: string,
  reason: SessionReportMessage['reason'],
  opts: Partial<SessionReportMessage> = {},
  userId = 'u',
) {
  service.report(userId, sourceId, {
    type: 'report',
    reason,
    entryId: stateOf(userId).order[stateOf(userId).cursor]?.entryId ?? '',
    positionSec: 0,
    playing: stateOf(userId).playing,
    ...opts,
  });
}

class StubHooks implements SessionCastHooks {
  castDevices: SessionDevice[] = [];
  targetCalls: {
    userId: string;
    requester: SessionDevice;
    previousCastId: string | null;
    next: { castId: string; state: SessionState } | null;
    force: boolean;
  }[] = [];
  controlCalls: { userId: string; castId: string; command: SessionCommand }[] = [];
  stateCalls: { userId: string; castId: string; state: SessionState }[] = [];
  owner: { userId: string; deviceId: string; deviceName: string } | null = null;
  events: string[] = [];
  targetError: Error | null = null;
  controlError: Error | null = null;
  onLost: ((userId: string, castId: string) => void) | null = null;

  devices(): SessionDevice[] {
    return this.castDevices;
  }

  async onTarget(
    userId: string,
    requester: SessionDevice,
    previousCastId: string | null,
    next: { castId: string; state: SessionState } | null,
    opts?: { force?: boolean },
  ): Promise<void> {
    this.targetCalls.push({ userId, requester, previousCastId, next, force: opts?.force === true });
    if (!next) {
      this.events.push(`stop:${userId}`);
      if (this.owner?.userId === userId) this.owner = null;
      return;
    }
    if (this.owner && this.owner.userId !== userId) {
      if (!opts?.force) {
        this.events.push(`busy:${userId}`);
        throw new CastBusyError(this.owner);
      }
      const previous = this.owner;
      this.events.push(`takeover:${userId}`);
      this.owner = null;
      this.onLost?.(previous.userId, next.castId);
    }
    if (this.targetError) throw this.targetError;
    this.owner = { userId, deviceId: requester.deviceId, deviceName: requester.name };
  }

  async onControl(userId: string, castId: string, command: SessionCommand): Promise<void> {
    this.controlCalls.push({ userId, castId, command });
    if (this.controlError) throw this.controlError;
  }

  async onState(userId: string, castId: string, state: SessionState): Promise<void> {
    // Clone: later commits mutate the live state object.
    this.stateCalls.push({
      userId,
      castId,
      state: JSON.parse(JSON.stringify(state)) as SessionState,
    });
  }
}

function castHooks(): StubHooks {
  const hooks = new StubHooks();
  hooks.castDevices = [castDevice('cast-1')];
  service.setCastHooks(hooks);
  return hooks;
}

// ---------------------------------------------------------------------------
// Join / presence / rooms
// ---------------------------------------------------------------------------

describe('session join and rooms', () => {
  it('returns a default state, sends no welcome, and announces the new device to others', () => {
    const a = join('u', 'a');
    expect(a.messages).toEqual([]);
    expect(a.snapshot.session).toMatchObject({
      order: [],
      cursor: -1,
      playing: false,
      shuffle: false,
      repeat: 'off',
      target: null,
      revision: 1,
      positionSec: 0,
      updatedBy: null,
    });
    expect(a.snapshot.devices.map((row) => row.id)).toEqual(['a']);

    const b = join('u', 'b');
    expect(b.messages).toEqual([]);
    const devices = a.messages.filter((message) => message.type === 'devices');
    expect(devices).toHaveLength(1);
    const last = devices[devices.length - 1];
    expect(last?.type === 'devices' ? last.devices.map((row) => row.id) : []).toEqual(['a', 'b']);
  });

  it('replaces only the same clientId socket on reconnect', async () => {
    const first = socket('a');
    service.join('u', first.conn, device('a'));
    const second = socket('a');
    const snapshot = service.join('u', second.conn, device('a'));

    expect(first.isClosed()).toBe(true);
    expect(snapshot.devices.filter((row) => row.id === 'a')).toHaveLength(1);

    const before = first.messages.length;
    await service.command('u', 'a', { type: 'pause' });
    expect(first.messages).toHaveLength(before);
    expect(second.messages.some((message) => message.type === 'state')).toBe(true);
  });

  it('keeps two clients with one deviceId apart and isolates rooms', async () => {
    join('u', 'a', { deviceId: 'shared-install' });
    join('u', 'b', { deviceId: 'shared-install' });
    join('v', 'c');

    const rows = service.devices('u');
    expect(rows.map((row) => row.id)).toEqual(['a', 'b']);
    expect(rows.every((row) => row.deviceId === 'shared-install')).toBe(true);
    expect(service.devices('v').map((row) => row.id)).toEqual(['c']);
    expect(service.snapshot('v')).not.toBeNull();

    const crossRoom = await service.command('v', 'a', { type: 'pause' });
    expect(crossRoom).toEqual({ ok: false, error: 'unknown-client' });
  });

  it('rejects a hello whose device id differs from the connection clientId', () => {
    const joined = socket('a');
    expect(() => service.join('u', joined.conn, device('other'))).toThrow('invalid-device');
  });

  it('rejects commands from unknown or offline clients', async () => {
    const a = join('u', 'a');
    await setQueue(['x'], 0);
    await transferToDevice('a');
    expect(await service.command('u', 'ghost', { type: 'pause' })).toEqual({
      ok: false,
      error: 'unknown-client',
    });
    expect(await service.command('nobody', 'a', { type: 'pause' })).toEqual({
      ok: false,
      error: 'unknown-client',
    });

    now += 31_000;
    service.sweep(now);
    expect(service.devices('u').find((row) => row.id === 'a')?.online).toBe(true); // target stays online
    expect((await service.command('u', 'a', { type: 'pause' })).ok).toBe(true);
    expect(a.snapshot.serverTime).toBe(START);
  });
});

describe('presence and idle rooms', () => {
  it('marks non-targets offline after 30 s and removes them after 60 s', async () => {
    join('u', 'a');
    service.touch('u', 'b', device('b')); // polling-only presence
    await setQueue(['x'], 0);
    await transferToDevice('a');

    now += 31_000;
    service.sweep(now);
    const offline = service.devices('u');
    expect(offline.find((row) => row.id === 'b')?.online).toBe(false);
    expect(offline.find((row) => row.id === 'a')?.online).toBe(true);
    expect(await service.command('u', 'b', { type: 'pause' })).toEqual({
      ok: false,
      error: 'unknown-client',
    });

    now += 30_000;
    service.sweep(now);
    expect(service.devices('u').map((row) => row.id)).toEqual(['a']);
  });

  it('drops idle rooms but keeps a room with a cast target', async () => {
    const idle = join('u', 'a');
    service.leave('u', idle.conn);
    now += 61_000;
    service.sweep(now);
    expect(service.snapshot('u')).not.toBeNull();

    now += 120 * 60_000;
    service.sweep(now);
    expect(service.snapshot('u')).toBeNull();
    expect(service.devices('u')).toEqual([]);

    const hooks = castHooks();
    const castRoom = join('v', 'a');
    await setQueue(['x'], 0, {}, 'a', 'v');
    expect(
      (
        await service.command('v', 'a', {
          type: 'transfer',
          target: { kind: 'cast', castId: 'cast-1' },
        })
      ).ok,
    ).toBe(true);
    service.leave('v', castRoom.conn);
    now += 200 * 60_000;
    service.sweep(now);
    expect(service.snapshot('v')?.target).toEqual({ kind: 'cast', castId: 'cast-1' });
    expect(hooks.owner?.userId).toBe('v');
  });
});

// ---------------------------------------------------------------------------
// Transfer / cast lock
// ---------------------------------------------------------------------------

describe('transfer and the cast lock', () => {
  it('carries cursor, anchored position and playing state to a device', async () => {
    join('u', 'a');
    join('u', 'b');
    await setQueue(['a', 'b', 'c'], 1);
    now += 12_500;

    const result = await transferToDevice('b');
    const state = stateOf();
    expect(result.ok).toBe(true);
    expect(state.target).toEqual({ kind: 'device', clientId: 'b', deviceId: 'device-b' });
    expect(state.cursor).toBe(1);
    expect(state.positionSec).toBeCloseTo(12.5);
    expect(state.playing).toBe(true);
    expect(state.updatedBy).toBe('a');
  });

  it('awaits onTarget with the carried state for a cast transfer', async () => {
    const hooks = castHooks();
    join('u', 'a');
    await setQueue(['a', 'b'], 0);
    now += 7_000;

    const result = await service.command('u', 'a', {
      type: 'transfer',
      target: { kind: 'cast', castId: 'cast-1' },
    });

    expect(result.ok).toBe(true);
    expect(hooks.targetCalls).toHaveLength(1);
    const call = hooks.targetCalls[0];
    expect(call?.previousCastId).toBeNull();
    expect(call?.force).toBe(false);
    expect(call?.next?.castId).toBe('cast-1');
    expect(call?.next?.state.target).toEqual({ kind: 'cast', castId: 'cast-1' });
    expect(call?.next?.state.positionSec).toBeCloseTo(7);
    expect(hooks.owner?.userId).toBe('u');
    expect(stateOf().target).toEqual({ kind: 'cast', castId: 'cast-1' });
  });

  it('leaves the previous target untouched and records castOwner when the cast is busy', async () => {
    castHooks();
    join('u', 'a');
    await setQueue(['a'], 0);
    await service.command('u', 'a', {
      type: 'transfer',
      target: { kind: 'cast', castId: 'cast-1' },
    });

    join('v', 'b');
    await setQueue(['b'], 0, {}, 'b', 'v');
    const before = stateOf('v').revision;
    const result = await service.command('v', 'b', {
      type: 'transfer',
      target: { kind: 'cast', castId: 'cast-1' },
    });

    expect(result).toEqual({ ok: false, error: 'cast-busy' });
    const loser = stateOf('v');
    expect(loser.target).toBeNull();
    expect(loser.castOwner).toEqual({ deviceId: 'device-a', deviceName: 'Device a' });
    expect(loser.revision).toBe(before + 1);
    expect(stateOf('u').target).toEqual({ kind: 'cast', castId: 'cast-1' });
  });

  it('leaves the previous target untouched for non-busy hook failures', async () => {
    const hooks = castHooks();
    hooks.targetError = new Error('speaker-away');
    join('u', 'a');
    await setQueue(['a'], 0);
    const before = stateOf().revision;

    const result = await service.command('u', 'a', {
      type: 'transfer',
      target: { kind: 'cast', castId: 'cast-1' },
    });

    expect(result).toEqual({ ok: false, error: 'speaker-away' });
    expect(stateOf().target).toBeNull();
    expect(stateOf().revision).toBe(before);
    expect(stateOf().castOwner).toBeUndefined();
  });

  it('takeOver forces the lock and castLost pauses the previous room before the winner acks', async () => {
    const hooks = castHooks();
    const observed: { lost: SessionState | null } = { lost: null };
    hooks.onLost = (userId, castId) => {
      service.castLost(userId, castId);
      observed.lost = service.snapshot(userId);
    };

    join('u', 'a');
    await setQueue(['a'], 0);
    await service.command('u', 'a', {
      type: 'transfer',
      target: { kind: 'cast', castId: 'cast-1' },
    });
    const loserRevision = stateOf('u').revision;

    join('v', 'b');
    await setQueue(['b'], 0, {}, 'b', 'v');
    const winnerRevision = stateOf('v').revision;
    hooks.events.length = 0;

    const result = await service.command('v', 'b', { type: 'takeOver', castId: 'cast-1' });

    expect(result.ok).toBe(true);
    expect(hooks.targetCalls[hooks.targetCalls.length - 1]?.force).toBe(true);
    expect(hooks.events).toEqual(['takeover:v']);
    expect(observed.lost?.target).toBeNull();
    expect(observed.lost?.playing).toBe(false);
    const loser = stateOf('u');
    expect(loser.target).toBeNull();
    expect(loser.playing).toBe(false);
    expect(loser.revision).toBe(loserRevision + 1);
    expect(stateOf('v').target).toEqual({ kind: 'cast', castId: 'cast-1' });
    expect(stateOf('v').revision).toBe(winnerRevision + 1);
    expect(hooks.owner?.userId).toBe('v');
  });

  it('serialises a concurrent takeOver/transfer from two users: one winner, one bump per room', async () => {
    const hooks = castHooks();
    hooks.onLost = (userId, castId) => service.castLost(userId, castId);

    // User u already owns the cast.
    join('u', 'a');
    await setQueue(['a'], 0);
    await service.command('u', 'a', {
      type: 'transfer',
      target: { kind: 'cast', castId: 'cast-1' },
    });

    // Two other users race for it: w takes over (force), v transfers (no force).
    join('v', 'b');
    join('w', 'c');
    const revisions = {
      u: stateOf('u').revision,
      v: stateOf('v').revision,
      w: stateOf('w').revision,
    };

    const takeover = service.command('w', 'c', { type: 'takeOver', castId: 'cast-1' });
    const transfer = service.command('v', 'b', {
      type: 'transfer',
      target: { kind: 'cast', castId: 'cast-1' },
    });
    const [winner, loser] = await Promise.all([takeover, transfer]);

    expect(winner.ok).toBe(true);
    expect(loser).toEqual({ ok: false, error: 'cast-busy' });
    // The winner took the lock and the old owner was stopped exactly once.
    expect(stateOf('u').target).toBeNull();
    expect(stateOf('u').playing).toBe(false);
    expect(stateOf('u').revision).toBe(revisions.u + 1);
    expect(stateOf('w').target).toEqual({ kind: 'cast', castId: 'cast-1' });
    expect(stateOf('w').revision).toBe(revisions.w + 1);
    // The loser only recorded the busy owner.
    expect(stateOf('v').target).toBeNull();
    expect(stateOf('v').castOwner).toEqual({ deviceId: 'device-c', deviceName: 'Device c' });
    expect(stateOf('v').revision).toBe(revisions.v + 1);
  });
});

// ---------------------------------------------------------------------------
// Revisions and reports
// ---------------------------------------------------------------------------

describe('revisions and target reports', () => {
  it('keeps revisions monotonic; a tick does not bump, a playing flip does', async () => {
    join('u', 'a');
    join('u', 'b');
    await setQueue(['a'], 0);
    await transferToDevice('a');
    const initial = stateOf().revision;

    report('a', 'tick', { positionSec: 5, playing: false });
    expect(stateOf().revision).toBe(initial);
    expect(stateOf().positionSec).toBe(5);

    report('a', 'playing', { positionSec: 6, playing: false });
    expect(stateOf().revision).toBe(initial + 1);
    expect(stateOf().playing).toBe(false);

    const a = socket('a');
    service.join('u', a.conn, device('a')); // reconnect the same client, no revision change
    report('a', 'playing', { positionSec: 7, playing: false });
    expect(stateOf().revision).toBe(initial + 1); // no flip, no bump
    expect(a.messages.some((message) => message.type === 'state')).toBe(false);

    report('a', 'tick', { positionSec: 8, playing: false });
    expect(stateOf().revision).toBe(initial + 1);
    expect(a.messages.some((message) => message.type === 'tick')).toBe(true);
  });

  it('ignores reports from non-targets', async () => {
    const a = join('u', 'a');
    join('u', 'b');
    await setQueue(['a', 'b'], 0);
    await transferToDevice('a');
    const revision = stateOf().revision;
    a.messages.length = 0;

    report('b', 'tick', { positionSec: 99, entryId: 'a' });
    report('b', 'playing', { positionSec: 99, playing: false, entryId: 'a' });
    report('b', 'native-skip', { entryId: 'b', positionSec: 99, playing: true });

    expect(stateOf().revision).toBe(revision);
    expect(stateOf().cursor).toBe(0);
    expect(stateOf().positionSec).toBe(0);
    expect(a.messages).toHaveLength(0);
  });

  it('moves the cursor on native-skip without a second advance', async () => {
    join('u', 'a');
    await setQueue(['a', 'b', 'c'], 0);
    await transferToDevice('a');
    const before = stateOf().revision;

    report('a', 'native-skip', { entryId: 'b', positionSec: 40, playing: true });
    expect(stateOf().cursor).toBe(1);
    expect(stateOf().positionSec).toBe(40);
    expect(stateOf().playing).toBe(true);
    expect(stateOf().revision).toBe(before + 1);

    const after = stateOf().revision;
    report('a', 'native-skip', { entryId: 'vanished', positionSec: 12, playing: true });
    expect(stateOf().cursor).toBe(1);
    expect(stateOf().revision).toBe(after);
  });

  it('ignores a duplicate ended for the same entry/load', async () => {
    join('u', 'a');
    await setQueue(['a', 'b', 'c'], 1);
    await service.command('u', 'a', { type: 'setRepeat', repeat: 'one' });
    await transferToDevice('a');
    const before = stateOf().revision;

    report('a', 'ended', { entryId: 'b', positionSec: 180, playing: true });
    expect(stateOf().cursor).toBe(1);
    expect(stateOf().positionSec).toBe(0);
    expect(stateOf().playing).toBe(true);
    expect(stateOf().revision).toBe(before + 1);

    report('a', 'ended', { entryId: 'b', positionSec: 180, playing: true });
    expect(stateOf().revision).toBe(before + 1);
    expect(stateOf().positionSec).toBe(0);

    // The next real end (a later load) advances/restarts again.
    now += 10_000;
    report('a', 'ended', { entryId: 'b', positionSec: 180, playing: true });
    expect(stateOf().revision).toBe(before + 2);
  });

  it('applies repeat-one, repeat-all and repeat-off natural-end rules', async () => {
    join('u', 'a');
    await setQueue(['a', 'b', 'c'], 1);
    await transferToDevice('a');

    await service.command('u', 'a', { type: 'setRepeat', repeat: 'one' });
    report('a', 'ended', { entryId: 'b', positionSec: 180, playing: true });
    expect(stateOf().cursor).toBe(1);
    expect(stateOf().positionSec).toBe(0);
    expect(stateOf().playing).toBe(true);

    // A manual next never restarts on repeat-one.
    await service.command('u', 'a', { type: 'next' });
    expect(stateOf().cursor).toBe(2);

    await service.command('u', 'a', { type: 'setRepeat', repeat: 'all' });
    report('a', 'ended', { entryId: 'c', positionSec: 180, playing: true });
    expect(stateOf().cursor).toBe(0);
    expect(stateOf().playing).toBe(true);

    await service.command('u', 'a', { type: 'setRepeat', repeat: 'off' });
    await service.command('u', 'a', { type: 'playIndex', index: 2 });
    report('a', 'ended', { entryId: 'c', positionSec: 180, playing: true, durationSec: 200 });
    expect(stateOf().cursor).toBe(2);
    expect(stateOf().playing).toBe(false);
    expect(stateOf().positionSec).toBe(200);
  });

  it('ignores an ended report for an entry that is no longer current', async () => {
    join('u', 'a');
    await setQueue(['a', 'b'], 0);
    await transferToDevice('a');
    const before = stateOf().revision;
    report('a', 'ended', { entryId: 'b', positionSec: 3, playing: true });
    expect(stateOf().revision).toBe(before);
    expect(stateOf().cursor).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Queue commands
// ---------------------------------------------------------------------------

describe('queue commands', () => {
  it('keeps duplicate songs distinct but rejects duplicate entry ids', async () => {
    join('u', 'a');
    const one = track('e1', { id: 'song:same' });
    const two = track('e2', { id: 'song:same' });
    const first = await service.command('u', 'a', {
      type: 'setQueue',
      order: [one, two],
      cursor: 0,
      autoplay: true,
      shuffle: false,
    });
    expect(first.ok).toBe(true);
    expect(entryIds()).toEqual(['e1', 'e2']);

    const revision = stateOf().revision;
    const duplicate = await service.command('u', 'a', {
      type: 'setQueue',
      order: [one, track('e1')],
      cursor: 0,
      autoplay: true,
      shuffle: false,
    });
    expect(duplicate).toEqual({ ok: false, error: 'duplicate-entry-id' });
    expect(stateOf().revision).toBe(revision);
    expect(entryIds()).toEqual(['e1', 'e2']);

    const enqueueDuplicate = await service.command('u', 'a', {
      type: 'enqueue',
      tracks: [track('e1')],
      next: true,
    });
    expect(enqueueDuplicate).toEqual({ ok: false, error: 'duplicate-entry-id' });
  });

  it('accepts entries with an empty artist or album (remote import metadata)', async () => {
    join('u', 'a');
    const result = await service.command('u', 'a', {
      type: 'setQueue',
      order: [
        track('e1', { artist: '', album: '' }),
        track('e2', { artist: '' }),
        track('e3', { title: '', artist: '' }),
      ],
      cursor: 0,
      autoplay: true,
      shuffle: false,
    });
    expect(result.ok).toBe(true);
    expect(entryIds()).toEqual(['e1', 'e2', 'e3']);
    expect(stateOf().order[0]).toMatchObject({ artist: '', album: '' });
  });

  it('validates ids, indices, payloads and caps', async () => {
    join('u', 'a');
    await setQueue(['a', 'b'], 0);
    const revision = stateOf().revision;

    expect(await service.command('u', 'a', { type: 'playEntry', entryId: 'nope' })).toEqual({
      ok: false,
      error: 'entry-not-found',
    });
    expect(await service.command('u', 'a', { type: 'playIndex', index: 3 })).toEqual({
      ok: false,
      error: 'index-out-of-range',
    });
    expect(await service.command('u', 'a', { type: 'remove', entryId: 'nope' })).toEqual({
      ok: false,
      error: 'entry-not-found',
    });
    expect(await service.command('u', 'a', { type: 'move', from: 0, to: 9 })).toEqual({
      ok: false,
      error: 'index-out-of-range',
    });
    expect(await service.command('u', 'a', { type: 'seek', positionSec: -1 })).toEqual({
      ok: false,
      error: 'invalid-command',
    });
    expect(await service.command('u', 'a', { type: 'setCastVolume', volume: 0.5 })).toEqual({
      ok: false,
      error: 'invalid-command',
    });
    expect(
      (
        await service.command('u', 'a', {
          type: 'transfer',
          target: { kind: 'device', clientId: 'ghost', deviceId: 'device-ghost' },
        })
      ).error,
    ).toBe('unknown-client');
    expect(stateOf().revision).toBe(revision);

    const tooMany = Array.from({ length: SESSION_MAX_ENTRIES + 1 }, (_, index) => track(`m${index}`));
    expect(
      (
        await service.command('u', 'a', {
          type: 'setQueue',
          order: tooMany,
          cursor: 0,
          autoplay: true,
          shuffle: false,
        })
      ).error,
    ).toBe('queue-too-large');

    const tooLarge = Array.from({ length: SESSION_MAX_ENTRIES }, (_, index) =>
      track(`l${index}`, {
        source: { site: 'youtube', url: `https://example.com/${'a'.repeat(2000)}${index}` },
      }),
    );
    expect(
      (
        await service.command('u', 'a', {
          type: 'setQueue',
          order: tooLarge,
          cursor: 0,
          autoplay: true,
          shuffle: false,
        })
      ).error,
    ).toBe('queue-too-large');

    const tooManyEnqueue = Array.from({ length: 101 }, (_, index) => track(`q${index}`));
    expect(
      (await service.command('u', 'a', { type: 'enqueue', tracks: tooManyEnqueue, next: true })).error,
    ).toBe('queue-too-large');
  });

  it('enqueues play-next at cursor + 1 and appends otherwise', async () => {
    join('u', 'a');
    await setQueue(['a', 'b', 'c'], 0);
    await service.command('u', 'a', { type: 'enqueue', tracks: [track('next')], next: true });
    expect(entryIds()).toEqual(['a', 'next', 'b', 'c']);
    expect(stateOf().cursor).toBe(0);

    await service.command('u', 'a', { type: 'enqueue', tracks: [track('end')], next: false });
    expect(entryIds()).toEqual(['a', 'next', 'b', 'c', 'end']);
  });

  it('moves/replaces without moving the cursor and clears unavailable', async () => {
    join('u', 'a');
    await setQueue(['a', 'b', 'c', 'd'], 1);
    service.setUnavailable('u', ['b', 'c']);
    expect(stateOf().unavailable).toEqual(['b', 'c']);

    await service.command('u', 'a', { type: 'remove', entryId: 'b' });
    expect(entryIds()).toEqual(['a', 'c', 'd']);
    expect(stateOf().cursor).toBe(1);
    expect(stateOf().order[1]?.entryId).toBe('c');
    expect(stateOf().unavailable).toEqual(['c']);

    await service.command('u', 'a', {
      type: 'replace',
      entryId: 'c',
      track: track('c', { id: 'song:new', title: 'New title' }),
    });
    expect(stateOf().cursor).toBe(1);
    expect(stateOf().order[1]?.entryId).toBe('c');
    expect(stateOf().order[1]?.title).toBe('New title');
    expect(stateOf().unavailable).toBeUndefined();

    service.setUnavailable('u', ['a']);
    await setQueue(['x', 'y'], 0);
    expect(stateOf().unavailable).toBeUndefined();

    await setQueue(['a', 'b', 'c'], 1);
    await service.command('u', 'a', { type: 'move', from: 0, to: 2 });
    expect(entryIds()).toEqual(['b', 'c', 'a']);
    expect(stateOf().cursor).toBe(0);
    expect(stateOf().order[0]?.entryId).toBe('b');
  });

  it('advances when the current entry is removed, including at the repeat-off end', async () => {
    join('u', 'a');
    await setQueue(['a', 'b', 'c', 'd'], 1);
    await service.command('u', 'a', { type: 'remove', entryId: 'b' });
    expect(entryIds()).toEqual(['a', 'c', 'd']);
    expect(stateOf().cursor).toBe(1);
    expect(stateOf().positionSec).toBe(0);

    await service.command('u', 'a', { type: 'remove', entryId: 'a' });
    expect(entryIds()).toEqual(['c', 'd']);
    expect(stateOf().cursor).toBe(0);
    expect(stateOf().order[0]?.entryId).toBe('c');

    await setQueue(['a', 'b', 'c'], 2);
    await service.command('u', 'a', { type: 'remove', entryId: 'c' });
    expect(entryIds()).toEqual(['a', 'b']);
    expect(stateOf().cursor).toBe(1);
    expect(stateOf().order[1]?.entryId).toBe('b');
  });

  it('round-trips shuffle and keeps the cursor on the same entry', async () => {
    join('u', 'a');
    await setQueue(['a', 'b', 'c', 'd', 'e'], 2);
    const original = entryIds();
    const cursorEntry = stateOf().order[stateOf().cursor]?.entryId;

    await service.command('u', 'a', { type: 'setShuffle', shuffle: true });
    const shuffled = stateOf();
    expect(shuffled.shuffle).toBe(true);
    expect([...shuffled.order.map((entry) => entry.entryId)].sort()).toEqual([...original].sort());
    expect(shuffled.order[shuffled.cursor]?.entryId).toBe(cursorEntry);
    expect(shuffled.baseOrderIds).toEqual(original);

    await service.command('u', 'a', { type: 'setShuffle', shuffle: false });
    const restored = stateOf();
    expect(restored.shuffle).toBe(false);
    expect(restored.order.map((entry) => entry.entryId)).toEqual(original);
    expect(restored.order[restored.cursor]?.entryId).toBe(cursorEntry);
    expect(restored.baseOrderIds).toBeUndefined();
  });

  it('shuffles a natural setQueue server-side and keeps the incoming current entry', async () => {
    join('u', 'a');
    const result = await service.command('u', 'a', {
      type: 'setQueue',
      order: ['a', 'b', 'c', 'd'].map((id) => track(id)),
      cursor: 2,
      autoplay: true,
      shuffle: true,
    });
    expect(result.ok).toBe(true);
    expect(stateOf().shuffle).toBe(true);
    expect([...entryIds()].sort()).toEqual(['a', 'b', 'c', 'd']);
    expect(stateOf().order[stateOf().cursor]?.entryId).toBe('c');
    expect(stateOf().baseOrderIds).toEqual(['a', 'b', 'c', 'd']);

    await service.command('u', 'a', { type: 'setShuffle', shuffle: false });
    expect(stateOf().shuffle).toBe(false);
    expect(entryIds()).toEqual(['a', 'b', 'c', 'd']);
    expect(stateOf().order[stateOf().cursor]?.entryId).toBe('c');
  });

  it('accepts a shuffled setQueue with a base order and validates it', async () => {
    join('u', 'a');
    const result = await service.command('u', 'a', {
      type: 'setQueue',
      order: [track('c'), track('a'), track('b')],
      cursor: 1,
      autoplay: true,
      shuffle: true,
      baseOrderIds: ['a', 'b', 'c'],
    });
    expect(result.ok).toBe(true);
    expect(stateOf().baseOrderIds).toEqual(['a', 'b', 'c']);
    expect([...entryIds()].sort()).toEqual(['a', 'b', 'c']);
    expect(stateOf().order[stateOf().cursor]?.entryId).toBe('a');

    const invalid = await service.command('u', 'a', {
      type: 'setQueue',
      order: [track('c'), track('a'), track('b')],
      cursor: 1,
      autoplay: true,
      shuffle: true,
      baseOrderIds: ['a', 'a', 'b'],
    });
    expect(invalid).toEqual({ ok: false, error: 'invalid-command' });
  });

  it('clear empties a device target but keeps a cast target', async () => {
    join('u', 'a');
    await setQueue(['a', 'b'], 0);
    await transferToDevice('a');
    await service.command('u', 'a', { type: 'clear' });
    expect(stateOf()).toMatchObject({ order: [], cursor: -1, playing: false, target: null });

    const hooks = castHooks();
    await setQueue(['a', 'b'], 0);
    await service.command('u', 'a', {
      type: 'transfer',
      target: { kind: 'cast', castId: 'cast-1' },
    });
    await service.command('u', 'a', { type: 'clear' });
    expect(stateOf()).toMatchObject({
      order: [],
      cursor: -1,
      playing: false,
      target: { kind: 'cast', castId: 'cast-1' },
    });
    expect(hooks.owner?.userId).toBe('u');
  });

  it('stop pauses without emptying the queue', async () => {
    join('u', 'a');
    await setQueue(['a', 'b'], 0);
    now += 3_000;
    await service.command('u', 'a', { type: 'stop' });
    expect(stateOf().playing).toBe(false);
    expect(entryIds()).toEqual(['a', 'b']);
    expect(stateOf().positionSec).toBeCloseTo(3);
  });
});

// ---------------------------------------------------------------------------
// Cast target operations
// ---------------------------------------------------------------------------

describe('cast target operations', () => {
  it('castLost pauses, clears the target and bumps exactly once', async () => {
    castHooks();
    join('u', 'a');
    await setQueue(['a', 'b'], 0);
    await service.command('u', 'a', {
      type: 'transfer',
      target: { kind: 'cast', castId: 'cast-1' },
    });
    now += 10_000;
    const before = stateOf().revision;
    service.setCastSeekRestarts('u', 'cast-1', true);

    service.castLost('u', 'cast-1');
    const state = stateOf();
    expect(state.playing).toBe(false);
    expect(state.target).toBeNull();
    expect(state.targetStale).toBeUndefined();
    expect(state.castOwner).toBeUndefined();
    expect(state.castSeekRestarts).toBeUndefined();
    expect(state.revision).toBe(before + 2);
    expect(state.positionSec).toBeCloseTo(10);
  });

  it('sets and clears the transcoded seek hint only for the targeted cast', async () => {
    castHooks();
    join('u', 'a');
    await setQueue(['a', 'b'], 0);

    // No cast target yet: ignored without a revision bump.
    const before = stateOf().revision;
    service.setCastSeekRestarts('u', 'cast-1', true);
    expect(stateOf().castSeekRestarts).toBeUndefined();
    expect(stateOf().revision).toBe(before);

    await service.command('u', 'a', {
      type: 'transfer',
      target: { kind: 'cast', castId: 'cast-1' },
    });
    now += 5_000;
    const targeted = stateOf().revision;

    service.setCastSeekRestarts('u', 'cast-1', true);
    expect(stateOf().castSeekRestarts).toBe(true);
    expect(stateOf().revision).toBe(targeted + 1);
    expect(stateOf().positionSec).toBeCloseTo(5);

    // Another speaker is not the target: ignored.
    service.setCastSeekRestarts('u', 'cast-2', false);
    expect(stateOf().castSeekRestarts).toBe(true);

    service.setCastSeekRestarts('u', 'cast-1', false);
    expect(stateOf().castSeekRestarts).toBeUndefined();

    // A missing room is a no-op, not a crash.
    expect(() => service.setCastSeekRestarts('nobody', 'cast-1', true)).not.toThrow();
  });

  it('forwards transport and volume commands to the cast target', async () => {
    const hooks = castHooks();
    join('u', 'a');
    await setQueue(['a', 'b'], 0);
    await service.command('u', 'a', {
      type: 'transfer',
      target: { kind: 'cast', castId: 'cast-1' },
    });
    hooks.controlCalls.length = 0;

    await service.command('u', 'a', { type: 'setCastVolume', volume: 0.4 });
    expect(stateOf().castVolume).toBe(0.4);
    expect(hooks.controlCalls[hooks.controlCalls.length - 1]?.command).toEqual({
      type: 'setCastVolume',
      volume: 0.4,
    });

    now += 5_000;
    await service.command('u', 'a', { type: 'seek', positionSec: 10 });
    expect(stateOf().positionSec).toBe(10);
    expect(hooks.controlCalls[hooks.controlCalls.length - 1]?.command).toEqual({
      type: 'seek',
      positionSec: 10,
    });

    await service.command('u', 'a', { type: 'next' });
    expect(stateOf().cursor).toBe(1);
    expect(hooks.controlCalls[hooks.controlCalls.length - 1]?.command).toEqual({ type: 'next' });
  });

  it('forwards stop to the cast and reloads structural changes through onState', async () => {
    const hooks = castHooks();
    join('u', 'a');
    await setQueue(['a', 'b'], 0);
    await service.command('u', 'a', {
      type: 'transfer',
      target: { kind: 'cast', castId: 'cast-1' },
    });
    hooks.controlCalls.length = 0;
    hooks.stateCalls.length = 0;

    await service.command('u', 'a', { type: 'stop' });
    expect(stateOf().playing).toBe(false);
    expect(hooks.controlCalls).toEqual([
      { userId: 'u', castId: 'cast-1', command: { type: 'stop' } },
    ]);
    // A forwarded transport command is not also applied structurally.
    expect(hooks.stateCalls).toHaveLength(0);

    await service.command('u', 'a', {
      type: 'setQueue',
      order: [track('c'), track('d')],
      cursor: 0,
      autoplay: true,
      shuffle: false,
    });
    expect(hooks.controlCalls).toHaveLength(1);
    expect(hooks.stateCalls).toHaveLength(1);
    const applied = hooks.stateCalls[0];
    expect(applied?.castId).toBe('cast-1');
    expect(applied?.state.order.map((entry) => entry.entryId)).toEqual(['c', 'd']);
  });

  it('castEnded advances, loads via onControl and propagates load failures', async () => {
    const hooks = castHooks();
    join('u', 'a');
    await setQueue(['a', 'b', 'c'], 0);
    await service.command('u', 'a', {
      type: 'transfer',
      target: { kind: 'cast', castId: 'cast-1' },
    });
    const before = stateOf().revision;

    await service.castEnded('u', 'cast-1');
    expect(stateOf().cursor).toBe(1);
    expect(stateOf().positionSec).toBe(0);
    expect(stateOf().playing).toBe(true);
    expect(stateOf().revision).toBe(before + 1);
    expect(stateOf().updatedBy).toBeNull();
    expect(hooks.controlCalls[hooks.controlCalls.length - 1]?.command).toEqual({ type: 'play' });

    await service.command('u', 'a', { type: 'playIndex', index: 2 });
    await service.castEnded('u', 'cast-1');
    expect(stateOf().playing).toBe(false);
    expect(stateOf().positionSec).toBe(180);

    hooks.controlError = new Error('cast-gone');
    await expect(service.castEnded('u', 'cast-1')).rejects.toThrow('cast-gone');
  });

  it('does not treat a cast target as stale or idle', async () => {
    castHooks();
    const joined = join('u', 'a');
    await setQueue(['a'], 0);
    await service.command('u', 'a', {
      type: 'transfer',
      target: { kind: 'cast', castId: 'cast-1' },
    });
    await service.command('u', 'a', { type: 'play' });
    service.leave('u', joined.conn);

    now += 90_000;
    service.sweep(now);
    expect(stateOf().targetStale).toBeUndefined();
    expect(stateOf().playing).toBe(true);
    now += 30 * 60_000;
    service.sweep(now);
    expect(stateOf().target).not.toBeNull();
    expect(stateOf().playing).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Stale device target lifecycle
// ---------------------------------------------------------------------------

describe('stale device targets', () => {
  it('marks a silent target stale at 90 s while keeping it playing, and clears on contact', async () => {
    join('u', 'a');
    join('u', 'b');
    await setQueue(['song'], 0);
    await transferToDevice('a');
    const before = stateOf().revision;

    now += 89_000;
    service.sweep(now);
    expect(stateOf().targetStale).toBeUndefined();
    expect(stateOf().playing).toBe(true);

    now += 2_000;
    service.sweep(now);
    expect(stateOf().targetStale).toBe(true);
    expect(stateOf().playing).toBe(true);
    expect(stateOf().revision).toBe(before + 1);
    const staleRow = service.devices('u').find((row) => row.id === 'a');
    expect(staleRow?.stale).toBe(true);
    expect(staleRow?.online).toBe(true);

    // A non-target report must not clear the target's stale flag.
    report('b', 'tick', { positionSec: 4 });
    expect(stateOf().targetStale).toBe(true);

    // Any contact from the target clears it and bumps once.
    const staleRevision = stateOf().revision;
    service.touch('u', 'a', device('a'));
    expect(stateOf().targetStale).toBeUndefined();
    expect(stateOf().playing).toBe(true);
    expect(stateOf().revision).toBe(staleRevision + 1);
  });

  it('never pauses before 30 minutes, then pauses/clamps/clears the target', async () => {
    join('u', 'a');
    await setQueue(['song'], 0);
    await transferToDevice('a');

    now += 29 * 60_000;
    service.sweep(now);
    expect(stateOf().playing).toBe(true);
    expect(stateOf().target).not.toBeNull();
    expect(stateOf().targetStale).toBe(true);

    now += 60_000;
    const before = stateOf().revision;
    service.sweep(now);
    const state = stateOf();
    expect(state.playing).toBe(false);
    expect(state.target).toBeNull();
    expect(state.targetStale).toBeUndefined();
    expect(state.positionSec).toBe(180); // clamped to the entry duration
    expect(state.revision).toBe(before + 1);
  });
});

// ---------------------------------------------------------------------------
// Devices list
// ---------------------------------------------------------------------------

describe('devices list', () => {
  it('merges cast rows and bumps devicesRevision only when the visible set changes', () => {
    const hooks = castHooks();
    expect(service.devices('u').map((row) => row.id)).toEqual(['cast-1']);

    const joined = join('u', 'a');
    const revision = joined.snapshot.devicesRevision;
    expect(joined.snapshot.devices.map((row) => row.id)).toEqual(['a', 'cast-1']);

    // The same visible set must not bump again.
    expect(service.devices('u')).toHaveLength(2);
    expect(service.touch('u', 'a', device('a')).devicesRevision).toBe(revision);

    hooks.castDevices = [castDevice('cast-1'), castDevice('cast-2')];
    const next = service.touch('u', 'a', device('a'));
    expect(next.devicesRevision).toBe(revision + 1);
    expect(next.devices.map((row) => row.id)).toEqual(['a', 'cast-1', 'cast-2']);
  });

  it('reports the target as online and stale through devices()', async () => {
    join('u', 'a');
    await setQueue(['song'], 0);
    await transferToDevice('a');
    now += 91_000;
    service.sweep(now);
    const row = service.devices('u').find((entry) => entry.id === 'a');
    expect(row).toMatchObject({ online: true, stale: true });
  });
});
