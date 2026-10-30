// Server-side Cast player: owns one transport per targeted speaker, plans the
// queue through the relay and keeps `SessionService` reconciled with the
// receiver. Everything here is per-cast and serialised: a `takeOver` racing a
// `transfer` must resolve in a deterministic order.

import {
  anchoredPosition,
  type SessionCommand,
  type SessionDevice,
  type SessionReportMessage,
  type SessionState,
  type SessionTrack,
} from '@open-record/models';
import type { ServerConfig } from '../config';
import type { CastDiscovery, DiscoveredCast } from './cast-discovery';
import type { CastStatus, CastTransport } from './cast-transport';
import { createCastTransport } from './cast-transport';
import { planFor, type MediaPlan } from './media-plan';
import type { MediaRelay } from './media-relay';
import { CastBusyError, type SessionService } from './session';

/** A dropped speaker stays listed as offline for this long before its target clears. */
export const CAST_LOST_GRACE_MS = 20_000;
/** Position-only reports are at most one per this window. */
const CAST_TICK_REPORT_MS = 2_000;
const DEFAULT_CONTENT_TYPE = 'audio/mp4';

export interface CastServiceOptions {
  relay: MediaRelay;
  discovery: CastDiscovery;
  config: ServerConfig;
  /** Test seam; defaults to `createCastTransport`. */
  transportFactory?: () => CastTransport;
  /** Test seam for the clock used by anchoring/report throttling. */
  now?: () => number;
}

interface CastConnection {
  castId: string;
  userId: string;
  ownerDeviceId: string;
  ownerDeviceName: string;
  transport: CastTransport;
  host: string;
  port: number;
  /** Queue entry currently loaded on the receiver (null when nothing is). */
  entryId: string | null;
  /** Content identity of the loaded entry (see `entryKey`). */
  loadKey: string | null;
  /** Relay entry backing the loaded URL, renewed on every load. */
  relayId: string | null;
  /** Monotonic load counter: one FINISHED event may advance exactly one load. */
  loadSeq: number;
  idleHandledFor: number;
  lastPlaying: boolean;
  lastTickAt: number;
  offline: boolean;
  disconnectTimer: NodeJS.Timeout | null;
  pollTimer: NodeJS.Timeout | null;
  polling: boolean;
  offStatus: (() => void) | null;
  offDisconnect: (() => void) | null;
}

/**
 * Identity of the media a queue entry points at. `entryId` alone survives a
 * `replace`, so the content fields force a reload; `setShuffle` keeps every
 * field and must not.
 */
function entryKey(entry: SessionTrack): string {
  return JSON.stringify([
    entry.entryId,
    entry.id,
    entry.providerId,
    entry.source?.url,
    entry.catalogFile,
    entry.uploadId,
    entry.local,
  ]);
}

/** `upload` is unavailable until Phase 6 wires the relay upload route. */
function isPlayable(plan: MediaPlan): boolean {
  return plan.kind === 'catalog' || plan.kind === 'remote';
}

function contentTypeFor(plan: MediaPlan): string {
  if (plan.kind !== 'catalog') return DEFAULT_CONTENT_TYPE;
  switch (plan.file.slice(plan.file.lastIndexOf('.') + 1).toLowerCase()) {
    case 'mp3':
      return 'audio/mpeg';
    case 'm4a':
    case 'aac':
      return 'audio/mp4';
    case 'ogg':
    case 'opus':
      return 'audio/ogg';
    case 'flac':
      return 'audio/flac';
    case 'wav':
      return 'audio/wav';
    default:
      return DEFAULT_CONTENT_TYPE;
  }
}

function errorText(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error);
}

function reportFor(
  reason: SessionReportMessage['reason'],
  entryId: string,
  status: CastStatus,
): SessionReportMessage {
  return {
    type: 'report',
    reason,
    entryId,
    positionSec: Math.max(0, status.positionSec),
    playing: status.playing,
    ...(status.durationSec !== undefined ? { durationSec: status.durationSec } : {}),
  };
}

