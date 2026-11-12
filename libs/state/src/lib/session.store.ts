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
import type {
  PlayerStatus,
  RepeatMode,
  StackEntry,
} from '@open-record/player';
import { AuthStore } from './auth.store';
import { LibraryStore } from './library.store';
import { CastFilePort, CastUploadPort, SessionPort } from './ports';
import type { SessionConnectionState } from './ports';
import { SettingsStore } from './settings.store';
import {
  detectPlatform,
  fitSessionOrder,
  fromSessionTrack,
  sessionTrackSignature,
  toSessionTrack,
} from './session-track';

/** How close the local engine must be to the server anchor to leave it alone. */
const SEEK_TOLERANCE_SEC = 2;
/**
 * A track that changed and whose stored anchor is this close to 0 was just
 * started by a command: it begins at 0 and no catch-up seek follows the load.
 */
const FRESH_START_SEC = 3;
/**
 * A fresh start's anchor must be this old or younger when the state is
 * received. A command's state arrives within a moment; a mid-song join or a
 * late state is already aged, so it seeks. Measured at receipt, not after the
 * load, because buffering takes seconds.
 */
const FRESH_START_RECEIPT_SEC = 2.5;
/** Ticks sent before the server saw a local seek are ignored for this long. */
const LOCAL_SEEK_GRACE_MS = 3000;

/** Window in which the same (entry, reason, playing) report is not sent twice. */
const REPORT_DEDUPE_MS = 1000;

/** After a failed publish, automatic re-publishing waits this long (no retry loop). */
const PUBLISH_RETRY_MS = 15_000;
/** Automatic re-publishes allowed in a row before the client waits for a new loss. */
const MAX_AUTO_REPUBLISHES = 2;

/**
 * Engine media identity for session applies. The wire drops `sourceFile`, so
 * the default key would call the same song "different media" after a publish
 * and reload it. Session entries are identified by song id.
 */
const sessionMediaKey = (track: Track): string => track.id;

/** Command failures that mean the transport is not usable, not a refusal. */
const QUIET_COMMAND_FAILURES: ReadonlySet<string> = new Set([
  'offline',
  'unavailable',
  'timeout',
  'superseded',
  'unknown-client',
]);

/**
 * Failures where the server may have applied the command even though this
 * client got no clean answer: the ack timed out, a newer send replaced the
 * pending one, or a 2xx body could not be read.
 */
const AMBIGUOUS_COMMAND_FAILURES: ReadonlySet<string> = new Set([
  'timeout',
  'superseded',
  'invalid-response',
]);

/**
 * True when a failed command may still have been applied, so its effect is
 * unknown and the caller must not assume it was dropped. Everything else is a
 * definite non-application: `offline`/`unavailable` (never sent), `unauthorized`,
 * `refused`, and the server's named refusals (`entry-not-found`,
 * `queue-too-large`, `unknown-client`, ...). An unnamed HTTP failure (`http-N`)
 * is ambiguous too, since a 5xx can come after the server applied the command.
 */
