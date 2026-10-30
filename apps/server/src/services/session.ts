// Server-owned session state machine. One room per Supabase user, entirely in
// memory: the server is the only writer of `SessionState`, devices send
// commands or observations (reports), and every accepted change is broadcast.
//
// Presence and staleness are deliberately separate from playback: a device
// target with no contact stays `playing` (the native engine keeps going while
// the WebView is suspended); only after `targetStaleMin` minutes of continuous
// silence does the server pause, clamp the position and clear the target.

import {
  anchoredPosition,
  clampCursor,
  nextCursor,
  previousCursor,
  SESSION_MAX_ENTRIES,
  SESSION_MAX_ORDER_BYTES,
  TARGET_STALE_AFTER_MS,
  type CommandResult,
  type SessionCommand,
  type SessionDevice,
  type SessionReportMessage,
  type SessionServerMessage,
  type SessionSnapshot,
  type SessionState,
  type SessionTrack,
} from '@open-record/models';

/** One socket / REST stream. `id` distinguishes a reconnect from the old socket. */
export interface SessionConnection {
  /** Socket/connection identity: distinguishes a reconnect from the old socket. */
  id: string;
  /** Playback/device identity (one per tab/app launch). */
  clientId: string;
  send(message: SessionServerMessage): void;
  close?(): void;
}

export interface SessionCastHooks {
  /** Cast rows for `devices()` (may be empty). */
  devices(): SessionDevice[];
  /**
   * Start/stop the cast target. Rejects with CastBusyError when another user
   * holds it. `force` is only set for a `takeOver` command.
   */
  onTarget(
    userId: string,
    requester: SessionDevice,
    previousCastId: string | null,
    next: { castId: string; state: SessionState } | null,
    opts?: { force?: boolean },
  ): Promise<void>;
  /** Transport/volume commands for an active cast target. */
  onControl(userId: string, castId: string, command: SessionCommand): Promise<void>;
  /** Structural command applied while a cast is targeted (reload/stop). */
  onState?(userId: string, castId: string, state: SessionState): void | Promise<void>;
}

export class CastBusyError extends Error {
  constructor(readonly owner: { userId: string; deviceId: string; deviceName: string }) {
    super('cast-busy');
    this.name = 'CastBusyError';
  }
}

/** Housekeeping cadence owned by `start()` (one interval per service). */
export const SESSION_TICK_MS = 5_000;
/** Presence: a poll/socket keeps a non-target listed as online this long. */
const PRESENCE_ONLINE_MS = 30_000;
/** Presence: remove a non-target client after this much silence. */
const PRESENCE_REMOVE_MS = 60_000;
const DEFAULT_IDLE_TIMEOUT_MIN = 120;
const DEFAULT_TARGET_STALE_MIN = 30;
/**
 * A duplicate `ended` for the same entry arrives back-to-back with the first
 * one; a later natural end of the same entry (repeat-one) is a new load.
 */
const ENDED_DEDUPE_MS = 5_000;

const MAX_ENTRY_ID_LEN = 128;
const MAX_TEXT_LEN = 300;
const MAX_URL_LEN = 2048;
const MAX_ENQUEUE_TRACKS = 100;

interface RoomDevice {
  deviceId: string;
  name: string;
  platform: SessionDevice['platform'];
  capabilities: SessionDevice['capabilities'];
  model?: string;
  lastSeenAt: number;
}

interface Room {
  session: SessionState;
  /** Client rows by `clientId` (distinct from connection ids). */
  devices: Map<string, RoomDevice>;
  /** Open sockets by connection id. */
  connections: Map<string, SessionConnection>;
  devicesRevision: number;
  /** Signature of the last visible device set (excludes volatile `lastSeenAt`). */
  devicesSignature: string;
  lastActivity: number;
  /** Last report/poll/socket contact from the current target. */
  lastTargetContactAt: number;
  lastEndedEntryId: string | null;
  lastEndedAt: number;
}

function defaultState(now: number): SessionState {
  return {
    order: [],
    cursor: -1,
    playing: false,
    shuffle: false,
    repeat: 'off',
    target: null,
    revision: 1,
    positionSec: 0,
    updatedAt: now,
    updatedBy: null,
  };
}

function cloneState(state: SessionState): SessionState {
  const copy: SessionState = {
    ...state,
    target: state.target ? { ...state.target } : null,
    order: state.order.map((entry) => ({
      ...entry,
      ...(entry.source ? { source: { ...entry.source } } : {}),
    })),
  };
  if (state.baseOrderIds) copy.baseOrderIds = [...state.baseOrderIds];
  if (state.unavailable) copy.unavailable = [...state.unavailable];
  if (state.castOwner) copy.castOwner = { ...state.castOwner };
  return copy;
}

function errorText(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

// ---------------------------------------------------------------------------
// Payload validation (hand-written; the wire is JSON, the types are only a
// compile-time promise). Length caps mirror §1.7.
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonNegativeFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value);
}

function isText(value: unknown, maxLength = MAX_TEXT_LEN): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength;
}

/**
 * Any string within the cap, including `''`: remote/import metadata can have an
 * empty artist or album, and §1.7 only caps these fields.
 */
function isCappedText(value: unknown, maxLength = MAX_TEXT_LEN): value is string {
  return typeof value === 'string' && value.length <= maxLength;
}

function isId(value: unknown): value is string {
  return isText(value, MAX_ENTRY_ID_LEN);
}

function isUrl(value: unknown): value is string {
  return isText(value, MAX_URL_LEN);
}