export class CastService {
  private readonly relay: MediaRelay;
  private readonly discovery: CastDiscovery;
  private readonly config: ServerConfig;
  private readonly transportFactory: () => CastTransport;
  private readonly now: () => number;
  private readonly casts = new Map<string, CastConnection>();
  private readonly offline = new Set<string>();
  /** Per-cast operation queues; `castEnded` is deliberately never inside one. */
  private readonly chains = new Map<string, Promise<void>>();
  private sessions: SessionService | null = null;
  private onLostListener: ((ownerUserId: string, castId: string) => void) | null = null;

  constructor(opts: CastServiceOptions) {
    this.relay = opts.relay;
    this.discovery = opts.discovery;
    this.config = opts.config;
    this.transportFactory = opts.transportFactory ?? createCastTransport;
    this.now = opts.now ?? Date.now;
    if (opts.config.castMediaBaseUrl === null) {
      throw new Error('cast service requires CAST_MEDIA_BASE_URL');
    }
  }

  /** Late wiring: the session needs the cast service and vice versa. */
  setSession(sessions: SessionService): void {
    this.sessions = sessions;
  }

  /** Another user forced this cast away from `ownerUserId`. */
  setOnLost(listener: (ownerUserId: string, castId: string) => void): void {
    this.onLostListener = listener;
  }

  devices(): SessionDevice[] {
    if (!this.config.castEnabled || this.config.castMediaBaseUrl === null) return [];
    const now = this.now();
    return this.discovery.list().map((cast) => {
      const row: SessionDevice = {
        id: cast.castId,
        deviceId: cast.castId,
        name: cast.name,
        platform: 'cast',
        online: !this.offline.has(cast.castId),
        lastSeenAt: now,
        castId: cast.castId,
        capabilities: { cast: true, localFiles: false },
      };
      if (cast.model !== undefined) row.model = cast.model;
      return row;
    });
  }

  /** `SessionCastHooks.onTarget`; `next === null` stops the previous cast. */
  async setTarget(
    userId: string,
    requester: SessionDevice,
    previousCastId: string | null,
    next: { castId: string; state: SessionState } | null,
    opts: { force?: boolean } = {},
  ): Promise<void> {
    if (next === null) {
      if (!previousCastId) return;
      await this.enqueue(previousCastId, async () => {
        const conn = this.casts.get(previousCastId);
        if (!conn || conn.userId !== userId) return;
        await this.release(conn, { stop: true });
      });
      return;
    }

    await this.enqueue(next.castId, () =>
      this.startTarget(userId, requester, next.castId, next.state, opts.force === true),
    );
    // Moving from one speaker to another: the old one must go silent, but only
    // after the new target has loaded (a failed transfer keeps the old one).
    if (previousCastId && previousCastId !== next.castId) {
      await this.enqueue(previousCastId, async () => {
        const previous = this.casts.get(previousCastId);
        if (previous?.userId === userId) await this.release(previous, { stop: true });
      });
    }
  }

  /** `SessionCastHooks.onControl`. */
  async control(userId: string, castId: string, command: SessionCommand): Promise<void> {
    await this.enqueue(castId, async () => {
      const conn = this.casts.get(castId);
      if (!conn || conn.userId !== userId) return;
      const sessions = this.sessions;
      if (!sessions) return;
      const state = sessions.snapshot(userId);
      if (!state || state.target?.kind !== 'cast' || state.target.castId !== castId) return;
      await this.applyControl(conn, state, command);
    });
  }

  async setVolume(castId: string, volume: number): Promise<void> {
    await this.enqueue(castId, async () => {
      const conn = this.casts.get(castId);
      if (!conn) return;
      await conn.transport.setVolume(volume);
    });
  }