export function isAmbiguousCommandFailure(error: string | undefined): boolean {
  if (error === undefined) return true;
  return AMBIGUOUS_COMMAND_FAILURES.has(error) || error.startsWith('http-');
}

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
  /** Entry ids of the session's Your Stack (`SessionState.stack`). */
  readonly remoteStackIds = computed<ReadonlySet<string>>(
    () => new Set(this.session()?.stack ?? []),
  );
  /** Session Your Stack entries in play order (they follow the current entry). */
  readonly remoteStackEntries = computed<readonly StackEntry[]>(() => {
    const stack = this.remoteStackIds();
    return this.remoteEntries()
      .filter((entry) => stack.has(entry.entryId))
      .map((entry) => ({ entryId: entry.entryId, track: entry.track }));
  });
  /**
   * The session's Your Stack is known while a session owns playback, its state
   * carries a `stack` field, and every stack id resolves to an entry of its
   * order. An absent `stack` is an older server that never sends one (the new
   * server always sends `[]`), so it is unknown too. Until known, the stack must
   * not read as empty, or sync would delete the account's entries.
   */
  readonly remoteStackKnown = computed(
    () =>
      this.ownsPlayback() &&
      this.session()?.stack !== undefined &&
      this.remoteStackEntries().length === this.remoteStackIds().size,
  );
  readonly remoteCurrent = computed<Track | null>(() => {
    const cursor = this.remoteCursor();
    return cursor < 0 ? null : (this.remoteTracks()[cursor] ?? null);
  });
  readonly remoteCursor = computed(() => this.session()?.cursor ?? -1);
  readonly currentEntryId = computed(
    () => this.session()?.order[this.remoteCursor()]?.entryId,
  );
  /** A stale target keeps its last `playing`, but nothing is playing on it. */
  private readonly mirroringStale = computed(
    () => this.mirroring() && this.targetStale(),
  );
  readonly remotePlaying = computed(
    () => (this.session()?.playing ?? false) && !this.mirroringStale(),
  );
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
    if (this.remotePlaying()) return 'playing';
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
    // A stale target is frozen at its last anchor: no extrapolation.
    const position = this.mirroringStale()
      ? Math.max(0, state.positionSec)
      : anchoredPosition(state, Date.now() + this.serverSkew());
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
  /** Target clientId this client already adopted from; one attempt per target. */
  private adoptedFrom = '';
  /** Target clientId whose adoption is in flight; cleared on failure to retry. */
  private adoptingFrom = '';
  /** Target clientId whose pause already succeeded, so a retry only transfers. */
  private pausedFrom = '';
  /** Bumped on every disconnect so an in-flight adoption cannot write stale state. */
  private connectionEpoch = 0;
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
  private applyPending: {
    state: SessionState;
    /** A local seek is newer than this state's anchor: do not correct to it. */
    keepPosition: boolean;
  } | null = null;
  /** Revision whose engine drift was already reconciled (one retry per revision). */
  private reconciledRevision = -1;
  /**
   * The track a command just started fresh, and the `updatedAt` of the state
   * that started it. Same-song states not newer than that are echoes of the
   * start; their anchor is stale, so they must not catch-up seek the track.
   */
  private freshStart: { trackId: string; updatedAt: number } | null = null;
  /**
   * A fresh start whose audio was still loading when its state was applied.
   * The forced tick that re-bases the server anchor waits for the engine to
   * report `playing` for this track; it is cleared when the track changes.
   */
  private pendingFreshTick: string | null = null;
  private observedEntryId = '';
  private observedStatus: PlayerStatus = 'idle';
  private lastReportAt = Number.NEGATIVE_INFINITY;
  /** When this client last seeked locally; in-flight stale ticks must not undo it. */
  private lastLocalSeekAt = Number.NEGATIVE_INFINITY;
  private lastReportKey = '';
  private lastReportKeyAt = 0;
  /** `track.id` + `sourceFile` → server upload id, so a retry uploads once. */
  private readonly castUploadIds = new Map<string, string>();
  /** The upload batch a new transfer (or sign-out) aborts. */
  private castUploadAbort: AbortController | null = null;
  /** A local publish is in flight; a second one must not start. */
  private publishing = false;
  /** A local seek was made while the hold was on; reported once it ends. */
  private seekHeld = false;
  /**
   * Latest server state that arrived mid-publish. Not applied then: the echoes
   * of this publish would rewind a skip. Checked once the publish finishes.
   */
  private pendingIncoming: SessionState | null = null;
  /** The server lost its owner (restart, cleared target) during a publish. */
  private ownerGoneWhilePublishing = false;
  /** Entry ids this publish sent; the echo of those is not an owner loss. */
  private readonly publishEntryIds = new Set<string>();
  /** Automatic re-publishes since the last success or genuine owner loss. */
  private republishStreak = 0;
  /** Engine was seen paused at any point during a publish (a resume may follow). */
  private pausedDuringHold = false;
  /** Automatic re-publishing is paused until this time after a failed publish. */
  private publishRetryAt = 0;
  /** Scheduled re-publish after the back-off; one at a time. */
  private republishTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    this.clientId.set(newClientId());

    // Remember a local resume that lands while a publish holds the state.
    // Only the pause is recorded here; whether a resume followed is sampled
    // when the publish settles, so loading or coalesced effects cannot hide it.
    effect(() => {
      // Read first: the effect must track the status even while idle.
      const status = this.engine.status();
      if (this.publishing && status === 'paused') this.pausedDuringHold = true;
    });

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
      if (!isTarget || this.applyingRemote || this.holdingEcho()) {
        // Keep the baseline so applying a remote state, or a publish (whose
        // queue the session does not mirror yet), cannot echo back.
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
        this.report('native-skip', {
          playing: status === 'playing' || this.engine.intendsToPlay,
        });
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

    // A fresh start that was still loading: re-base the server anchor once its
    // track actually plays, once. A track change drops the pending re-base.
    effect(() => {
      // Read the signals before the early return: this effect must re-run when
      // the engine changes, even while nothing is pending.
      const status = this.engine.status();
      const currentId = this.engine.current()?.id;
      const pending = this.pendingFreshTick;
      if (pending === null) return;
      if (currentId !== pending) {
        this.pendingFreshTick = null;
        return;
      }
      if (status !== 'playing') return;
      this.pendingFreshTick = null;
      if (this.isTarget()) this.emitReport('tick', undefined, true);
    });

    // Throttled position ticks while the target plays.
    effect(() => {
      // Reading the position is what schedules this effect for each tick.
      this.engine.position();
      const status = this.engine.status();
      if (!this.started || !this.isTarget() || this.applyingRemote) return;
      if (this.holdingEcho()) return;
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
   * Publish this device's own playback to the shared session. Used when a
   * queue plays here while nothing owns the session: a local-only start, or a
   * server restart / cleared target. Sends the queue from the current track
   * (shuffle is re-applied by the server, keeping the current track), then the
   * repeat mode, then the position (a seek sent BEFORE the transfer, so the
   * echoed state already carries the right anchor), then transfers playback
   * to this client. The engine is never reloaded. Resolves whether this client
   * now targets the session.
   */
  async publishLocal(): Promise<boolean> {
    if (!this.port || !this.available()) return false;
    // A publish already in flight owns the queue. A skip made meanwhile is
    // caught by the track check once it finishes, so nothing is queued here.
    if (this.publishing) return false;
    if (!this.canPublish()) return false;

    this.publishing = true;
    this.pendingIncoming = null;
    this.ownerGoneWhilePublishing = false;
    this.publishEntryIds.clear();
    this.pausedDuringHold = false;
    // Track id of the last pass that transferred playing to this client. A
    // failed later pass never clears it: the server still has that queue.
    let lastGood: string | null = null;
    // Set when the second pass succeeded: its own echo follows held state.
    let secondPassOk = false;
    // Set when the second pass ran and failed: it may have discarded the queue.
    let secondPassFailed = false;
    try {
      lastGood = await this.publishQueue();
      // Bounded: one more pass when the engine left the published track
      // mid-publish. Native skips (media keys) bypass PlayerStore, so only this
      // comparison sees them. Echoes never trigger a pass. The first pass may
      // already have transferred the target to this client.
      if (lastGood !== null && this.engine.current()?.id !== lastGood) {
        const second = await this.publishQueue();
        if (second !== null) {
          lastGood = second;
          secondPassOk = true;
        } else {
          secondPassFailed = true;
        }
      }
      return lastGood !== null;
    } finally {
      this.publishing = false;
      const ownerGone = this.ownerGoneWhilePublishing;
      this.ownerGoneWhilePublishing = false;
      this.publishEntryIds.clear();
      const pending = this.pendingIncoming;
      this.pendingIncoming = null;
      // Read before the flush clears it: a seek is newer than the held state.
      const seeked = this.seekHeld;
      // Paused at some point during the hold and playing again now.
      const resumed =
        this.pausedDuringHold &&
        (this.engine.status() === 'playing' || this.engine.intendsToPlay);
      this.pausedDuringHold = false;
      // Replayed before the held state is settled: applying that state can
      // change the engine's status, which would hide what the hold swallowed.
      this.flushHeldSeek();
      const skipReported = this.replayHeldEvents(lastGood);
      if (pending) {
        this.settlePendingIncoming(pending, {
          // The newer report (or the second pass's own echo) supersedes a
          // held state for another track.
          stale: skipReported || secondPassOk,
          seeked,
          resumed,
        });
      }
      // A lost owner, or a failed second pass that discarded its queue, can
      // leave this device playing with an empty session. Publish again once
      // the back-off allows. Keyed on those events (not on an empty session
      // alone), so a publish that succeeds without an echo cannot loop. Only a
      // publish the server confirmed (this client targets a non-empty queue)
      // ends the streak; each automatic re-publish spends one of
      // `MAX_AUTO_REPUBLISHES`, so a persistent refusal cannot retry forever.
      if (this.isTarget() && (this.session()?.order.length ?? 0) > 0) {
        this.republishStreak = 0;
      }
      const serverEmpty = (this.session()?.order.length ?? 0) === 0;
      const republish =
        this.localPlaybackActive() &&
        ((ownerGone && this.republishNeeded()) ||
          (secondPassFailed && serverEmpty && this.isTarget()));
      if (republish && this.republishStreak < MAX_AUTO_REPUBLISHES) {
        this.republishStreak++;
        this.scheduleRepublish();
      }
    }
  }

  /**
   * True for the target-less echo of this publish's own queue. The server
   * broadcasts `setQueue` before the transfer, so that echo is not a lost owner.
   */
  private isOwnPublishEcho(state: SessionState | null): boolean {
    return (
      this.publishing &&
      state !== null &&
      state.target === null &&
      state.order.length > 0 &&
      state.order.every((entry) => this.publishEntryIds.has(entry.entryId))
    );
  }

  private cancelRepublish(): void {
    if (this.republishTimer) clearTimeout(this.republishTimer);
    this.republishTimer = null;
  }

  /**
   * True while this device plays but no session queue is owned here: the
   * session has no target, or this client targets an emptied queue.
   */
  private republishNeeded(): boolean {
    if (!this.localPlaybackActive()) return false;
    return (
      !this.target() ||
      (this.isTarget() && (this.session()?.order.length ?? 0) === 0)
    );
  }

  /**
   * Publish again now, or when the back-off ends. One timer at a time; the
   * timer re-checks, so a publish that already restored the session is not
   * repeated.
   */
  private scheduleRepublish(): void {
    if (this.republishTimer) return;
    const wait = this.publishRetryAt - Date.now();
    if (wait <= 0) {
      this.keepLocalPlayback();
      return;
    }
    this.republishTimer = setTimeout(() => {
      this.republishTimer = null;
      // Offline: nothing to publish to. The welcome path re-checks ownership.
      if (this.port?.connection() !== 'open') return;
      if (!this.republishNeeded()) return;
      if (Date.now() < this.publishRetryAt) {
        // A publish failed meanwhile and the back-off still holds: wait out the
        // rest of it. Bounded by the streak, like the publishes it leads to.
        if (this.republishStreak < MAX_AUTO_REPUBLISHES) this.scheduleRepublish();
        return;
      }
      this.keepLocalPlayback();
    }, wait);
  }

  /** Report a local seek made while the hold was on, now that it is over. */
  private flushHeldSeek(): void {
    if (!this.seekHeld) return;
    this.seekHeld = false;
    if (this.isTarget()) this.emitReport('tick', undefined, true);
  }

  /**
   * Engine events swallowed by the hold, replayed once it ends: a skip made
   * during the second pass (not published, so the server still has the old
   * cursor), and a terminal status. Baselines followed the engine during the
   * hold, so the observer would not report them.
   */
  private replayHeldEvents(lastGood: string | null): boolean {
    if (!this.isTarget()) return false;
    const entryId = this.engineEntryId();
    // The engine left the last published track: the server still has the old
    // cursor, so report the move. Only for the entry the engine is on now.
    let skipReported = false;
    if (
      lastGood !== null &&
      this.engine.current()?.id !== lastGood &&
      entryId
    ) {
      this.emitReport('native-skip', {
        entryId,
        playing: this.engine.status() === 'playing' || this.engine.intendsToPlay,
      });
      skipReported = true;
    }
    // A state applied by the hold owns the engine: leave its status alone.
    // A skip does not hide a terminal status of the engine's current entry.
    if (this.applyingRemote || !entryId) return skipReported;
    const status = this.engine.status();
    if (status === 'ended') this.emitReport('ended', { entryId });
    else if (status === 'error') this.emitReport('playing', { entryId });
    return skipReported;
  }

  /**
   * Apply the server state that arrived mid-publish, once the publish is over.
   * Runs whenever this client is the target, even if the publish failed: the
   * server is authoritative then. A state for another track is stale when a
   * newer report already moved the server past it (`stale`); otherwise it is a
   * remote command made during the publish and is applied. A seek made during
   * the hold is newer than the state's anchor, so the anchor must not drag the
   * engine back. A paused state while the engine plays is answered with a play
   * command, not a pause, but only when a local resume was seen during the
   * hold; otherwise the held paused state is a remote pause and is applied. A
   * playing state while the engine is paused is applied paused, and the server
   * is told to pause. If the server refuses a replayed play, the engine is
   * paused and the server is told, so both agree; a transport failure leaves
   * local playback alone.
   */
  private settlePendingIncoming(
    state: SessionState,
    opts: { stale: boolean; seeked: boolean; resumed: boolean },
  ): void {
    if (!this.isTarget()) return;
    const cursorId =
      state.cursor >= 0 ? state.order[state.cursor]?.id : undefined;
    if (opts.stale && cursorId !== this.engine.current()?.id) return;
    // An emptied queue (a failed publish's discard) must not stop playback
    // that is still running here.
    if (state.cursor < 0 && this.localPlaybackActive()) return;
    if (state.playing && !this.localPlaybackActive()) {
      void this.command({ type: 'pause' }).then((paused) => {
        if (!paused.ok) {
          this.recordRefusal(paused.error ?? 'Could not pause playback.');
        }
      });
      this.scheduleApply({ ...state, playing: false }, opts.seeked);
      return;
    }
    if (!state.playing && this.localPlaybackActive() && opts.resumed) {
      // The user resumed during the publish: keep the engine playing, and tell
      // the server rather than letting the held `paused` state stop it.
      const entryId = this.engineEntryId();
      void this.command({ type: 'play' }).then((played) => {
        if (played.ok || !this.isTarget()) return;
        const error = played.error ?? 'Could not start playback.';
        this.recordRefusal(error);
        // A transport failure says nothing about the server's state: keep
        // playing locally. Only a real refusal makes the server read paused.
        if (QUIET_COMMAND_FAILURES.has(error)) return;
        void this.engine.pause();
        this.emitReport('playing', { entryId, playing: false });
      });
      this.scheduleApply({ ...state, playing: true }, opts.seeked);
      return;
    }
    this.scheduleApply(state, opts.seeked);
  }

  /**
   * True while engine changes are not this client's own observations: a publish
   * is in flight, or a server state is held until it ends. Reports are
   * suppressed then, and the observation baselines only follow the engine.
   */
  private holdingEcho(): boolean {
    return this.publishing || this.pendingIncoming !== null;
  }

  /** Whether a local queue may be published now (no other target, playing here). */
  private canPublish(): boolean {
    return (
      this.port?.connection() === 'open' &&
      (!this.target() || this.isTarget()) &&
      this.localPlaybackActive() &&
      !!this.deviceId() &&
      this.engine.current() !== null
    );
  }

  /**
   * One publish pass from the engine's current track. Resolves the published
   * first track id, or `null` when nothing was published.
   */
  private async publishQueue(): Promise<string | null> {
    if (!this.canPublish()) return null;
    const current = this.engine.current();
    if (!current) return null;
    // Your Stack entries keep their engine entry ids and travel in `stack`,
    // not `order`: the server places them right after the cursor.
    // The queue indices keep the natural order: upcoming tracks are in play
    // order, which differs from the queue order while shuffle is on.
    const planned = [
      { track: current, queueIndex: this.engine.currentIndex(), stackEntryId: null },
      ...this.engine.upcomingEntries(),
    ].map(({ track, queueIndex, stackEntryId }) => ({
      queueIndex,
      stackEntryId,
      entry: toSessionTrack(track, stackEntryId ?? newEntryId()),
    }));
    const orderItems = planned.filter((item) => item.stackEntryId === null);
    const entries = orderItems.map((item) => item.entry);
    const stack = planned
      .filter((item) => item.stackEntryId !== null)
      .map((item) => item.entry);
    // Autoplay reads the engine when each send happens, so a pause during the
    // publish is not overridden by a stale `true`. The order above already is
    // the play order: with shuffle on, `shuffled` tells the server to keep that
    // order, and `baseOrderIds` (the same entries in queue order) lets shuffle
    // off restore the natural order.
    const shuffle = this.engine.shuffle();
    const baseOrderIds = shuffle
      ? [...orderItems]
          .sort((a, b) => a.queueIndex - b.queueIndex)
          .map((item) => item.entry.entryId)
      : undefined;
    const setQueue = (): SessionCommand => ({
      type: 'setQueue',
      order: entries,
      cursor: 0,
      autoplay: this.localPlaybackActive(),
      shuffle,
      ...(shuffle && baseOrderIds ? { shuffled: true, baseOrderIds } : {}),
      ...(stack.length ? { stack } : {}),
    });
    for (const entry of [...entries, ...stack]) this.publishEntryIds.add(entry.entryId);
    let result = await this.command(setQueue());
    if (!result.ok) {
      // One retry with the same entry ids, as in startSession.
      result = await this.command(setQueue());
    }
    if (!result.ok) {
      this.publishFailed(result.error ?? 'Could not start playback.');
      return null;
    }

    const steps: SessionCommand[] = [
      { type: 'setRepeat', repeat: this.engine.repeat() },
    ];
    const positionSec = this.engine.position();
    if (positionSec > 0) steps.push({ type: 'seek', positionSec });
    steps.push({
      type: 'transfer',
      target: {
        kind: 'device',
        clientId: this.clientId(),
        deviceId: this.deviceId(),
      },
    });
    for (const step of steps) {
      const stepResult = await this.command(step);
      if (!stepResult.ok) {
        // Do not leave a half-published queue on the server.
        await this.discardQueue();
        this.publishFailed(stepResult.error ?? 'Could not transfer playback.');
        return null;
      }
    }
    // The engine may have paused while the queue was sent. The server still
    // has `playing` from autoplay, so follow the transfer with a pause. Checked
    // after the transfer, which covers a pause made during its await too.
    if (!this.localPlaybackActive()) {
      const paused = await this.command({ type: 'pause' });
      if (!paused.ok) {
        await this.discardQueue();
        this.publishFailed(paused.error ?? 'Could not pause playback.');
        return null;
      }
    }
    this.error.set(null);
    return entries[0]?.id ?? null;
  }

  private publishFailed(error: string): false {
    this.publishRetryAt = Date.now() + PUBLISH_RETRY_MS;
    this.recordRefusal(error);
    return false;
  }

  /** Whether this client's engine is playing (or starting to) a loaded track. */
  private localPlaybackActive(): boolean {
    return (
      (this.engine.status() === 'playing' || this.engine.intendsToPlay) &&
      this.engine.current() !== null
    );
  }

  /**
   * This device plays its own queue but lost the session target: keep playing
   * and publish it again. Backs off after a failed publish.
   */
  private keepLocalPlayback(): void {
    if (Date.now() < this.publishRetryAt) return;
    void this.publishLocal();
  }

  /** Record a refused command; a transport failure just means local playback. */
  private recordRefusal(error: string): void {
    if (QUIET_COMMAND_FAILURES.has(error)) return;
    this.error.set(error);
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
      this.error.set(null);
      return null;
    }
    await this.settings.ready();
    this.deviceId.set(this.settings.deviceId());
    this.error.set(null);

    let entries = order.map((track) => toSessionTrack(track, newEntryId()));
    // Your Stack is one account-wide list: it carries over the new queue with
    // its entry ids kept. Sent as `stack`, never inside `order`. The session's
    // stack is the one that carries over while it owns playback.
    const carried: readonly StackEntry[] = this.ownsPlayback()
      ? this.remoteStackEntries()
      : this.engine.stackEntries();
    let stack = carried.map((entry) => toSessionTrack(entry.track, entry.entryId));
    // The server refuses the whole setQueue when order + stack exceed its caps,
    // so the autofill tail (then old history) is dropped first. The kept range
    // is a slice, so `order[fit.start + i]` still matches `entries[i]`.
    const fit = fitSessionOrder(entries, stack, cursor);
    entries = entries.slice(fit.start, fit.end);

    // A new queue started while a speaker owns playback is queued ON the
    // speaker, so its `local:` imports must be uploaded before `setQueue`.
    // A stale cast target does not count: this client takes playback over.
    if (this.followsCastTarget()) {
      const batch = await this.uploadLocalEntries([...entries, ...stack]);
      if (batch && !batch.ok) {
        this.error.set(batch.error);
        return null;
      }
      if (batch) {
        const withUpload = (entry: SessionTrack): SessionTrack => {
          const uploadId = batch.ids.get(entry.entryId);
          return uploadId ? { ...entry, uploadId } : entry;
        };
        entries = entries.map(withUpload);
        stack = stack.map(withUpload);
      }
      this.castUpload.set(null);
    }

    const setQueue: SessionCommand = {
      type: 'setQueue',
      order: entries,
      cursor: clampCursor(entries.length, fit.cursor),
      autoplay: opts.autoplay,
      shuffle: opts.shuffle,
      ...(stack.length ? { stack } : {}),
    };
    let result = await this.command(setQueue);
    if (!result.ok) {
      // One retry with the same entry ids; a transient failure must not make
      // the queue change identity underneath the server.
      result = await this.command(setQueue);
    }
    if (!result.ok) {
      this.recordRefusal(result.error ?? 'Could not start playback.');
      return null;
    }

    // The server accepted the queue: remember the uploads now so the next cast
    // transfer reuses them instead of reading and uploading the files again.
    for (let i = 0; i < entries.length; i++) {
      const uploadId = entries[i]?.uploadId;
      const track = order[fit.start + i];
      if (uploadId && track) {
        this.castUploadIds.set(this.castUploadKey(track), uploadId);
      }
    }

    // The server keeps its repeat mode across setQueue, so set it explicitly
    // before any transfer. A failure aborts before playback moves. A null
    // result makes the caller play locally, so the queue just sent must not
    // stay on the server too (it may already autoplay on the current target).
    const repeat = await this.command({
      type: 'setRepeat',
      repeat: opts.repeat,
    });
    if (!repeat.ok) {
      await this.discardQueue();
      this.recordRefusal(repeat.error ?? 'Could not set the repeat mode.');
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
        await this.discardQueue();
        this.recordRefusal(transfer.error ?? 'Could not transfer playback.');
        return null;
      }
    }
    return entries.map((entry) => entry.entryId);
  }

  /**
   * Undo the `setQueue` that `startSession` just sent after a later step
   * failed. Only that queue is removed: an empty `setQueue` keeps the current
   * target. `clear` is not used because it also drops a device target, which
   * may have been set before this call. Best effort; the caller plays locally.
   */
  private async discardQueue(): Promise<void> {
    await this.command({
      type: 'setQueue',
      order: [],
      cursor: -1,
      autoplay: false,
      shuffle: false,
    });
  }

  /** Report an observation to the server. Target only; throttled. */
  report(
    reason: SessionReportMessage['reason'],
    extra?: Partial<
      Pick<SessionReportMessage, 'entryId' | 'durationSec' | 'playing'>
    >,
  ): void {
    if (!this.started || !this.port || !this.isTarget()) return;
    if (this.applyingRemote || this.holdingEcho()) return;
    this.emitReport(reason, extra);
  }

  /**
   * Report a seek this client just made, bypassing the tick throttle and the
   * playing check: the server must learn the new anchor at once, or its next
   * tick still carries the old position and drags the engine back to it.
   * While a publish or held echo is pending the seek is recorded and sent when
   * the hold ends: the grace window must cover it, or a stale tick drags the
   * engine back.
   */
  reportSeek(): void {
    if (!this.started || !this.port) return;
    if (this.applyingRemote) return;
    // During a publish the target is not this client until its transfer is
    // echoed, so the seek is recorded first: the hold reports it at the end.
    if (this.publishing) {
      this.lastLocalSeekAt = Date.now();
      this.seekHeld = true;
      return;
    }
    if (!this.isTarget()) return;
    this.lastLocalSeekAt = Date.now();
    if (this.holdingEcho()) {
      this.seekHeld = true;
      return;
    }
    this.emitReport('tick', undefined, true);
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
    this.resetAdoption();
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
    this.resetAdoption();
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
    this.cancelRepublish();
  }

  private stopTargetPlayback(options: { keepPlaying?: boolean } = {}): void {
    const wasActive = this.targetActive;
    this.targetActive = false;
    this.applyingRemote = false;
    this.applyPending = null;
    this.pendingIncoming = null;
    this.needsGesture.set(false);
    // Local-only playback must survive a session that never owned the engine.
    if (wasActive && !options.keepPlaying) void this.engine.pause();
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
    this.cancelRepublish();
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
        // The engine ignores this while its track is loading or is not the
        // one the session cursor names (the outgoing audio must not scrub).
        const expectedTrackId = next.order[next.cursor]?.id;
        if (
          this.isTarget() &&
          expectedTrackId !== undefined &&
          Date.now() - this.lastLocalSeekAt > LOCAL_SEEK_GRACE_MS
        ) {
          void this.engine.seekIfDrifted(
            anchoredPosition(next, Date.now() + this.serverSkew()),
            SEEK_TOLERANCE_SEC,
            expectedTrackId,
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
    // Nothing owns the session any more: an empty session (server restart), or
    // the target cleared by the server after a long silence (the queue stays).
    // A queue playing here keeps playing and is published again. A user's
    // `clear` also clears the target but empties `order`, so it still stops.
    const ownerGone =
      next === null || (next.target === null && next.order.length > 0);
    if (!nowTarget && ownerGone && this.localPlaybackActive()) {
      // A publish in flight already re-establishes the target. Its own echo
      // (target null) must not restart it or hold a second publish. Only a
      // genuine loss is remembered: if the publish does not end with a target,
      // the finally publishes again. The old target's pending state and status
      // are dropped so a later echo cannot treat this client as still targeted.
      if (this.publishing) {
        if (!this.isOwnPublishEcho(next)) this.ownerGoneWhilePublishing = true;
        this.targetActive = false;
        this.applyPending = null;
        return;
      }
      this.stopTargetPlayback({ keepPlaying: true });
      this.keepLocalPlayback();
      return;
    }
    if (!next) {
      if (wasTarget) this.stopTargetPlayback();
      return;
    }
    if (nowTarget) {
      this.targetActive = true;
      // The server confirms this client owns a queue: a republish has succeeded.
      if ((next?.order.length ?? 0) > 0) this.republishStreak = 0;
      if (this.publishing) this.pendingIncoming = next;
      else this.scheduleApply(next);
    } else if (wasTarget) {
      // This client stopped being the target: stop owning the speakers.
      this.stopTargetPlayback();
    }
    if (!nowTarget) this.adoptEarlierInstance(next);
  }

  /**
   * An earlier instance of this same install holds the target (the app was
   * relaunched, or another tab on the web). That instance is dead on native,
   * so adopt it at once; on the web a sibling tab may be live, so adopt only a
   * stale target. Adoption pauses first (a transfer keeps `playing`, which
   * would autoplay on launch), then transfers to this client. One attempt per
   * old target clientId, so the server's own pause revision cannot loop.
   */
  private adoptEarlierInstance(state: SessionState): void {
    const target = state.target;
    if (target?.kind !== 'device') return;
    if (target.deviceId !== this.deviceId()) return;
    if (target.clientId === this.clientId()) return;
    if (detectPlatform() === 'web' && !state.targetStale) return;
    if (target.clientId === this.adoptedFrom) return;
    if (target.clientId === this.adoptingFrom) return;
    this.adoptingFrom = target.clientId;
    void this.runAdoption(target.clientId, state.playing);
  }

  /**
   * Pause (if playing) then transfer from `oldClientId` to this client. A
   * failed pause or transfer clears `adoptingFrom` so the next state retries;
   * a pause that already succeeded is not repeated. Nothing is recorded as
   * adopted until the transfer succeeds.
   */
  private async runAdoption(oldClientId: string, wasPlaying: boolean): Promise<void> {
    const epoch = this.connectionEpoch;
    const fail = (error: string | undefined) => {
      if (epoch !== this.connectionEpoch) return;
      this.adoptingFrom = '';
      this.recordRefusal(error ?? 'Could not take over playback.');
    };

    if (wasPlaying && this.pausedFrom !== oldClientId) {
      const paused = await this.command({ type: 'pause' });
      if (epoch !== this.connectionEpoch) return;
      if (!paused.ok) return fail(paused.error);
      this.pausedFrom = oldClientId;
    }

    // The round-trip may have moved the target on; only transfer from the old instance.
    const target = this.session()?.target;
    if (target?.kind !== 'device' || target.clientId !== oldClientId) {
      if (epoch === this.connectionEpoch) this.adoptingFrom = '';
      return;
    }

    const moved = await this.command({
      type: 'transfer',
      target: {
        kind: 'device',
        clientId: this.clientId(),
        deviceId: this.deviceId(),
      },
    });
    if (epoch !== this.connectionEpoch) return;
    if (!moved.ok) return fail(moved.error);
    this.adoptingFrom = '';
    this.adoptedFrom = oldClientId;
    this.pausedFrom = '';
  }

  /** Forget adoption progress: disconnect, sign-out and reconnect start fresh. */
  private resetAdoption(): void {
    this.connectionEpoch++;
    this.adoptedFrom = '';
    this.adoptingFrom = '';
    this.pausedFrom = '';
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

  private scheduleApply(state: SessionState, keepPosition = false): void {
    this.applyPending = { state, keepPosition };
    this.applyingRemote = true;
    if (this.applyRunning) return;
    this.applyRunning = true;
    void this.runApplies();
  }

  private async runApplies(): Promise<void> {
    try {
      while (this.applyPending) {
        const { state, keepPosition } = this.applyPending;
        this.applyPending = null;
        if (!this.isTarget()) continue;
        try {
          await this.applyTarget(state, keepPosition);
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

  private async applyTarget(
    state: SessionState,
    keepPosition: boolean,
  ): Promise<void> {
    await this.applyState(state, keepPosition);
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
    await this.applyState(state, keepPosition);
  }

  private async applyState(
    state: SessionState,
    keepPosition = false,
  ): Promise<void> {
    // Age of the anchor at receipt, before any await: a command's state is
    // fresh here, while a join or late state is already aged.
    const anchorAtReceipt = anchoredPosition(state, Date.now() + this.serverSkew());
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

    // The song already loaded here keeps playing: no reload and no seek to the
    // anchor (the drift check below handles that within tolerance). This is
    // the echo of this device's own publish.
    const sameSong = this.engine.current()?.id === tracks[cursor]?.id;
    // A different song whose stored anchor is at its start and was received
    // fresh was just started by a command. The anchor is stale by the time it
    // loads (buffering takes seconds), so a catch-up seek would skip the start.
    // Mid-song joins, and states already aged at receipt, still seek.
    const freshStart =
      !sameSong &&
      state.positionSec <= FRESH_START_SEC &&
      anchorAtReceipt <= FRESH_START_RECEIPT_SEC;
    const trackId = tracks[cursor]?.id;
    if (freshStart && trackId !== undefined) {
      this.freshStart = { trackId, updatedAt: state.updatedAt };
    } else if (!sameSong) {
      this.freshStart = null;
    }
    // A same-song state not newer than the start is an echo of it: its anchor
    // is from before the track started, so a catch-up seek would skip ahead.
    // A newer state (a remote seek, or the forced tick's re-base) still corrects.
    const startEcho =
      sameSong &&
      this.freshStart?.trackId === trackId &&
      state.updatedAt <= this.freshStart.updatedAt;
    if (sameSong && this.freshStart?.trackId === trackId && !startEcho) {
      this.freshStart = null;
    }
    await this.engine.applyOrder(tracks, cursor, {
      autoplay: state.playing,
      positionSec: sameSong ? undefined : state.positionSec,
      sessionMode: true,
      mediaKey: sessionMediaKey,
      // The engine keeps the same Your Stack as the session, so next, previous
      // and native skips agree with the server.
      stackEntryIds: state.stack ?? [],
    });
    if (!this.isTarget()) return;
    // The same song kept its position: a seek held during a publish is newer
    // than this anchor, so correcting to it would undo the seek.
    if (!(keepPosition && sameSong) && !freshStart && !startEcho) {
      // A reload starts at 0, and the anchor moved while the state travelled.
      // seekIfDrifted is a no-op unless this track has settled.
      await this.engine.seekIfDrifted(
        anchoredPosition(state, Date.now() + this.serverSkew()),
        SEEK_TOLERANCE_SEC,
        tracks[cursor]?.id,
      );
    }
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
      // A load still in flight with play intent starts playback itself when it
      // is ready. `play()` is a no-op while loading, so that is not a refusal:
      // reporting `playing: false` here would pause the session for a track
      // that is about to play.
      const loadingToPlay =
        this.engine.status() === 'loading' && this.engine.intendsToPlay;
      if (loadingToPlay && !blocked) {
        this.needsGesture.set(false);
        // The re-base for a fresh start waits for the audio to start.
        if (freshStart && trackId !== undefined) this.pendingFreshTick = trackId;
        return;
      }
      if (blocked || this.engine.status() !== 'playing') {
        // Autoplay was refused: stay paused, offer the one-tap resume, and
        // tell the server so other controllers do not show a phantom play.
        this.needsGesture.set(true);
        this.emitReport('playing');
      } else {
        this.needsGesture.set(false);
        // A fresh start begins at 0 when audio actually starts; a forced tick
        // tells the server to re-base its anchor (and broadcast it) to the real
        // start, not the click time.
        if (freshStart) this.emitReport('tick', undefined, true);
      }
    } else {
      await this.engine.pause();
      this.needsGesture.set(false);
    }
  }

  // ---- Target: reports ----------------------------------------------------

  /**
   * Session entry of the engine's current track. The engine queue mirrors the
   * session order only after an applied state; a publish sends just the
   * current and upcoming tracks, so the index can point elsewhere. The index
   * is used when it names the current track, otherwise the track id is matched.
   */
  private engineEntryId(): string {
    const state = this.session();
    const index = this.engine.currentIndex();
    if (!state || index < 0) return '';
    const current = this.engine.current();
    const atIndex = state.order[index];
    if (atIndex && atIndex.id === current?.id) return atIndex.entryId;
    if (!current) return '';
    return state.order.find((entry) => entry.id === current.id)?.entryId ?? '';
  }

  private emitReport(
    reason: SessionReportMessage['reason'],
    extra?: Partial<
      Pick<SessionReportMessage, 'entryId' | 'durationSec' | 'playing'>
    >,
    force = false,
  ): void {
    const port = this.port;
    const state = this.session();
    if (!port || !state) return;
    const entryId =
      extra?.entryId ?? (this.engineEntryId() || this.currentEntryId() || '');
    if (!entryId) return;

    const playing = extra?.playing ?? this.engine.status() === 'playing';
    const now = Date.now();
    if (reason === 'tick') {
      // No anchor while paused, and at most one tick per throttle window;
      // a seek is always reported.
      if (!force && (!playing || now - this.lastReportAt < REPORT_THROTTLE_MS)) {
        return;
      }
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
      // Covers seeks made while loading: until the media is in the engine,
      // `position()` is the previous track's or a seek made before the media
      // arrived, not this track's. Report 0 rather than anchor it far in.
      positionSec: this.engine.mediaLoaded ? this.engine.position() : 0,
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