function isSessionTrack(value: unknown): value is SessionTrack {
  if (!isRecord(value)) return false;
  if (!isId(value['entryId']) || !isId(value['id']) || !isId(value['providerId'])) return false;
  if (!isCappedText(value['title']) || !isCappedText(value['artist'])) return false;
  if (value['album'] !== undefined && !isCappedText(value['album'])) return false;
  if (value['durationSec'] !== undefined && !isNonNegativeFinite(value['durationSec'])) return false;
  if (value['artUrl'] !== undefined && !isUrl(value['artUrl'])) return false;
  if (value['catalogFile'] !== undefined && !isId(value['catalogFile'])) return false;
  if (value['uploadId'] !== undefined && !isId(value['uploadId'])) return false;
  if (value['local'] !== undefined && typeof value['local'] !== 'boolean') return false;
  if (value['source'] !== undefined) {
    const source = value['source'];
    if (!isRecord(source)) return false;
    if (!isText(source['site']) || !isUrl(source['url'])) return false;
    if (source['id'] !== undefined && !isId(source['id'])) return false;
  }
  return true;
}

function isSessionTrackArray(value: unknown): value is SessionTrack[] {
  return Array.isArray(value) && value.every(isSessionTrack);
}

function isSessionTargetPayload(value: unknown): value is Extract<SessionCommand, { type: 'transfer' }>['target'] {
  if (!isRecord(value)) return false;
  if (value['kind'] === 'device') return isId(value['clientId']) && isId(value['deviceId']);
  if (value['kind'] === 'cast') return isId(value['castId']);
  return false;
}

function isBaseOrderIds(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= SESSION_MAX_ENTRIES &&
    value.every((entryId) => isId(entryId))
  );
}

function isSessionCommand(value: unknown): value is SessionCommand {
  if (!isRecord(value)) return false;
  switch (value['type']) {
    case 'play':
    case 'pause':
    case 'toggle':
    case 'stop':
    case 'clear':
    case 'next':
    case 'previous':
      return true;
    case 'seek':
      return isNonNegativeFinite(value['positionSec']);
    case 'playEntry':
      return isId(value['entryId']);
    case 'playIndex':
      return isInteger(value['index']) && value['index'] >= 0;
    case 'setQueue':
      return (
        isSessionTrackArray(value['order']) &&
        isInteger(value['cursor']) &&
        typeof value['autoplay'] === 'boolean' &&
        typeof value['shuffle'] === 'boolean' &&
        (value['baseOrderIds'] === undefined || isBaseOrderIds(value['baseOrderIds']))
      );
    case 'enqueue':
      return isSessionTrackArray(value['tracks']) && typeof value['next'] === 'boolean';
    case 'remove':
      return isId(value['entryId']);
    case 'move':
      return isInteger(value['from']) && value['from'] >= 0 && isInteger(value['to']) && value['to'] >= 0;
    case 'replace':
      return isId(value['entryId']) && isSessionTrack(value['track']);
    case 'setShuffle':
      return typeof value['shuffle'] === 'boolean';
    case 'setRepeat':
      return value['repeat'] === 'off' || value['repeat'] === 'all' || value['repeat'] === 'one';
    case 'transfer':
      return isSessionTargetPayload(value['target']);
    case 'takeOver':
      return isId(value['castId']);
    case 'setCastVolume':
      return isNonNegativeFinite(value['volume']) && value['volume'] <= 1;
    default:
      return false;
  }
}

function isSessionReport(value: unknown): value is SessionReportMessage {
  if (!isRecord(value)) return false;
  if (value['type'] !== 'report') return false;
  const reason = value['reason'];
  if (reason !== 'tick' && reason !== 'playing' && reason !== 'ended' && reason !== 'native-skip') {
    return false;
  }
  if (typeof value['entryId'] !== 'string' || value['entryId'].length > MAX_ENTRY_ID_LEN) return false;
  if (!isNonNegativeFinite(value['positionSec'])) return false;
  if (typeof value['playing'] !== 'boolean') return false;
  if (value['durationSec'] !== undefined && !isNonNegativeFinite(value['durationSec'])) return false;
  return true;
}

function orderByteLength(order: readonly SessionTrack[]): number {
  return Buffer.byteLength(JSON.stringify(order), 'utf8');
}

/** Fisher-Yates; uses the process RNG (the order is not security-sensitive). */
function shuffled<T>(items: readonly T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    const swap = out[i] as T;
    out[i] = out[j] as T;
    out[j] = swap;
  }
  return out;
}

function hasDuplicateIds(order: readonly SessionTrack[]): boolean {
  const ids = new Set<string>();
  for (const entry of order) {
    if (ids.has(entry.entryId)) return true;
    ids.add(entry.entryId);
  }
  return false;
}

function isPermutationOfOrder(ids: readonly string[], order: readonly SessionTrack[]): boolean {
  if (ids.length !== order.length) return false;
  const available = new Set(order.map((entry) => entry.entryId));
  if (available.size !== ids.length) return false;
  const seen = new Set<string>();
  for (const id of ids) {
    if (!available.has(id) || seen.has(id)) return false;
    seen.add(id);
  }
  return true;
}

export interface SessionServiceOptions {
  now?: () => number;
  idleTimeoutMin?: number;
  targetStaleMin?: number;
  targetStaleAfterMs?: number;
}