  /** `SessionCastHooks.onState`: structural commands reload the receiver. */
  async sync(userId: string, castId: string, state: SessionState): Promise<void> {
    await this.enqueue(castId, async () => {
      const conn = this.casts.get(castId);
      if (!conn || conn.userId !== userId) return;
      const sessions = this.sessions;
      if (!sessions) return;
      const current = sessions.snapshot(userId);
      if (!current || current.target?.kind !== 'cast' || current.target.castId !== castId) return;

      const entry = state.cursor >= 0 ? state.order[state.cursor] : undefined;
      if (!entry) {
        try {
          await conn.transport.stop();
        } catch {
          // Receiver gone; the disconnect path owns cleanup.
        }
        conn.entryId = null;
        conn.loadKey = null;
        return;
      }
      if (conn.entryId === entry.entryId && conn.loadKey === entryKey(entry)) {
        // Same media, but a paused queue replace (autoplay=false) must silence
        // the speaker without reloading the track.
        if (!state.playing && conn.transport.status()?.playing) {
          try {
            await conn.transport.pause();
          } catch {
            // The disconnect path owns a gone receiver.
          }
        }
        return;
      }

      try {
        await this.reload(conn, state, entry, anchoredPosition(state, this.now()), state.playing);
      } catch {
        // `reload` already marked the entry unavailable, paused and reported.
      }
    });
  }

  dispose(): void {
    for (const conn of this.casts.values()) {
      if (conn.pollTimer) {
        clearInterval(conn.pollTimer);
        conn.pollTimer = null;
      }
      if (conn.disconnectTimer) {
        clearTimeout(conn.disconnectTimer);
        conn.disconnectTimer = null;
      }
      conn.offStatus?.();
      conn.offDisconnect?.();
      void conn.transport.close().catch(() => undefined);
    }
    this.casts.clear();
    this.chains.clear();
    this.offline.clear();
  }

  // -------------------------------------------------------------------------
  // Target lifecycle
  // -------------------------------------------------------------------------

  private async startTarget(
    userId: string,
    requester: SessionDevice,
    castId: string,
    state: SessionState,
    force: boolean,
  ): Promise<void> {
    const existing = this.casts.get(castId);
    if (existing && existing.userId !== userId && !force) {
      throw new CastBusyError({
        userId: existing.userId,
        deviceId: existing.ownerDeviceId,
        deviceName: existing.ownerDeviceName,
      });
    }
    if (!this.findDiscovered(castId)) throw new Error('cast-unavailable');

    // Plan every entry first so controllers can mark the whole queue. This must
    // not call `sessions.setUnavailable`: `transferToCast` has not committed the
    // clone yet and the update would be written to the previous state.
    const plans = new Map<string, MediaPlan>();
    const unavailable: string[] = [];
    for (const entry of state.order) {
      const plan = await planFor(entry, { webDir: this.config.webDir });
      plans.set(entry.entryId, plan);
      if (!isPlayable(plan)) unavailable.push(entry.entryId);
    }
    if (unavailable.length > 0) state.unavailable = unavailable;
    else delete state.unavailable;

    const entry = state.cursor >= 0 ? state.order[state.cursor] : undefined;
    const plan = entry ? plans.get(entry.entryId) : undefined;
    if (entry && (!plan || !isPlayable(plan))) throw new Error('unavailable');

    if (existing && existing.userId !== userId) {
      // Force: stop the old receiver before the new owner takes it over.
      await this.release(existing, { stop: true });
      this.onLostListener?.(existing.userId, castId);
    }

    const { conn, created } = await this.ensureConnection(castId, userId, requester);
    try {
      if (!entry || !plan) {
        await conn.transport.stop();
        return;
      }
      await this.applyVolume(conn, state);
      await this.startEntry(conn, entry, plan, Math.max(0, state.positionSec), state.playing);
      // The receiver is the authority once media is loaded.
      const reported = conn.transport.status()?.volume;
      if (reported !== undefined) state.castVolume = reported;
    } catch (error) {
      // A transfer that failed must not keep the speaker locked for this user.
      if (created) await this.release(conn, { stop: true });
      throw error;
    }
  }

