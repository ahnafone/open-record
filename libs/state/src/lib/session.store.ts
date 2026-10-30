import {
  DestroyRef,
  Injectable,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import {
  REPORT_KEEPALIVE_MS,
  REPORT_THROTTLE_MS,
  anchoredPosition,
  clampCursor,
  isThisClient,
  newClientId,
  newEntryId,
  type CommandResult,
  type SessionCommand,
  type SessionDevice,
  type SessionEntry,
  type SessionReportMessage,
  type SessionServerMessage,
  type SessionState,
  type SessionTarget,
  type SessionTrack,
  type Track,
} from '@open-record/models';
import { PlayerService } from '@open-record/player';
import type { PlayerStatus, RepeatMode } from '@open-record/player';
import { AuthStore } from './auth.store';
import { LibraryStore } from './library.store';
import { CastFilePort, CastUploadPort, SessionPort } from './ports';
import type { SessionConnectionState } from './ports';
import { SettingsStore } from './settings.store';
import {
  detectPlatform,
  fromSessionTrack,
  sessionTrackSignature,
  toSessionTrack,
} from './session-track';

/** How close the local engine must be to the server anchor to leave it alone. */
const SEEK_TOLERANCE_SEC = 2;

/** Window in which the same (entry, reason, playing) report is not sent twice. */
const REPORT_DEDUPE_MS = 1000;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : 'Something went wrong.';
}

/**
 * This client's view of the shared playback session. Owns the `SessionPort`
 * connection, mirrors the server's authoritative state, applies it to the
 * local engine when this client is the target, and reports observations back.
 *
 * Injects `PlayerService` (for the engine) rather than `PlayerStore`: the
 * facade injects this store, so the reverse would be an `NG0200` cycle.
 */
@Injectable({ providedIn: 'root' })
export class SessionStore {
  private readonly port = inject(SessionPort, { optional: true });
  private readonly auth = inject(AuthStore);
  private readonly settings = inject(SettingsStore);
  private readonly engine = inject(PlayerService).engine;
  private readonly library = inject(LibraryStore);
  private readonly uploads = inject(CastUploadPort, { optional: true });
  private readonly files = inject(CastFilePort, { optional: true });

  readonly available = computed(
    () =>
      !!this.port &&
      this.settings.sessionEnabled() &&
      this.auth.signedIn() &&
      !!this.settings.downloadServerUrl() &&
      this.port.available(),
  );
  readonly connection = signal<SessionConnectionState>('off');
  readonly devices = signal<readonly SessionDevice[]>([]);
  readonly session = signal<SessionState | null>(null);
  /** One per instance (tab / app launch); never persisted. */
  readonly clientId = signal('');
  /** Stable per-install id from settings; filled once `settings.ready()` resolves. */
  readonly deviceId = signal('');
  readonly error = signal<string | null>(null);
  /** A web target's autoplay was refused; the UI offers a one-tap resume. */
  readonly needsGesture = signal(false);

  readonly target = computed(() => this.session()?.target ?? null);
  readonly isTarget = computed(() =>
    isThisClient(this.target(), this.clientId()),
  );
  readonly mirroring = computed(() => !!this.target() && !this.isTarget());
  readonly ownsPlayback = computed(() => !!this.target());
  readonly targetStale = computed(() => this.session()?.targetStale === true);

