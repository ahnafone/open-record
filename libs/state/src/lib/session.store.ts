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

/** Internal: a newer transfer aborted this upload batch; never shown as an error. */
const CAST_UPLOAD_ABORTED = { ok: false, error: 'aborted' } as const;

/** Uploaded ids keyed by session entry id, or the reason the batch was refused. */
type CastUploadBatch =
  | { ok: true; ids: Map<string, string> }
  | { ok: false; error: string };

/** Extensions the upload route accepts; it rejects any other multipart name. */
const CAST_UPLOAD_EXTS = new Set([
  'mp3',
  'm4a',
  'aac',
  'ogg',
  'opus',
  'flac',
  'wav',
]);

/** Fallback when the stored path has no allow-listed extension. */
const CAST_MIME_EXTS: Readonly<Record<string, string>> = {
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/aac': 'aac',
  'audio/ogg': 'ogg',
  'audio/flac': 'flac',
  'audio/wav': 'wav',
};

/**
 * Upload name extension: the stored file's own suffix first (`.audio.mp3`),
 * then the blob's mime type, then `mp3`. The server derives the stored file
 * type from the multipart filename, so it must be one of the allow-listed
 * extensions or the upload is rejected (`400 bad-file`).
 */
function castUploadExtension(track: Track, blob: Blob): string {
  const sourceFile = track.sourceFile ?? '';
  const base = sourceFile.slice(sourceFile.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  if (dot >= 0) {
    const ext = base.slice(dot + 1).toLowerCase();
    if (CAST_UPLOAD_EXTS.has(ext)) return ext;
  }
  const mime = blob.type.split(';')[0]?.trim().toLowerCase() ?? '';
  return CAST_MIME_EXTS[mime] ?? 'mp3';
}

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
  /** Progress of the current cast upload batch; null when idle/finished/aborted. */
  readonly castUpload = signal<{
    done: number;
    total: number;
    fraction: number;
  } | null>(null);

  readonly target = computed(() => this.session()?.target ?? null);
  readonly isTarget = computed(() =>
    isThisClient(this.target(), this.clientId()),
  );
  readonly mirroring = computed(() => !!this.target() && !this.isTarget());
  readonly ownsPlayback = computed(() => !!this.target());
  readonly targetStale = computed(() => this.session()?.targetStale === true);
  /** The cast stream is transcoded, so seeking restarts it on the speaker. */
  readonly castSeekRestarts = computed(
    () => this.session()?.castSeekRestarts === true,
  );

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
  /** `track.id` + `sourceFile` → server upload id, so a retry uploads once. */
  private readonly castUploadIds = new Map<string, string>();
  /** The upload batch a new transfer (or sign-out) aborts. */
  private castUploadAbort: AbortController | null = null;

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
    // A new transfer supersedes any upload batch for the queue being left.
    this.abortCastUploads();
    if (target.kind === 'cast') {
      const prepared = await this.prepareCastUploads();
      if (!prepared.ok) {
        // Aborted on purpose: a newer transfer owns playback now, so this one
        // resolves as not-moved without a toast.
        if (prepared.error !== CAST_UPLOAD_ABORTED.error) {
          this.error.set(prepared.error ?? 'cast-upload-unavailable');
        }
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
    // A queue change supersedes any upload batch for the queue being replaced.
    this.abortCastUploads();
    if (!this.port || !this.available()) {
      this.error.set('Sessions are not available.');
      return null;
    }
    await this.settings.ready();
    this.deviceId.set(this.settings.deviceId());
    this.error.set(null);

    let entries = order.map((track) => toSessionTrack(track, newEntryId()));

    // A new queue started while a speaker owns playback is queued ON the
    // speaker, so its `local:` imports must be uploaded before `setQueue`.
    // A stale cast target does not count: this client takes playback over.
    if (this.followsCastTarget()) {
      const batch = await this.uploadLocalEntries(entries);
      if (batch && !batch.ok) {
        this.error.set(batch.error);
        return null;
      }
      if (batch) {
        entries = entries.map((entry) => {
          const uploadId = batch.ids.get(entry.entryId);
          return uploadId ? { ...entry, uploadId } : entry;
        });
      }
      this.castUpload.set(null);
    }

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

    // The server accepted the queue: remember the uploads now so the next cast
    // transfer reuses them instead of reading and uploading the files again.
    for (let i = 0; i < entries.length; i++) {
      const uploadId = entries[i]?.uploadId;
      const track = order[i];
      if (uploadId && track) {
        this.castUploadIds.set(this.castUploadKey(track), uploadId);
      }
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
    const result = await this.uploads.clear();
    // The server dropped those files: cached ids must not be reused.
    this.castUploadIds.clear();
    return result;
  }

  /** Server-side cast cache usage; null when this platform cannot upload. */
  async castCacheUsage(): Promise<{
    bytes: number;
    count: number;
    cap: number;
  } | null> {
    if (!this.uploads) return null;
    try {
      return await this.uploads.usage();
    } catch {
      // Unreachable/disabled server: the line is simply hidden.
      return null;
    }
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
    this.resetCastUploads();
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
    this.resetCastUploads();
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
   * Transfer-time wrapper: upload the session's `local:` entries, then stamp
   * each successful id onto its entry with a `replace`. All files are read
   * before the first command, so a missing file leaves the session untouched.
   */
  private async prepareCastUploads(): Promise<CommandResult> {
    const state = this.session();
    if (!state) return { ok: false, error: 'no-session' };
    const batch = await this.uploadLocalEntries(state.order);
    if (!batch) return { ok: true };
    if (!batch.ok) return batch;

    for (const entry of state.order) {
      const uploadId = batch.ids.get(entry.entryId);
      if (!uploadId) continue;
      const replaced = await this.command({
        type: 'replace',
        entryId: entry.entryId,
        track: { ...entry, uploadId, local: undefined },
      });
      if (!replaced.ok) return replaced;
      // Only remember an id once its `replace` landed, so a failed replace
      // re-uploads instead of pointing the server at a missing file.
      const track = this.library.track(entry.id) ?? fromSessionTrack(entry);
      this.castUploadIds.set(this.castUploadKey(track), uploadId);
    }
    return { ok: true };
  }

  /**
   * Upload every `local:` entry in `entries`, skipping ids already cached.
   * `null` when there is nothing local; on success the ids are keyed by
   * `entryId` and every file has been read before the first upload starts.
   *
   * SECURITY: only the PC browser that can actually read the import may cast
   * it. A phone's app-private files must never be uploaded, and an arbitrary
   * page must not be able to ask this adapter to read local files. The origin
   * equality check is the boundary: it proves the page was served by the
   * download server that owns this session (`location.origin` is the page's
   * true origin, not a URL we were handed), so the bytes are read in the same
   * browser that imported them and POSTed only to that same origin.
   */
  private async uploadLocalEntries(
    entries: readonly SessionTrack[],
  ): Promise<CastUploadBatch | null> {
    const locals = entries.filter((entry) => entry.local);
    if (!locals.length) return null;
    if (!this.canUploadLocalFiles()) {
      return { ok: false, error: 'cast-local-pc-only' };
    }
    const uploads = this.uploads;
    const files = this.files;
    if (!uploads || !files) {
      return { ok: false, error: 'cast-upload-unavailable' };
    }

    try {
      const cached: { entry: SessionTrack; key: string; uploadId: string }[] =
        [];
      const pending: { entry: SessionTrack; key: string; track: Track }[] = [];
      for (const entry of locals) {
        const track = this.library.track(entry.id) ?? fromSessionTrack(entry);
        const key = this.castUploadKey(track);
        const uploadId = this.castUploadIds.get(key);
        if (uploadId) cached.push({ entry, key, uploadId });
        else pending.push({ entry, key, track });
      }

      // Read every uncached file first: a missing file must not upload half a
      // queue, and must leave the session untouched. The multipart name needs
      // an allow-listed extension (the server derives the stored type from it).
      const blobs: {
        entry: SessionTrack;
        key: string;
        blob: Blob;
        name: string;
      }[] = [];
      for (const { entry, key, track } of pending) {
        const blob = await files.bytes(track);
        if (!blob) return { ok: false, error: 'cast-upload-unavailable' };
        blobs.push({
          entry,
          key,
          blob,
          name: `${entry.title}.${castUploadExtension(track, blob)}`,
        });
      }

      const uploaded: { entry: SessionTrack; key: string; uploadId: string }[] =
        [];
      if (blobs.length) {
        const total = blobs.length;
        let done = 0;
        const controller = new AbortController();
        this.castUploadAbort = controller;
        this.castUpload.set({ done: 0, total, fraction: 0 });
        try {
          for (const { entry, key, blob, name } of blobs) {
            if (controller.signal.aborted) return CAST_UPLOAD_ABORTED;
            const result = await uploads.upload(blob, name, {
              signal: controller.signal,
              onProgress: (fileFraction) => {
                if (controller.signal.aborted) return;
                const clamped = Math.min(1, Math.max(0, fileFraction));
                this.castUpload.set({
                  done,
                  total,
                  fraction: (done + clamped) / total,
                });
              },
            });
            if (controller.signal.aborted) return CAST_UPLOAD_ABORTED;
            uploaded.push({ entry, key, uploadId: result.uploadId });
            done++;
            this.castUpload.set(
              done >= total ? null : { done, total, fraction: done / total },
            );
          }
        } catch (error) {
          // A superseded batch resolves as not-moved; anything else is real.
          if (controller.signal.aborted) return CAST_UPLOAD_ABORTED;
          throw error;
        } finally {
          if (this.castUploadAbort === controller) {
            this.castUploadAbort = null;
            this.castUpload.set(null);
          }
        }
      }

      const ids = new Map<string, string>();
      for (const { entry, uploadId } of [...cached, ...uploaded]) {
        ids.set(entry.entryId, uploadId);
      }
      return { ok: true, ids };
    } catch (error) {
      return { ok: false, error: errorText(error) };
    }
  }

  /** The new queue will be queued on a responsive speaker (never this client). */
  private followsCastTarget(): boolean {
    return this.target()?.kind === 'cast' && !this.targetStale();
  }

  /**
   * Only a same-origin web page served by the download server may upload a
   * local import. Parse defensively: a missing/unparseable base URL refuses.
   */
  private canUploadLocalFiles(): boolean {
    if (detectPlatform() !== 'web' || !this.files) return false;
    try {
      const page = globalThis.location?.origin;
      const base = this.settings.downloadServerUrl().trim();
      if (!page || !base) return false;
      return new URL(page).origin === new URL(base).origin;
    } catch {
      return false;
    }
  }

  private castUploadKey(track: Track): string {
    return `${track.id}\u0000${track.sourceFile ?? ''}`;
  }

  private abortCastUploads(): void {
    const controller = this.castUploadAbort;
    this.castUploadAbort = null;
    this.castUpload.set(null);
    controller?.abort();
  }

  private resetCastUploads(): void {
    this.abortCastUploads();
    this.castUploadIds.clear();
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