  /** Reuses the speaker's transport for the same owner; reconnects otherwise. */
  private async ensureConnection(
    castId: string,
    userId: string,
    requester: SessionDevice,
  ): Promise<{ conn: CastConnection; created: boolean }> {
    const existing = this.casts.get(castId);
    if (existing && existing.userId === userId) {
      const row = this.findDiscovered(castId);
      if (row && !existing.offline && existing.host === row.host && existing.port === row.port) {
        return { conn: existing, created: false };
      }
      await this.release(existing, { stop: true });
    } else if (existing) {
      throw new CastBusyError({
        userId: existing.userId,
        deviceId: existing.ownerDeviceId,
        deviceName: existing.ownerDeviceName,
      });
    }

    const row = this.findDiscovered(castId);
    if (!row) throw new Error('cast-unavailable');

    const transport = this.transportFactory();
    const conn: CastConnection = {
      castId,
      userId,
      ownerDeviceId: requester.deviceId || requester.id,
      ownerDeviceName: requester.name,
      transport,
      host: row.host,
      port: row.port,
      entryId: null,
      loadKey: null,
      relayId: null,
      loadSeq: 0,
      idleHandledFor: 0,
      lastPlaying: false,
      lastTickAt: this.now(),
      offline: false,
      disconnectTimer: null,
      pollTimer: null,
      polling: false,
      offStatus: null,
      offDisconnect: null,
    };
    conn.offStatus = transport.onStatus((status) => this.handleStatus(conn, status));
    conn.offDisconnect = transport.onDisconnect(() => this.handleDisconnect(conn));

    try {
      await transport.connect(row.host, row.port);
    } catch (error) {
      conn.offStatus();
      conn.offDisconnect();
      await transport.close().catch(() => undefined);
      throw error;
    }

    this.casts.set(castId, conn);
    this.offline.delete(castId);
    // The receiver pushes MEDIA_STATUS only on changes; without a poll the
    // server anchor would stay at the load position forever.
    conn.pollTimer = setInterval(() => void this.pollStatus(conn), 2_000);
    conn.pollTimer.unref();
    return { conn, created: true };
  }

  /** Stops/closes a connection and releases this user's lock on the speaker. */
  private async release(conn: CastConnection, opts: { stop: boolean }): Promise<void> {
    if (conn.pollTimer) {
      clearInterval(conn.pollTimer);
      conn.pollTimer = null;
    }
    if (conn.disconnectTimer) {
      clearTimeout(conn.disconnectTimer);
      conn.disconnectTimer = null;
    }
    conn.offStatus?.();
    conn.offStatus = null;
    conn.offDisconnect?.();
    conn.offDisconnect = null;
    if (this.casts.get(conn.castId) === conn) this.casts.delete(conn.castId);
    if (opts.stop) {
      try {
        await conn.transport.stop();
      } catch {
        // The receiver may already be gone.
      }
    }
    try {
      await conn.transport.close();
    } catch {
      // Closing an already closed socket is not an error for the session.
    }
  }

  // -------------------------------------------------------------------------
  // Playback
  // -------------------------------------------------------------------------

  private async applyVolume(conn: CastConnection, state: SessionState): Promise<void> {
    if (state.castVolume !== undefined) await conn.transport.setVolume(state.castVolume);
    const reported = conn.transport.status()?.volume;
    if (reported !== undefined) state.castVolume = reported;
  }

  private async startEntry(
    conn: CastConnection,
    entry: SessionTrack,
    plan: MediaPlan,
    startSec: number,
    autoplay: boolean,
  ): Promise<void> {
    const relay = this.relay.create({ userId: conn.userId, trackId: entry.id, plan });
    conn.relayId = relay.id;
    conn.entryId = entry.entryId;
    conn.loadKey = entryKey(entry);
    conn.loadSeq += 1;
    // Start from `false` so the first PLAYING broadcast is reported: without
    // it the server anchor stays at 0 until the receiver drifts, and
    // controllers see a stuck position.
    conn.lastPlaying = false;
    conn.lastTickAt = this.now();
    await conn.transport.load(
      {
        url: relay.url,
        contentType: contentTypeFor(plan),
        title: entry.title,
        artist: entry.artist,
        ...(entry.artUrl !== undefined ? { artUrl: entry.artUrl } : {}),
        ...(entry.durationSec !== undefined ? { durationSec: entry.durationSec } : {}),
      },
      { startSec: Math.max(0, startSec), autoplay },
    );
  }