  readonly remoteEntries = computed<readonly SessionEntry[]>(() => {
    const order = this.session()?.order ?? [];
    const entries = this.mapEntries(order);
    // Drop entries that disappeared so their art cache can be collected too.
    const seen = new Set(order.map((wire) => wire.entryId));
    for (const key of [...this.trackCache.keys()]) {
      if (!seen.has(key)) this.trackCache.delete(key);
    }
    return entries;
  });
  readonly remoteTracks = computed<readonly Track[]>(() =>
    this.remoteEntries().map((entry) => entry.track),
  );
  readonly remoteCurrent = computed<Track | null>(() => {
    const cursor = this.remoteCursor();
    return cursor < 0 ? null : (this.remoteTracks()[cursor] ?? null);
  });
  readonly remoteCursor = computed(() => this.session()?.cursor ?? -1);
  readonly currentEntryId = computed(
    () => this.session()?.order[this.remoteCursor()]?.entryId,
  );
  readonly remotePlaying = computed(() => this.session()?.playing ?? false);
  readonly remoteDuration = computed(
    () => this.remoteCurrent()?.durationSec ?? 0,
  );
  readonly remoteShuffle = computed(() => this.session()?.shuffle ?? false);
  readonly remoteRepeat = computed<RepeatMode>(
    () => this.session()?.repeat ?? 'off',
  );
  readonly remoteStatus = computed<PlayerStatus>(() => {
    const state = this.session();
    if (!state) return 'idle';
    if (state.playing) return 'playing';
    return state.cursor >= 0 ? 'paused' : 'idle';
  });
  readonly remoteError = computed(() =>
    this.session()?.unavailable?.length
      ? 'Not available on the speaker'
      : null,
  );
  /** Entry ids the server/Cast cannot play (per-row disable, not a banner). */
  readonly remoteUnavailable = computed<ReadonlySet<string>>(
    () => new Set(this.session()?.unavailable ?? []),
  );
  readonly remotePosition = computed(() => {
    // The render clock: reading it only repaints the extrapolation.
    this.tick();
    const state = this.session();
    if (!state || state.cursor < 0) return 0;
    const position = anchoredPosition(
      state,
      Date.now() + this.serverSkew(),
    );
    const duration = state.order[state.cursor]?.durationSec ?? 0;
    return duration > 0 ? Math.min(position, duration) : position;
  });
  /** Track ids of `local:` entries this device cannot rehydrate. */
  readonly localUnavailable = computed<ReadonlySet<string>>(() => {
    const known = this.library.trackMap();
    const ids = new Set<string>();
    for (const wire of this.session()?.order ?? []) {
      if (wire.local && !known.has(wire.id)) ids.add(wire.id);
    }
    return ids;
  });

  private readonly revision = signal(-1);
  private readonly devicesRevision = signal(-1);
  private readonly serverSkew = signal(0);
  /** Render clock; `remotePosition` is the only reader. */
  private readonly tick = signal(0);
  private readonly trackCache = new Map<
    string,
    { signature: string; source?: Track; track: Track }
  >();

  private started = false;
  private disconnect?: () => void;
  private unsubscribeChange?: () => void;
  private unsubscribeMessage?: () => void;
  private connectedName = '';
  private connectedServer = '';
  private refused = false;
  private disconnecting = false;
  private syncKey = '';
  private clock: ReturnType<typeof setInterval> | null = null;
  private keepalive: ReturnType<typeof setInterval> | null = null;
  private targetActive = false;
  private applyingRemote = false;
  private applyRunning = false;
  private applyPending: SessionState | null = null;
  /** Revision whose engine drift was already reconciled (one retry per revision). */
  private reconciledRevision = -1;
  private observedEntryId = '';
  private observedStatus: PlayerStatus = 'idle';
  private lastReportAt = Number.NEGATIVE_INFINITY;
  private lastReportKey = '';
  private lastReportKeyAt = 0;