export class SessionService {
  private readonly nowFn: () => number;
  private readonly idleTimeoutMs: number;
  private readonly targetStaleMs: number;
  private readonly targetStaleAfterMs: number;
  private readonly rooms = new Map<string, Room>();
  private castHooks: SessionCastHooks | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: SessionServiceOptions = {}) {
    this.nowFn = opts.now ?? Date.now;
    this.idleTimeoutMs = (opts.idleTimeoutMin ?? DEFAULT_IDLE_TIMEOUT_MIN) * 60_000;
    this.targetStaleMs = (opts.targetStaleMin ?? DEFAULT_TARGET_STALE_MIN) * 60_000;
    this.targetStaleAfterMs = opts.targetStaleAfterMs ?? TARGET_STALE_AFTER_MS;
  }

  /** Set by T5.6 once CastService exists. */
  setCastHooks(hooks: SessionCastHooks): void {
    this.castHooks = hooks;
  }

  /** Starts the single housekeeping interval (tick, sweep, stale scan, idle timeout). */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      const now = this.nowFn();
      for (const room of this.rooms.values()) {
        if (!room.session.playing) continue;
        this.broadcast(room, {
          type: 'tick',
          revision: room.session.revision,
          positionSec: anchoredPosition(room.session, now),
          playing: room.session.playing,
          updatedAt: now,
          ...(room.session.targetStale ? { targetStale: true } : {}),
        });
      }
      this.sweep(now);
    }, SESSION_TICK_MS);
    // Never keep the process alive in tests / one-shot CLI use.
    (this.timer as { unref?: () => void }).unref?.();
  }

  join(userId: string, conn: SessionConnection, device: SessionDevice): SessionSnapshot {
    if (device.id !== conn.clientId) throw new Error('invalid-device');
    const now = this.nowFn();
    const room = this.roomFor(userId, now);

    // A reconnect (same clientId) replaces only its own socket.
    for (const [id, existing] of room.connections) {
      if (existing.clientId !== conn.clientId) continue;
      room.connections.delete(id);
      this.closeQuietly(existing);
    }
    room.connections.set(conn.id, conn);

    const previous = room.devices.get(conn.clientId);
    room.devices.set(conn.clientId, {
      deviceId: device.deviceId || previous?.deviceId || conn.clientId,
      name: device.name,
      platform: device.platform,
      capabilities: { ...device.capabilities },
      ...(device.model ? { model: device.model } : {}),
      lastSeenAt: now,
    });
    room.lastActivity = now;

    const staleCleared = this.noteContact(room, conn.clientId, now);
    if (staleCleared) {
      room.session.positionSec = anchoredPosition(room.session, now);
      room.session.revision += 1;
      room.session.updatedAt = now;
      this.broadcast(room, { type: 'state', session: room.session }, conn.id);
    }
    const devices = this.refreshDevices(room, true, conn.id, now);
    return this.snapshotFor(room, conn.clientId, now, devices);
  }

  leave(userId: string, conn: SessionConnection): void {
    const room = this.rooms.get(userId);
    if (!room) return;
    const stored = room.connections.get(conn.id);
    if (!stored || stored.clientId !== conn.clientId) return;
    room.connections.delete(conn.id);
    room.lastActivity = this.nowFn();
    this.refreshDevices(room, true);
  }

  /** REST polling: upsert the client/device, refresh presence, return the snapshot. */
  touch(userId: string, clientId: string, device: SessionDevice): SessionSnapshot {
    const now = this.nowFn();
    const room = this.roomFor(userId, now);
    const previous = room.devices.get(clientId);
    room.devices.set(clientId, {
      deviceId: device.deviceId || previous?.deviceId || clientId,
      name: device.name,
      platform: device.platform,
      capabilities: { ...device.capabilities },
      ...(device.model ? { model: device.model } : {}),
      lastSeenAt: now,
    });
    room.lastActivity = now;

    const staleCleared = this.noteContact(room, clientId, now);
    if (staleCleared) {
      room.session.positionSec = anchoredPosition(room.session, now);
      room.session.revision += 1;
      room.session.updatedAt = now;
      this.broadcast(room, { type: 'state', session: room.session });
    }
    const devices = this.refreshDevices(room, true, undefined, now);
    return this.snapshotFor(room, clientId, now, devices);
  }

  async command(userId: string, clientId: string, command: SessionCommand): Promise<CommandResult> {
    const room = this.rooms.get(userId);
    const now = this.nowFn();
    if (!room || !room.devices.has(clientId) || !this.isOnline(room, clientId, now)) {
      return { ok: false, error: 'unknown-client' };
    }
    if (!isSessionCommand(command)) return { ok: false, error: 'invalid-command' };

    const state = room.session;
    const target = state.target;
    const castTarget = target?.kind === 'cast' ? target.castId : null;
    const forwardsToCast =
      command.type === 'play' ||
      command.type === 'pause' ||
      command.type === 'toggle' ||
      command.type === 'seek' ||
      command.type === 'next' ||
      command.type === 'previous' ||
      command.type === 'stop' ||
      command.type === 'setCastVolume';
    if (castTarget && forwardsToCast && !this.castHooks) {
      return { ok: false, error: 'cast-disabled' };
    }

    const staleCleared = this.noteContact(room, clientId, now);
    room.lastActivity = now;

    if (command.type === 'transfer') return this.transfer(userId, room, clientId, command.target, now);
    if (command.type === 'takeOver') return this.takeOver(userId, room, clientId, command.castId, now);

    let mutated = false;
    let forward: SessionCommand | null = null;

    switch (command.type) {
      case 'play':
        this.freezePosition(state, now);
        state.playing = true;
        mutated = true;
        forward = { type: 'play' };
        break;
      case 'pause':
        this.freezePosition(state, now);
        state.playing = false;
        mutated = true;
        forward = { type: 'pause' };
        break;
      case 'toggle': {
        this.freezePosition(state, now);
        state.playing = !state.playing;
        mutated = true;
        forward = { type: state.playing ? 'play' : 'pause' };
        break;
      }
      case 'stop':
        // `stop` pauses only; `clear` is the queue-emptying command.
        this.freezePosition(state, now);
        state.playing = false;
        mutated = true;
        forward = { type: 'stop' };
        break;
      case 'clear':
        state.order = [];
        state.cursor = -1;
        state.positionSec = 0;
        state.playing = false;
        delete state.baseOrderIds;
        delete state.unavailable;
        // A cast target keeps the speaker (CastService observes the empty state);
        // a device target is simply stopped.
        if (state.target?.kind === 'device') state.target = null;
        mutated = true;
        break;
      case 'next': {
        const length = state.order.length;
        if (length === 0) break;
        const next = nextCursor(state.cursor, length, state.repeat, false);
        // At the end with repeat off there is nowhere to go: do not restart.
        if (next === state.cursor) break;
        state.cursor = next;
        state.positionSec = 0;
        state.playing = true;
        room.lastEndedEntryId = null;
        mutated = true;
        forward = { type: 'next' };
        break;
      }
      case 'previous': {
        const length = state.order.length;
        if (length === 0) break;
        const previous = previousCursor(state.cursor, length, anchoredPosition(state, now));
        state.cursor = previous.cursor;
        state.positionSec = 0;
        state.playing = true;
        room.lastEndedEntryId = null;
        mutated = true;
        forward = { type: 'previous' };
        break;
      }
      case 'seek': {
        if (state.cursor < 0 || !state.order[state.cursor]) {
          return { ok: false, error: 'invalid-command' };
        }
        const duration = state.order[state.cursor]?.durationSec;
        const position =
          duration && duration > 0 ? Math.min(command.positionSec, duration) : command.positionSec;
        state.positionSec = position;
        room.lastEndedEntryId = null;
        mutated = true;
        forward = { type: 'seek', positionSec: position };
        break;
      }
      case 'playEntry': {
        const index = state.order.findIndex((entry) => entry.entryId === command.entryId);
        if (index < 0) return { ok: false, error: 'entry-not-found' };
        state.cursor = index;
        state.positionSec = 0;
        state.playing = true;
        room.lastEndedEntryId = null;
        mutated = true;
        break;
      }
      case 'playIndex': {
        if (command.index >= state.order.length) return { ok: false, error: 'index-out-of-range' };
        state.cursor = command.index;
        state.positionSec = 0;
        state.playing = true;
        room.lastEndedEntryId = null;
        mutated = true;
        break;
      }
      case 'setQueue': {
        const order = command.order.map((entry) => ({ ...entry }));
        if (hasDuplicateIds(order)) return { ok: false, error: 'duplicate-entry-id' };
        if (order.length > SESSION_MAX_ENTRIES || orderByteLength(order) > SESSION_MAX_ORDER_BYTES) {
          return { ok: false, error: 'queue-too-large' };
        }
        if (order.length === 0 && command.baseOrderIds && command.baseOrderIds.length > 0) {
          return { ok: false, error: 'invalid-command' };
        }
        const clampedCursor = clampCursor(order.length, command.cursor);
        // Shuffle-play: the client sends the natural queue; the server owns the
        // play order. Capture the incoming current entry before shuffling so the
        // cursor still points at the same song afterwards.
        const currentEntryId = order[clampedCursor]?.entryId;
        let playOrder = order;
        let baseOrderIds: string[] | undefined;
        if (command.shuffle) {
          if (command.baseOrderIds) {
            if (!isPermutationOfOrder(command.baseOrderIds, order)) {
              return { ok: false, error: 'invalid-command' };
            }
            baseOrderIds = order.length > 0 ? [...command.baseOrderIds] : undefined;
          } else {
            // The incoming order is the natural order to restore later.
            baseOrderIds = order.length > 0 ? order.map((entry) => entry.entryId) : undefined;
          }
          playOrder = shuffled(order);
        }
        state.order = playOrder;
        state.shuffle = command.shuffle;
        state.baseOrderIds = baseOrderIds;
        state.cursor = currentEntryId
          ? playOrder.findIndex((entry) => entry.entryId === currentEntryId)
          : clampedCursor;
        if (state.cursor < 0) state.cursor = clampedCursor;
        state.positionSec = 0;
        state.playing = command.autoplay && state.cursor >= 0;
        delete state.unavailable;
        room.lastEndedEntryId = null;
        mutated = true;
        break;
      }
      case 'enqueue': {
        if (command.tracks.length === 0) return { ok: false, error: 'invalid-command' };
        if (command.tracks.length > MAX_ENQUEUE_TRACKS) return { ok: false, error: 'queue-too-large' };
        const additions = command.tracks.map((entry) => ({ ...entry }));
        if (hasDuplicateIds([...state.order, ...additions])) {
          return { ok: false, error: 'duplicate-entry-id' };
        }
        if (
          state.order.length + additions.length > SESSION_MAX_ENTRIES ||
          orderByteLength([...state.order, ...additions]) > SESSION_MAX_ORDER_BYTES
        ) {
          return { ok: false, error: 'queue-too-large' };
        }
        this.freezePosition(state, now);
        const at = command.next ? Math.max(0, state.cursor + 1) : state.order.length;
        const baseBefore = state.baseOrderIds
          ? [...state.baseOrderIds]
          : state.order.map((entry) => entry.entryId);
        state.order.splice(at, 0, ...additions);
        if (state.shuffle) {
          state.baseOrderIds = [...baseBefore, ...additions.map((entry) => entry.entryId)];
        }
        mutated = true;
        break;
      }
      case 'remove': {
        const index = state.order.findIndex((entry) => entry.entryId === command.entryId);
        if (index < 0) return { ok: false, error: 'entry-not-found' };
        this.freezePosition(state, now);
        const length = state.order.length;
        let cursor = state.cursor;
        let positionSec = state.positionSec;
        if (index === state.cursor) {
          const advanced = nextCursor(cursor, length, state.repeat, false);
          state.order.splice(index, 1);
          const newLength = state.order.length;
          if (newLength === 0) {
            cursor = -1;
            positionSec = 0;
            state.playing = false;
          } else if (advanced > index) {
            cursor = advanced - 1;
          } else if (advanced < index) {
            cursor = advanced;
          } else {
            // repeat off at the end: fall back to the new last entry.
            cursor = newLength - 1;
          }
          positionSec = 0;
          state.cursor = clampCursor(newLength, cursor);
          state.positionSec = positionSec;
        } else {
          state.order.splice(index, 1);
          if (index < state.cursor) state.cursor -= 1;
        }
        if (state.unavailable) {
          const filtered = state.unavailable.filter((entryId) => entryId !== command.entryId);
          state.unavailable = filtered.length > 0 ? filtered : undefined;
        }
        if (state.baseOrderIds) {
          const filtered = state.baseOrderIds.filter((entryId) => entryId !== command.entryId);
          state.baseOrderIds = filtered.length > 0 ? filtered : undefined;
        }
        if (state.cursor < 0 || !state.order[state.cursor]) state.positionSec = 0;
        mutated = true;
        break;
      }
      case 'move': {
        const length = state.order.length;
        if (command.from >= length || command.to >= length) {
          return { ok: false, error: 'index-out-of-range' };
        }
        if (command.from !== command.to) {
          this.freezePosition(state, now);
          const currentEntryId = state.order[state.cursor]?.entryId;
          const [moved] = state.order.splice(command.from, 1);
          if (!moved) return { ok: false, error: 'index-out-of-range' };
          state.order.splice(command.to, 0, moved);
          if (currentEntryId) {
            state.cursor = state.order.findIndex((entry) => entry.entryId === currentEntryId);
          }
          mutated = true;
        }
        break;
      }
      case 'replace': {
        const index = state.order.findIndex((entry) => entry.entryId === command.entryId);
        if (index < 0) return { ok: false, error: 'entry-not-found' };
        this.freezePosition(state, now);
        // Queue identity is the entryId; the command replaces the track on it.
        state.order[index] = { ...command.track, entryId: command.entryId };
        if (state.unavailable) {
          const filtered = state.unavailable.filter((entryId) => entryId !== command.entryId);
          state.unavailable = filtered.length > 0 ? filtered : undefined;
        }
        mutated = true;
        break;
      }
      case 'setShuffle': {
        if (command.shuffle === state.shuffle) break;
        this.freezePosition(state, now);
        const currentEntryId = state.order[state.cursor]?.entryId;
        if (command.shuffle) {
          state.baseOrderIds = state.order.map((entry) => entry.entryId);
          state.order = shuffled(state.order);
          state.shuffle = true;
        } else {
          const byId = new Map(state.order.map((entry) => [entry.entryId, entry]));
          const restored: SessionTrack[] = [];
          for (const entryId of state.baseOrderIds ?? []) {
            const entry = byId.get(entryId);
            if (!entry) continue;
            restored.push(entry);
            byId.delete(entryId);
          }
          for (const entry of state.order) {
            if (byId.has(entry.entryId)) {
              restored.push(entry);
              byId.delete(entry.entryId);
            }
          }
          state.order = restored;
          state.shuffle = false;
          delete state.baseOrderIds;
        }
        state.cursor = currentEntryId
          ? state.order.findIndex((entry) => entry.entryId === currentEntryId)
          : clampCursor(state.order.length, state.cursor);
        mutated = true;
        break;
      }
      case 'setRepeat': {
        if (command.repeat === state.repeat) break;
        this.freezePosition(state, now);
        state.repeat = command.repeat;
        mutated = true;
        break;
      }
      case 'setCastVolume': {
        if (state.target?.kind !== 'cast') return { ok: false, error: 'invalid-command' };
        this.freezePosition(state, now);
        state.castVolume = command.volume;
        mutated = true;
        forward = { type: 'setCastVolume', volume: command.volume };
        break;
      }
      default:
        return { ok: false, error: 'invalid-command' };
    }

    if (mutated) {
      state.updatedBy = clientId;
      this.commit(room, now);
    } else if (staleCleared) {
      // A no-op command from the stale target is still contact.
      state.updatedBy = clientId;
      this.commit(room, now);
    }

    // A structural command without a transport forward (queue/replace/clear)
    // must reach the speaker as a reload. The state is already committed, so a
    // transport failure must not turn the ack into an error.
    if (mutated && castTarget && !forward) {
      try {
        await this.castHooks?.onState?.(userId, castTarget, state);
      } catch {
        // CastService reports its own failures (unavailable + paused).
      }
    }

    if (forward && castTarget) {
      const hooks = this.castHooks;
      if (!hooks) return { ok: false, error: 'cast-disabled' };
      try {
        await hooks.onControl(userId, castTarget, forward);
      } catch (error) {
        return { ok: false, error: errorText(error, 'cast-unavailable') };
      }
    }
    return { ok: true, revision: state.revision };
  }

  /** `sourceId` = target clientId or castId; it becomes `SessionState.updatedBy`. */
  report(userId: string, sourceId: string, report: SessionReportMessage): void {
    const room = this.rooms.get(userId);
    if (!room) return;
    const target = room.session.target;
    if (!target) return;
    const fromTarget =
      (target.kind === 'device' && target.clientId === sourceId) ||
      (target.kind === 'cast' && target.castId === sourceId);
    if (!fromTarget) return;
    if (!isSessionReport(report)) return;

    const now = this.nowFn();
    const state = room.session;
    const staleCleared = this.noteContact(room, sourceId, now);
    room.lastActivity = now;

    switch (report.reason) {
      case 'tick': {
        // Observation only: move the anchor, never bump `revision` by itself.
        state.positionSec = report.positionSec;
        state.updatedAt = now;
        state.updatedBy = sourceId;
        if (staleCleared) {
          state.revision += 1;
          this.broadcast(room, { type: 'state', session: state });
          this.refreshDevices(room, true, undefined, now);
        }
        this.broadcast(room, {
          type: 'tick',
          revision: state.revision,
          positionSec: state.positionSec,
          playing: state.playing,
          updatedAt: now,
          ...(state.targetStale ? { targetStale: true } : {}),
        });
        return;
      }
      case 'playing': {
        state.positionSec = report.positionSec;
        state.updatedAt = now;
        state.updatedBy = sourceId;
        const flipped = state.playing !== report.playing;
        state.playing = report.playing;
        if (flipped || staleCleared) {
          state.revision += 1;
          this.broadcast(room, { type: 'state', session: state });
          this.refreshDevices(room, true, undefined, now);
        }
        return;
      }
      case 'ended': {
        const current = state.order[state.cursor];
        if (!current || report.entryId !== current.entryId) {
          this.commitStaleClear(room, now, staleCleared); // vanished / out of order
          return;
        }
        if (room.lastEndedEntryId === report.entryId && now - room.lastEndedAt < ENDED_DEDUPE_MS) {
          this.commitStaleClear(room, now, staleCleared); // the same end echoed twice
          return;
        }
        const length = state.order.length;
        if (state.repeat === 'one') {
          state.positionSec = 0;
          state.playing = true;
        } else if (state.cursor + 1 < length) {
          state.cursor += 1;
          state.positionSec = 0;
          state.playing = true;
        } else if (state.repeat === 'all') {
          state.cursor = 0;
          state.positionSec = 0;
          state.playing = true;
        } else {
          // Repeat off at the end: stop on the track's duration.
          const duration = report.durationSec ?? current.durationSec ?? report.positionSec;
          state.positionSec = duration;
          state.playing = false;
        }
        state.updatedAt = now;
        state.updatedBy = sourceId;
        state.revision += 1;
        room.lastEndedEntryId = report.entryId;
        room.lastEndedAt = now;
        this.broadcast(room, { type: 'state', session: state });
        this.refreshDevices(room, true, undefined, now);
        return;
      }
      case 'native-skip': {
        // Device targets only; a cast advances through CastService.
        if (target.kind !== 'device') return;
        const index = state.order.findIndex((entry) => entry.entryId === report.entryId);
        if (index < 0) {
          this.commitStaleClear(room, now, staleCleared); // entry vanished
          return;
        }
        state.cursor = index;
        state.positionSec = report.positionSec;
        state.playing = report.playing;
        state.updatedAt = now;
        state.updatedBy = sourceId;
        state.revision += 1;
        room.lastEndedEntryId = null;
        this.broadcast(room, { type: 'state', session: state });
        this.refreshDevices(room, true, undefined, now);
        return;
      }
      default:
        return;
    }
  }

  /** Entry ids the server/Cast cannot play (set by CastService after planning). */
  setUnavailable(userId: string, entryIds: readonly string[]): void {
    const room = this.rooms.get(userId);
    if (!room) return;
    const now = this.nowFn();
    const unique = Array.from(new Set(entryIds));
    room.session.unavailable = unique.length > 0 ? unique : undefined;
    room.session.updatedBy = null;
    room.session.positionSec = anchoredPosition(room.session, now);
    room.session.revision += 1;
    room.session.updatedAt = now;
    this.broadcast(room, { type: 'state', session: room.session });
  }

  /**
   * Marks the targeted cast stream as transcoded (a seek restarts the track on
   * the speaker) or clears the hint. Ignored unless this cast is the target, so
   * a release racing a transfer cannot write into the next session.
   */
  setCastSeekRestarts(userId: string, castId: string, value: boolean): void {
    const room = this.rooms.get(userId);
    if (!room) return;
    const target = room.session.target;
    if (target?.kind !== 'cast' || target.castId !== castId) return;
    const now = this.nowFn();
    if (value) room.session.castSeekRestarts = true;
    else delete room.session.castSeekRestarts;
    room.session.updatedBy = null;
    room.session.positionSec = anchoredPosition(room.session, now);
    room.session.revision += 1;
    room.session.updatedAt = now;
    this.broadcast(room, { type: 'state', session: room.session });
  }

  /** Another user took over a cast device: pause this room and clear the target. */
  castLost(userId: string, castId: string): void {
    const room = this.rooms.get(userId);
    if (!room) return;
    const target = room.session.target;
    if (target?.kind !== 'cast' || target.castId !== castId) return;
    const now = this.nowFn();
    const state = room.session;
    state.positionSec = anchoredPosition(state, now);
    state.playing = false;
    state.target = null;
    delete state.targetStale;
    delete state.castOwner;
    delete state.castSeekRestarts;
    state.updatedBy = null;
    state.revision += 1;
    state.updatedAt = now;
    room.lastActivity = now;
    this.broadcast(room, { type: 'state', session: state });
    this.refreshDevices(room, true, undefined, now);
  }

  devices(userId: string): SessionDevice[] {
    const room = this.rooms.get(userId);
    if (!room) return this.castRows();
    return this.refreshDevices(room, true);
  }

  snapshot(userId: string): SessionState | null {
    return this.rooms.get(userId)?.session ?? null;
  }

  /** Cast stream ended: advance with repeat rules and load the next entry. Rejects on load failure. */
  async castEnded(userId: string, castId: string): Promise<void> {
    const room = this.rooms.get(userId);
    if (!room) return;
    const target = room.session.target;
    if (target?.kind !== 'cast' || target.castId !== castId) return;
    const state = room.session;
    const current = state.order[state.cursor];
    if (!current) return;
    const now = this.nowFn();

    if (state.repeat === 'one') {
      state.positionSec = 0;
      state.playing = true;
    } else if (state.cursor + 1 < state.order.length) {
      state.cursor += 1;
      state.positionSec = 0;
      state.playing = true;
    } else if (state.repeat === 'all') {
      state.cursor = 0;
      state.positionSec = 0;
      state.playing = true;
    } else {
      state.positionSec = current.durationSec ?? 0;
      state.playing = false;
    }
    state.updatedBy = null;
    state.revision += 1;
    state.updatedAt = now;
    room.lastActivity = now;
    room.lastTargetContactAt = now;
    this.broadcast(room, { type: 'state', session: state });

    // Phase 5's CastService refines the load path (it owns the queue/plan). The
    // call is made even when repeat-off ends playback so CastService can tear
    // the receiver down; its rejection is the caller's ack.
    if (this.castHooks) await this.castHooks.onControl(userId, castId, { type: 'play' });
  }

  sweep(now: number): void {
    for (const [userId, room] of this.rooms) {
      // Presence of non-target clients: offline after 30 s, removed after 60 s.
      for (const [clientId, entry] of room.devices) {
        if (this.isTargetClient(room, clientId)) continue;
        if (this.hasConnection(room, clientId)) continue;
        if (now - entry.lastSeenAt > PRESENCE_REMOVE_MS) room.devices.delete(clientId);
      }

      const target = room.session.target;
      if (target?.kind === 'device') {
        const silence = now - room.lastTargetContactAt;
        if (silence >= this.targetStaleMs) {
          // Stale-timeout cleanup: pause, clamp, clear. Playback is never
          // paused merely because reports stopped before this point.
          const state = room.session;
          const duration = state.order[state.cursor]?.durationSec;
          const position = anchoredPosition(state, now);
          state.positionSec = duration && duration > 0 ? Math.min(position, duration) : position;
          state.playing = false;
          state.target = null;
          delete state.targetStale;
          state.updatedBy = null;
          state.revision += 1;
          state.updatedAt = now;
          room.lastActivity = now;
          this.broadcast(room, { type: 'state', session: state });
        } else if (silence >= this.targetStaleAfterMs && room.session.targetStale !== true) {
          const state = room.session;
          state.targetStale = true;
          state.positionSec = anchoredPosition(state, now);
          state.revision += 1;
          state.updatedAt = now;
          this.broadcast(room, { type: 'state', session: state });
        }
      }

      this.refreshDevices(room, true, undefined, now);

      const castTarget = room.session.target?.kind === 'cast';
      if (
        !castTarget &&
        room.devices.size === 0 &&
        room.connections.size === 0 &&
        now - room.lastActivity >= this.idleTimeoutMs
      ) {
        this.rooms.delete(userId);
      }
    }
  }

  dispose(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    for (const room of this.rooms.values()) {
      for (const connection of room.connections.values()) this.closeQuietly(connection);
    }
    this.rooms.clear();
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private roomFor(userId: string, now: number): Room {
    let room = this.rooms.get(userId);
    if (!room) {
      room = {
        session: defaultState(now),
        devices: new Map(),
        connections: new Map(),
        devicesRevision: 0,
        devicesSignature: '',
        lastActivity: now,
        lastTargetContactAt: now,
        lastEndedEntryId: null,
        lastEndedAt: 0,
      };
      this.rooms.set(userId, room);
    }
    return room;
  }

  private async transfer(
    userId: string,
    room: Room,
    clientId: string,
    target: SessionTargetPayload,
    now: number,
  ): Promise<CommandResult> {
    if (target.kind === 'device') {
      if (!room.devices.has(target.clientId) || !this.isOnline(room, target.clientId, now)) {
        return { ok: false, error: 'unknown-client' };
      }
      const device = room.devices.get(target.clientId);
      if (!device) return { ok: false, error: 'unknown-client' };
      if (room.session.target?.kind === 'device' && room.session.target.clientId === target.clientId) {
        if (room.session.targetStale) {
          this.freezePosition(room.session, now);
          delete room.session.targetStale;
          this.commit(room, now);
        }
        return { ok: true, revision: room.session.revision };
      }

      // Pausing the previous target: a cast speaker must be stopped explicitly;
      // a device target has no separate playback to stop.
      const previousCastId =
        room.session.target?.kind === 'cast' ? room.session.target.castId : null;
      if (previousCastId && this.castHooks) {
        const requester = this.deviceRow(room, clientId, now);
        if (!requester) return { ok: false, error: 'unknown-client' };
        try {
          await this.castHooks.onTarget(userId, requester, previousCastId, null);
        } catch (error) {
          return { ok: false, error: errorText(error, 'cast-unavailable') };
        }
      }

      const state = room.session;
      state.target = { kind: 'device', clientId: target.clientId, deviceId: device.deviceId };
      state.positionSec = anchoredPosition(state, now);
      delete state.targetStale;
      delete state.castOwner;
      delete state.castVolume;
      state.updatedBy = clientId;
      state.updatedAt = now;
      state.revision += 1;
      room.lastTargetContactAt = now;
      room.lastActivity = now;
      this.broadcast(room, { type: 'state', session: state });
      this.refreshDevices(room, true, undefined, now);
      return { ok: true, revision: state.revision };
    }

    return this.transferToCast(userId, room, clientId, target.castId, now, false);
  }

  private async takeOver(
    userId: string,
    room: Room,
    clientId: string,
    castId: string,
    now: number,
  ): Promise<CommandResult> {
    return this.transferToCast(userId, room, clientId, castId, now, true);
  }

  private async transferToCast(
    userId: string,
    room: Room,
    clientId: string,
    castId: string,
    now: number,
    force: boolean,
  ): Promise<CommandResult> {
    const hooks = this.castHooks;
    if (!hooks) return { ok: false, error: 'cast-disabled' };
    const castOnline = hooks.devices().some((device) => {
      if (device.platform !== 'cast' || device.online === false) return false;
      return device.castId === castId || device.id === castId;
    });
    if (!castOnline) return { ok: false, error: 'cast-unavailable' };
    const requester = this.deviceRow(room, clientId, now);
    if (!requester) return { ok: false, error: 'unknown-client' };

    const previous = room.session;
    const previousCastId = previous.target?.kind === 'cast' ? previous.target.castId : null;
    const next = cloneState(previous);
    next.target = { kind: 'cast', castId };
    next.positionSec = anchoredPosition(previous, now);
    next.updatedBy = clientId;
    next.updatedAt = now;
    next.revision = previous.revision + 1;
    delete next.targetStale;
    delete next.castOwner;

    try {
      await hooks.onTarget(
        userId,
        requester,
        previousCastId,
        { castId, state: next },
        force ? { force: true } : undefined,
      );
    } catch (error) {
      if (error instanceof CastBusyError) {
        previous.castOwner = {
          deviceId: error.owner.deviceId,
          deviceName: error.owner.deviceName,
        };
        previous.positionSec = anchoredPosition(previous, now);
        previous.revision += 1;
        previous.updatedAt = now;
        this.broadcast(room, { type: 'state', session: previous });
        this.refreshDevices(room, true, undefined, now);
        return { ok: false, error: 'cast-busy' };
      }
      // The previous target stays untouched on any other hook rejection.
      return { ok: false, error: errorText(error, 'cast-unavailable') };
    }

    room.session = next;
    room.lastTargetContactAt = now;
    room.lastActivity = now;
    this.broadcast(room, { type: 'state', session: next });
    this.refreshDevices(room, true, undefined, now);
    return { ok: true, revision: next.revision };
  }

  private freezePosition(state: SessionState, now: number): void {
    state.positionSec = anchoredPosition(state, now);
    state.updatedAt = now;
  }

  private commit(room: Room, now: number): void {
    room.session.revision += 1;
    room.session.updatedAt = now;
    room.lastActivity = now;
    this.broadcast(room, { type: 'state', session: room.session });
    this.refreshDevices(room, true, undefined, now);
  }

  /** Contact that cleared `targetStale` still needs its revision bump when no other change happened. */
  private commitStaleClear(room: Room, now: number, staleCleared: boolean): void {
    if (!staleCleared) return;
    room.session.positionSec = anchoredPosition(room.session, now);
    room.session.revision += 1;
    room.session.updatedAt = now;
    this.broadcast(room, { type: 'state', session: room.session });
    this.refreshDevices(room, true, undefined, now);
  }

  private noteContact(room: Room, sourceId: string, now: number): boolean {
    const device = room.devices.get(sourceId);
    if (device) device.lastSeenAt = now;
    const target = room.session.target;
    const fromTarget =
      (target?.kind === 'device' && target.clientId === sourceId) ||
      (target?.kind === 'cast' && target.castId === sourceId);
    if (!fromTarget) return false;
    room.lastTargetContactAt = now;
    if (room.session.targetStale) {
      delete room.session.targetStale;
      return true;
    }
    return false;
  }

  private isOnline(room: Room, clientId: string, now: number): boolean {
    const device = room.devices.get(clientId);
    if (!device) return false;
    if (this.hasConnection(room, clientId)) return true;
    if (this.isTargetClient(room, clientId)) return true;
    return now - device.lastSeenAt <= PRESENCE_ONLINE_MS;
  }

  private isTargetClient(room: Room, clientId: string): boolean {
    const target = room.session.target;
    return target?.kind === 'device' && target.clientId === clientId;
  }

  private hasConnection(room: Room, clientId: string): boolean {
    for (const connection of room.connections.values()) {
      if (connection.clientId === clientId) return true;
    }
    return false;
  }

  private deviceRow(room: Room, clientId: string, now: number): SessionDevice | null {
    const entry = room.devices.get(clientId);
    if (!entry) return null;
    return {
      id: clientId,
      deviceId: entry.deviceId,
      name: entry.name,
      platform: entry.platform,
      online: this.isOnline(room, clientId, now),
      ...(this.isTargetClient(room, clientId) && room.session.targetStale ? { stale: true } : {}),
      lastSeenAt: entry.lastSeenAt,
      ...(entry.model ? { model: entry.model } : {}),
      capabilities: { ...entry.capabilities },
    };
  }

  private devicesFor(room: Room, now: number): SessionDevice[] {
    const rows: SessionDevice[] = [];
    for (const clientId of room.devices.keys()) {
      const row = this.deviceRow(room, clientId, now);
      if (row) rows.push(row);
    }
    for (const cast of this.castRows()) rows.push(cast);
    return rows;
  }

  private castRows(): SessionDevice[] {
    const hooks = this.castHooks;
    if (!hooks) return [];
    return hooks.devices().map((device) => ({ ...device, platform: 'cast' }));
  }

  private refreshDevices(
    room: Room,
    broadcast: boolean,
    exceptConnectionId?: string,
    now = this.nowFn(),
  ): SessionDevice[] {
    const rows = this.devicesFor(room, now);
    const signature = JSON.stringify(
      rows.map((device) => [
        device.id,
        device.deviceId,
        device.name,
        device.platform,
        device.online,
        device.stale === true,
        device.castId ?? '',
        device.model ?? '',
        device.capabilities.cast,
        device.capabilities.localFiles,
      ]),
    );
    if (signature !== room.devicesSignature) {
      room.devicesSignature = signature;
      room.devicesRevision += 1;
      if (broadcast) {
        this.broadcast(
          room,
          { type: 'devices', devices: rows, devicesRevision: room.devicesRevision },
          exceptConnectionId,
        );
      }
    }
    return rows;
  }

  private snapshotFor(
    room: Room,
    clientId: string,
    now: number,
    devices?: SessionDevice[],
  ): SessionSnapshot {
    const device = room.devices.get(clientId);
    return {
      serverTime: now,
      clientId,
      deviceId: device?.deviceId ?? '',
      devicesRevision: room.devicesRevision,
      session: room.session,
      devices: devices ?? this.devicesFor(room, now),
    };
  }

  private broadcast(room: Room, message: SessionServerMessage, exceptConnectionId?: string): void {
    for (const connection of room.connections.values()) {
      if (connection.id === exceptConnectionId) continue;
      try {
        connection.send(message);
      } catch {
        // A broken socket is removed by its own `leave`/reconnect.
      }
    }
  }

  private closeQuietly(connection: SessionConnection): void {
    try {
      connection.close?.();
    } catch {
      // Closing a dead socket is already done.
    }
  }
}

type SessionTargetPayload = Extract<SessionCommand, { type: 'transfer' }>['target'];