  /** Plans, mints and loads one entry; on failure marks it unavailable and pauses. */
  private async reload(
    conn: CastConnection,
    state: SessionState,
    entry: SessionTrack,
    startSec: number,
    autoplay: boolean,
  ): Promise<void> {
    const plan = await planFor(entry, { webDir: this.config.webDir });
    if (!isPlayable(plan)) {
      await this.failEntry(conn, state, entry.entryId, new Error('unavailable'));
      throw new Error('unavailable');
    }
    try {
      await this.startEntry(conn, entry, plan, startSec, autoplay);
    } catch (error) {
      await this.failEntry(conn, state, entry.entryId, error);
      throw error;
    }
  }

  private async failEntry(
    conn: CastConnection,
    state: SessionState | null,
    entryId: string,
    error: unknown,
  ): Promise<void> {
    console.warn(`[cast] ${conn.castId}: cannot play ${entryId} (${errorText(error)})`);
    const sessions = this.sessions;
    if (!sessions) return;
    const unavailable = new Set(state?.unavailable ?? []);
    unavailable.add(entryId);
    sessions.setUnavailable(conn.userId, [...unavailable]);
    sessions.report(conn.userId, conn.castId, {
      type: 'report',
      reason: 'playing',
      entryId,
      positionSec: state ? Math.max(0, anchoredPosition(state, this.now())) : 0,
      playing: false,
    });
    try {
      await conn.transport.pause();
    } catch {
      // Nothing to pause when the load never produced media.
    }
  }

  private async applyControl(
    conn: CastConnection,
    state: SessionState,
    command: SessionCommand,
  ): Promise<void> {
    const entry = state.cursor >= 0 ? state.order[state.cursor] : undefined;

    switch (command.type) {
      case 'play': {
        // Repeat-off end: `castEnded` leaves the speaker finished and asks for
        // `play`, which must tear the receiver down instead of restarting.
        if (!state.playing) {
          await conn.transport.stop();
          return;
        }
        if (!entry) {
          await conn.transport.stop();
          return;
        }
        const idle = conn.transport.status()?.idle === true;
        const changed = conn.entryId !== entry.entryId || conn.loadKey !== entryKey(entry);
        const relayAlive = conn.relayId !== null && this.relay.touch(conn.relayId);
        if (idle || changed || !relayAlive) {
          await this.reload(conn, state, entry, anchoredPosition(state, this.now()), true);
        } else {
          await conn.transport.play();
        }
        return;
      }
      case 'pause':
      case 'stop':
        await conn.transport.pause();
        return;
      case 'seek':
        await conn.transport.seek(command.positionSec);
        return;
      case 'next':
      case 'previous':
        if (!entry) {
          await conn.transport.stop();
          return;
        }
        // `SessionService` already moved the cursor; load the new entry.
        await this.reload(conn, state, entry, 0, state.playing);
        return;
      case 'setCastVolume':
        await conn.transport.setVolume(command.volume);
        return;
      default:
        // Structural commands arrive through `onState` and `sync`.
        return;
    }
  }

  // -------------------------------------------------------------------------
  // Status, idle and disconnects
  // -------------------------------------------------------------------------

  private async pollStatus(conn: CastConnection): Promise<void> {
    if (this.casts.get(conn.castId) !== conn || conn.offline || conn.polling) return;
    conn.polling = true;
    try {
      const status = await conn.transport.getStatus();
      if (status) this.handleStatus(conn, status);
    } catch {
      // A missed poll is not a disconnect; the heartbeat owns that signal.
    } finally {
      conn.polling = false;
    }
  }