  constructor() {
    this.clientId.set(newClientId());

    // Connect/disconnect when the gate inputs change (auth, settings, URL).
    effect(() => {
      const gate = [
        this.available(),
        this.settings.downloadServerUrl(),
        this.settings.deviceName(),
        this.auth.status(),
      ].join('|');
      if (!this.started) {
        this.syncKey = gate;
        return;
      }
      if (gate === this.syncKey) return;
      this.syncKey = gate;
      if (this.refused) {
        // A fixed gate input (signed in again, new server) earns one retry.
        this.refused = false;
        this.connection.set('off');
      }
      this.sync();
    });

    // One render clock while mirroring a playing session. It never touches
    // the network or the engine; it only repaints `remotePosition`.
    effect(() => {
      if (!this.started) return;
      if (this.mirroring() && this.remotePlaying()) this.startClock();
      else this.stopClock();
    });

    // Position-only keepalive while this client is the target and playing.
    effect(() => {
      if (!this.started) return;
      if (this.isTarget() && this.engine.status() === 'playing') {
        this.startKeepalive();
      } else {
        this.stopKeepalive();
      }
    });

    // Observed reporting: OS media keys and the native `onSkipped` bypass
    // PlayerStore, so the engine's own changes become reports here.
    effect(() => {
      const isTarget = this.isTarget();
      const entryId = isTarget ? this.engineEntryId() : '';
      const status = this.engine.status();
      if (!isTarget || this.applyingRemote) {
        // Keep the baseline so applying a remote state cannot echo back.
        this.observedEntryId = entryId;
        this.observedStatus = status;
        return;
      }
      if (status === 'playing' && this.needsGesture()) {
        this.needsGesture.set(false);
      }
      const previousEntry = this.observedEntryId;
      const previousStatus = this.observedStatus;
      this.observedEntryId = entryId;
      this.observedStatus = status;
      if (!entryId) return;
      if (status === 'error' && previousStatus !== 'error') {
        // Terminal playback failure: `playing` carries playing:false, so other
        // controllers stop showing phantom playback. Retries stay `loading`.
        this.report('playing');
        return;
      }
      if (entryId !== previousEntry) {
        this.report('native-skip');
        return;
      }
      if (status === 'ended' && previousStatus !== 'ended') {
        this.report('ended');
        return;
      }
      if (
        status !== previousStatus &&
        (status === 'playing' || status === 'paused')
      ) {
        this.report('playing');
      }
    });

    // Throttled position ticks while the target plays.
    effect(() => {
      // Reading the position is what schedules this effect for each tick.
      this.engine.position();
      const status = this.engine.status();
      if (!this.started || !this.isTarget() || this.applyingRemote) return;
      if (status !== 'playing' || !this.engineEntryId()) return;
      this.report('tick');
    });

    inject(DestroyRef).onDestroy(() => this.stop());
  }

  /** Subscribe first, then connect once settings have loaded. Idempotent. */
  start(): void {
    if (this.started) return;
    this.started = true;
    const port = this.port;
    if (port) {
      this.unsubscribeChange = port.onChange((state) =>
        this.handleConnection(state),
      );
      this.unsubscribeMessage = port.onMessage((message) =>
        this.handleMessage(message),
      );
    }
    void this.initialize();
  }

  async command(command: SessionCommand): Promise<CommandResult> {
    const port = this.port;
    if (!port || !this.available()) {
      return { ok: false, error: 'unavailable' };
    }
    try {
      return await port.command(newEntryId(), command);
    } catch {
      return { ok: false, error: 'unavailable' };
    }
  }

  async transferTo(target: SessionTarget): Promise<boolean> {
    if (target.kind === 'cast') {
      const prepared = await this.prepareCastUploads();
      if (!prepared.ok) {
        this.error.set(prepared.error ?? 'cast-upload-unavailable');
        return false;
      }
    }
    const result = await this.command({ type: 'transfer', target });
    if (!result.ok) {
      this.error.set(result.error ?? 'Could not transfer playback.');
      return false;
    }
    return true;
  }

  async takeOver(castId: string): Promise<boolean> {
    const result = await this.command({ type: 'takeOver', castId });
    if (!result.ok) {
      this.error.set(result.error ?? 'Could not take over playback.');
      return false;
    }
    return true;
  }