  private handleStatus(conn: CastConnection, status: CastStatus): void {
    if (this.casts.get(conn.castId) !== conn || conn.offline) return;
    if (conn.relayId) this.relay.touch(conn.relayId);

    if (status.idle) {
      this.handleIdle(conn);
      return;
    }

    const sessions = this.sessions;
    if (!sessions) return;
    const state = sessions.snapshot(conn.userId);
    if (!state || state.target?.kind !== 'cast' || state.target.castId !== conn.castId) return;
    const entryId =
      conn.entryId ?? (state.cursor >= 0 ? state.order[state.cursor]?.entryId : undefined);
    if (!entryId) return;

    if (status.playing !== conn.lastPlaying) {
      conn.lastPlaying = status.playing;
      conn.lastTickAt = this.now();
      sessions.report(conn.userId, conn.castId, reportFor('playing', entryId, status));
      return;
    }

    // The receiver pushes status only on changes, but controllers extrapolate
    // from the server anchor. A periodic tick keeps that anchor at the real
    // position (and keeps `positionSec` from sitting at the load point).
    if (!status.playing) return;
    const now = this.now();
    if (now - conn.lastTickAt < CAST_TICK_REPORT_MS) return;
    conn.lastTickAt = now;
    sessions.report(conn.userId, conn.castId, reportFor('tick', entryId, status));
  }

  private handleIdle(conn: CastConnection): void {
    // One FINISHED event advances exactly one load, even when repeat keeps the
    // same entry (the load counter changes on every reload).
    if (conn.idleHandledFor === conn.loadSeq) return;
    conn.idleHandledFor = conn.loadSeq;
    void this.processIdle(conn);
  }

  /**
   * Runs outside the per-cast chain: `castEnded` calls `onControl('play')`,
   * which enqueues, so awaiting it inside the chain would deadlock.
   */
  private async processIdle(conn: CastConnection): Promise<void> {
    const sessions = this.sessions;
    if (!sessions) return;
    const entryId = conn.entryId;
    try {
      await sessions.castEnded(conn.userId, conn.castId);
    } catch (error) {
      const state = sessions.snapshot(conn.userId);
      const current = state && state.cursor >= 0 ? state.order[state.cursor] : undefined;
      const failedEntryId = current?.entryId ?? entryId;
      if (!failedEntryId) return;
      // The `play` that `castEnded` forwarded may already have marked it.
      if (state?.unavailable?.includes(failedEntryId)) return;
      await this.failEntry(conn, state, failedEntryId, error);
    }
  }

  private handleDisconnect(conn: CastConnection): void {
    if (this.casts.get(conn.castId) !== conn || conn.offline) return;
    conn.offline = true;
    this.offline.add(conn.castId);
    conn.disconnectTimer = setTimeout(() => {
      conn.disconnectTimer = null;
      this.finalizeDisconnect(conn);
    }, CAST_LOST_GRACE_MS);
    conn.disconnectTimer.unref?.();
  }

  private finalizeDisconnect(conn: CastConnection): void {
    if (this.casts.get(conn.castId) !== conn) return;
    if (conn.pollTimer) {
      clearInterval(conn.pollTimer);
      conn.pollTimer = null;
    }
    this.casts.delete(conn.castId);
    conn.offStatus?.();
    conn.offStatus = null;
    conn.offDisconnect?.();
    conn.offDisconnect = null;
    try {
      this.sessions?.castLost(conn.userId, conn.castId);
    } catch {
      // Clearing an already-cleared target is a no-op.
    }
    void conn.transport.close().catch(() => undefined);
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private enqueue<T>(castId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(castId) ?? Promise.resolve();
    const run = previous.then(task, task);
    this.chains.set(
      castId,
      run.then(
        () => undefined,
        () => undefined,
      ),
    );
    return run;
  }

  private findDiscovered(castId: string): DiscoveredCast | undefined {
    return this.discovery.list().find((cast) => cast.castId === castId);
  }
}