  /**
   * Replace the session queue with `order` (sent in natural order; the server
   * materialises shuffle) and start it on the current target when that target
   * is responsive; otherwise this client takes playback over. Entry ids are
   * assigned once, so a retried `setQueue` keeps them stable. Resolves the
   * entry ids it created, or `null` when any step failed.
   */
  async startSession(
    order: readonly Track[],
    cursor: number,
    opts: { shuffle: boolean; repeat: RepeatMode; autoplay: boolean },
  ): Promise<readonly string[] | null> {
    if (!this.port || !this.available()) {
      this.error.set('Sessions are not available.');
      return null;
    }
    await this.settings.ready();
    this.deviceId.set(this.settings.deviceId());
    this.error.set(null);

    const entries = order.map((track) => toSessionTrack(track, newEntryId()));
    const setQueue: SessionCommand = {
      type: 'setQueue',
      order: entries,
      cursor: clampCursor(entries.length, cursor),
      autoplay: opts.autoplay,
      shuffle: opts.shuffle,
    };
    let result = await this.command(setQueue);
    if (!result.ok) {
      // One retry with the same entry ids; a transient failure must not make
      // the queue change identity underneath the server.
      result = await this.command(setQueue);
    }
    if (!result.ok) {
      this.error.set(result.error ?? 'Could not start playback.');
      return null;
    }

    // The server keeps its repeat mode across setQueue, so set it explicitly
    // before any transfer. A failure aborts before playback moves, so the user
    // can retry from a consistent session.
    const repeat = await this.command({
      type: 'setRepeat',
      repeat: opts.repeat,
    });
    if (!repeat.ok) {
      this.error.set(repeat.error ?? 'Could not set the repeat mode.');
      return null;
    }

    // A new queue follows the responsive active target instead of stealing
    // playback. A stale target, or an earlier instance of this physical device,
    // does not count, so this client takes over in those cases.
    const target = this.target();
    const follows =
      !!target &&
      !this.isTarget() &&
      !this.targetStale() &&
      (target.kind === 'cast' || target.deviceId !== this.deviceId());
    if (!follows) {
      const transfer = await this.command({
        type: 'transfer',
        target: {
          kind: 'device',
          clientId: this.clientId(),
          deviceId: this.deviceId(),
        },
      });
      if (!transfer.ok) {
        this.error.set(transfer.error ?? 'Could not transfer playback.');
        return null;
      }
    }
    return entries.map((entry) => entry.entryId);
  }

  /** Report an observation to the server. Target only; throttled. */
  report(
    reason: SessionReportMessage['reason'],
    extra?: Partial<Pick<SessionReportMessage, 'entryId' | 'durationSec'>>,
  ): void {
    if (!this.started || !this.port || !this.isTarget()) return;
    if (this.applyingRemote) return;
    this.emitReport(reason, extra);
  }

  entryIdAt(index: number): string | undefined {
    return this.session()?.order[index]?.entryId;
  }

  async removeAt(index: number): Promise<CommandResult> {
    const entryId = this.entryIdAt(index);
    if (!entryId) return { ok: false, error: 'entry-not-found' };
    const result = await this.command({ type: 'remove', entryId });
    return result.ok
      ? result
      : { ok: false, error: result.error ?? 'entry-not-found' };
  }

  async replaceAt(index: number, track: Track): Promise<CommandResult> {
    const entryId = this.entryIdAt(index);
    if (!entryId) return { ok: false, error: 'entry-not-found' };
    const result = await this.command({
      type: 'replace',
      entryId,
      track: toSessionTrack(track, entryId),
    });
    return result.ok
      ? result
      : { ok: false, error: result.error ?? 'entry-not-found' };
  }

  async clearCastCache(): Promise<{
    freedBytes: number;
    retainedBytes: number;
  }> {
    if (!this.uploads) return { freedBytes: 0, retainedBytes: 0 };
    return this.uploads.clear();
  }

  // ---- Connection ---------------------------------------------------------

  private async initialize(): Promise<void> {
    try {
      await this.settings.ready();
    } catch {
      // Settings failing to load must not block local playback.
    }
    this.deviceId.set(this.settings.deviceId());
    this.sync();
  }

  private sync(): void {
    const port = this.port;
    if (!port) return;
    if (!this.available() || !this.deviceId()) {
      this.resetConnection();
      return;
    }
    if (this.refused) return;

    const name = this.settings.deviceName();
    const server = this.settings.downloadServerUrl();
    if (this.disconnect) {
      if (name === this.connectedName && server === this.connectedServer) {
        return;
      }
      if (server !== this.connectedServer) this.resetConnection();
      else this.disconnectOnly();
    }

    this.connectedName = name;
    this.connectedServer = server;
    this.disconnect = port.connect(this.profile(), () =>
      this.auth.accessToken(),
    );
    if (this.refused) {
      // A synchronous 4403 during connect leaves the refusal authoritative.
      this.disconnectOnly();
      return;
    }
    this.connection.set(port.connection());
  }

  private profile(): SessionDevice {
    const platform = detectPlatform();
    return {
      id: this.clientId(),
      deviceId: this.deviceId(),
      name: this.settings.deviceName(),
      platform,
      online: true,
      lastSeenAt: Date.now(),
      capabilities: { cast: platform === 'web', localFiles: platform !== 'web' },
    };
  }

  private handleConnection(state: SessionConnectionState): void {
    if (!this.started) return;
    // Our own teardown may emit `off` while refusing (4403 keeps `refused`).
    if (this.disconnecting && state === 'off') return;
    this.connection.set(state);
    if (state === 'refused') {
      this.refused = true;
      this.disconnectOnly();
      this.clearSession();
      this.stopTargetPlayback();
    }
  }

  private disconnectOnly(): void {
    const disconnect = this.disconnect;
    this.disconnect = undefined;
    this.connectedName = '';
    this.connectedServer = '';
    if (!disconnect) return;
    this.disconnecting = true;
    try {
      disconnect();
    } finally {
      this.disconnecting = false;
    }
  }

  private resetConnection(): void {
    this.disconnectOnly();
    this.connection.set('off');
    this.clearSession();
    this.stopTargetPlayback();
  }

  private clearSession(): void {
    this.session.set(null);
    this.devices.set([]);
    this.revision.set(-1);
    this.devicesRevision.set(-1);
    this.reconciledRevision = -1;
    this.trackCache.clear();
    this.stopClock();
    this.stopKeepalive();
  }

  private stopTargetPlayback(): void {
    const wasActive = this.targetActive;
    this.targetActive = false;
    this.applyingRemote = false;
    this.applyPending = null;
    this.needsGesture.set(false);
    // Local-only playback must survive a session that never owned the engine.
    if (wasActive) void this.engine.pause();
  }

  private stop(): void {
    this.started = false;
    this.disconnectOnly();
    this.unsubscribeChange?.();
    this.unsubscribeChange = undefined;
    this.unsubscribeMessage?.();
    this.unsubscribeMessage = undefined;
    this.stopClock();
    this.stopKeepalive();
  }

  // ---- Messages -----------------------------------------------------------

  private handleMessage(message: SessionServerMessage): void {
    switch (message.type) {
      case 'welcome':
        this.error.set(null);
        this.revision.set(message.session?.revision ?? -1);
        this.devicesRevision.set(message.devicesRevision);
        this.devices.set(message.devices);
        this.serverSkew.set(message.serverTime - Date.now());
        this.applyIncoming(message.session ?? null);
        break;
      case 'state':
        if (message.session.revision < this.revision()) return;
        this.revision.set(message.session.revision);
        this.applyIncoming(message.session);
        break;
      case 'tick': {
        if (message.revision < this.revision()) return;
        const current = this.session();
        if (!current) return;
        this.revision.set(message.revision);
        const next: SessionState = {
          ...current,
          positionSec: message.positionSec,
          playing: message.playing,
          updatedAt: message.updatedAt,
          targetStale: message.targetStale,
        };
        this.session.set(next);
        if (this.isTarget()) {
          void this.engine.seekIfDrifted(
            anchoredPosition(next, Date.now() + this.serverSkew()),
          );
        }
        break;
      }
      case 'devices':
        if (message.devicesRevision < this.devicesRevision()) return;
        this.devicesRevision.set(message.devicesRevision);
        this.devices.set(message.devices);
        break;
      case 'ack':
        // The port resolves the command promise; an ack carries no extra work.
        break;
      case 'ping':
        // The port answers pings.
        break;
      case 'error':
        this.error.set(message.message);
        break;
    }
  }

  private applyIncoming(next: SessionState | null): void {
    const nowTarget = isThisClient(next?.target ?? null, this.clientId());
    const wasTarget = this.targetActive;
    this.session.set(next);
    if (!next) {
      if (wasTarget) this.stopTargetPlayback();
      return;
    }
    if (nowTarget) {
      this.targetActive = true;
      this.scheduleApply(next);
    } else if (wasTarget) {
      // This client stopped being the target: stop owning the speakers.
      this.stopTargetPlayback();
    }
  }

  // ---- Target: apply the server's state -----------------------------------

  /**
   * Map session entries to local `Track`s through the shared track cache so
   * mapping is stable and `local:` entries rehydrate from the library. Takes
   * the order explicitly: an applied state must use its own order even when a
   * newer session state has already arrived.
   */
  private mapEntries(order: readonly SessionTrack[]): readonly SessionEntry[] {
    const known = this.library.trackMap();
    const entries: SessionEntry[] = [];
    for (const wire of order) {
      const signature = sessionTrackSignature(wire);
      const local = wire.local ? known.get(wire.id) : undefined;
      const cached = this.trackCache.get(wire.entryId);
      if (
        cached &&
        cached.signature === signature &&
        (local ? cached.source === local : cached.source === undefined)
      ) {
        entries.push({ entryId: wire.entryId, track: cached.track });
        continue;
      }
      const track = local ?? fromSessionTrack(wire);
      this.trackCache.set(wire.entryId, {
        signature,
        source: local,
        track,
      });
      entries.push({ entryId: wire.entryId, track });
    }
    return entries;
  }

  private scheduleApply(state: SessionState): void {
    this.applyPending = state;
    this.applyingRemote = true;
    if (this.applyRunning) return;
    this.applyRunning = true;
    void this.runApplies();
  }

  private async runApplies(): Promise<void> {
    try {
      while (this.applyPending) {
        const state = this.applyPending;
        this.applyPending = null;
        if (!this.isTarget()) continue;
        try {
          await this.applyTarget(state);
        } catch (error) {
          this.error.set(errorText(error));
        }
      }
    } finally {
      this.applyRunning = false;
      this.applyPending = null;
      this.observedEntryId = this.engineEntryId();
      this.observedStatus = this.engine.status();
      this.applyingRemote = false;
    }
  }

  private async applyTarget(state: SessionState): Promise<void> {
    await this.applyState(state);
    if (!this.isTarget()) return;

    // The engine can land on a different entry than the server's cursor (e.g.
    // a stale load finishing after `applyOrder`). The server is authoritative:
    // re-apply this same state once per revision instead of reporting the
    // artifact as a native skip. If it drifts again, leave it alone.
    const expected = state.order[state.cursor]?.entryId ?? '';
    const index = this.engine.currentIndex();
    const actual = index >= 0 ? (state.order[index]?.entryId ?? '') : '';
    if (actual === expected) return;
    if (this.reconciledRevision === state.revision) return;
    this.reconciledRevision = state.revision;
    await this.applyState(state);
  }

  private async applyState(state: SessionState): Promise<void> {
    const tracks = this.mapEntries(state.order).map((entry) => entry.track);
    const cursor = state.cursor;
    if (cursor < 0 || cursor >= tracks.length) {
      await this.engine.applyOrder([], -1, {
        autoplay: false,
        sessionMode: true,
      });
      this.needsGesture.set(false);
      return;
    }

    await this.engine.applyOrder(tracks, cursor, {
      autoplay: state.playing,
      positionSec: state.positionSec,
      sessionMode: true,
    });
    if (!this.isTarget()) return;
    // A reload starts at 0, and the anchor moved while the state travelled.
    await this.engine.seekIfDrifted(
      anchoredPosition(state, Date.now() + this.serverSkew()),
      SEEK_TOLERANCE_SEC,
    );
    if (!this.isTarget()) return;

    if (state.playing) {
      let blocked = false;
      if (this.engine.status() !== 'playing') {
        try {
          await this.engine.play();
        } catch {
          blocked = true;
        }
      }
      if (blocked || this.engine.status() !== 'playing') {
        // Autoplay was refused: stay paused, offer the one-tap resume, and
        // tell the server so other controllers do not show a phantom play.
        this.needsGesture.set(true);
        this.emitReport('playing');
      } else {
        this.needsGesture.set(false);
      }
    } else {
      await this.engine.pause();
      this.needsGesture.set(false);
    }
  }

  // ---- Target: reports ----------------------------------------------------

  private engineEntryId(): string {
    const index = this.engine.currentIndex();
    return index >= 0 ? (this.entryIdAt(index) ?? '') : '';
  }

  private emitReport(
    reason: SessionReportMessage['reason'],
    extra?: Partial<Pick<SessionReportMessage, 'entryId' | 'durationSec'>>,
  ): void {
    const port = this.port;
    const state = this.session();
    if (!port || !state) return;
    const entryId =
      extra?.entryId ?? (this.engineEntryId() || this.currentEntryId() || '');
    if (!entryId) return;

    const playing = this.engine.status() === 'playing';
    const now = Date.now();
    if (reason === 'tick') {
      // No anchor while paused, and at most one tick per throttle window.
      if (!playing || now - this.lastReportAt < REPORT_THROTTLE_MS) return;
    } else {
      const key = `${entryId}|${reason}|${playing}`;
      // PlayerStore and the engine observer may both report the same change.
      if (key === this.lastReportKey && now - this.lastReportKeyAt < REPORT_DEDUPE_MS) {
        return;
      }
      this.lastReportKey = key;
      this.lastReportKeyAt = now;
    }
    this.lastReportAt = now;

    let durationSec: number | undefined =
      extra?.durationSec ?? this.engine.duration();
    if (!durationSec) {
      const index = state.order.findIndex((entry) => entry.entryId === entryId);
      durationSec = index >= 0 ? state.order[index]?.durationSec : undefined;
    }

    const report: SessionReportMessage = {
      type: 'report',
      reason,
      entryId,
      positionSec: this.engine.position(),
      playing,
    };
    if (durationSec !== undefined) report.durationSec = durationSec;
    try {
      port.send(report);
    } catch {
      // Fire-and-forget: a transport hiccup must not break playback.
    }
  }

  // ---- Cast ---------------------------------------------------------------

  /**
   * Upload the queue's `local:` entries before a cast transfer, replacing
   * each entry with `{ uploadId }`. All files are read and uploaded before the
   * first `replace` is sent, so a missing file leaves the session untouched.
   * Without both ports the transfer is refused (`cast-upload-unavailable`);
   * the actual upload route lands in Phase 6.
   */
  private async prepareCastUploads(): Promise<CommandResult> {
    const state = this.session();
    if (!state) return { ok: false, error: 'no-session' };
    const locals = state.order.filter((entry) => entry.local);
    if (!locals.length) return { ok: true };
    const uploads = this.uploads;
    const files = this.files;
    if (!uploads || !files) {
      return { ok: false, error: 'cast-upload-unavailable' };
    }

    try {
      const blobs: { entry: SessionTrack; blob: Blob }[] = [];
      for (const entry of locals) {
        const track = this.library.track(entry.id) ?? fromSessionTrack(entry);
        const blob = await files.bytes(track);
        if (!blob) return { ok: false, error: 'cast-upload-unavailable' };
        blobs.push({ entry, blob });
      }
      const uploaded: { entry: SessionTrack; uploadId: string }[] = [];
      for (const { entry, blob } of blobs) {
        const result = await uploads.upload(blob, `${entry.title}.audio`);
        uploaded.push({ entry, uploadId: result.uploadId });
      }
      for (const { entry, uploadId } of uploaded) {
        const replaced = await this.command({
          type: 'replace',
          entryId: entry.entryId,
          track: { ...entry, uploadId, local: undefined },
        });
        if (!replaced.ok) return replaced;
      }
      return { ok: true };
    } catch (error) {
      return { ok: false, error: errorText(error) };
    }
  }

  // ---- Clocks -------------------------------------------------------------

  private startClock(): void {
    if (this.clock) return;
    this.clock = setInterval(() => this.tick.update((value) => value + 1), 1000);
  }

  private stopClock(): void {
    if (!this.clock) return;
    clearInterval(this.clock);
    this.clock = null;
  }

  private startKeepalive(): void {
    if (this.keepalive) return;
    this.keepalive = setInterval(
      () => this.report('tick'),
      REPORT_KEEPALIVE_MS,
    );
  }

  private stopKeepalive(): void {
    if (!this.keepalive) return;
    clearInterval(this.keepalive);
    this.keepalive = null;
  }
}
