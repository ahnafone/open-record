import {
  DOCUMENT,
  DestroyRef,
  Injectable,
  computed,
  effect,
  inject,
  untracked,
} from '@angular/core';
import { SETTINGS_KEYS, StoragePort, type JsonValue } from '@open-record/storage';
import { AuthStore } from './auth.store';
import { PlayerStore } from './player.store';
import { SessionStore } from './session.store';
import {
  ExclusionSyncPort,
  NetworkStatusPort,
  type SyncExclusion,
} from './ports';

/** Wait after a local exclusion before pushing it (a burst goes up together). */
const PUSH_DEBOUNCE_MS = 2_000;
/** Wait before retrying a failed push or pull. */
const RETRY_MS = 30_000;
/** Foreground resumes closer together than this do not pull again. */
const PULL_THROTTLE_MS = 60_000;
/** Rows per push request (the `record_exclusions` per-call limit). */
const PUSH_CHUNK = 2_000;
/** An exclusion keeps a song out of shuffled fills for this long. */
export const EXCLUSION_WINDOW_MS = 12 * 60 * 60 * 1000;

/** What the account is known to hold: track id -> exclusion time (epoch ms). */
interface Known {
  userId: string;
  times: Map<string, number>;
}

/**
 * Recent-exclusion sync over the signed-in account. The local record (in
 * `PlayerStore`) is newest-wins per song. An exclusion this device stamped
 * after the last time it pushed or pulled that song is pushed, debounced. A
 * pull merges the account's rows into the local record (newest wins, no
 * version bump), so applying a pull never produces a push by itself.
 *
 * `known` holds what the account is known to hold, kept per account in
 * storage. A push records it only after the write succeeds, so a failed push
 * is retried in full. Sign-out or an account switch forgets `known` and the
 * previous account's recent songs.
 *
 * Pulls run on sign-in, when the network comes back, when the app returns to
 * the foreground and on start. Remote rows outside the 12-hour window are
 * ignored. Local-only (`local:`) tracks never sync. Without an
 * `ExclusionSyncPort`, or when signed out, nothing here runs. While a session
 * owns playback (Cast, another device) nothing is written or merged.
 *
 * Never throws to the UI: a failed push or pull retries after `RETRY_MS`.
 */
@Injectable({ providedIn: 'root' })
export class ExclusionSyncStore {
  private readonly port = inject(ExclusionSyncPort, { optional: true });
  private readonly auth = inject(AuthStore);
  private readonly player = inject(PlayerStore);
  private readonly session = inject(SessionStore);
  private readonly storage = inject(StoragePort);
  private readonly network = inject(NetworkStatusPort, { optional: true });
  private readonly document = inject(DOCUMENT, { optional: true });
  private readonly destroyRef = inject(DestroyRef);

  /** Exclusion sync is built into this app (an `ExclusionSyncPort` is provided). */
  readonly available = !!this.port;
  /** Signed in with exclusion sync available: syncing can run. */
  readonly enabled = computed(() => this.available && this.auth.signedIn());

  private started = false;
  private seenUser: string | null = null;
  /** Bumped on every account change: a write that started earlier must not record state. */
  private generation = 0;
  private known: Known | null = null;
  private chain: Promise<void> = Promise.resolve();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pullTimer: ReturnType<typeof setTimeout> | null = null;
  private lastPull = 0;
  private offNetwork: (() => void) | null = null;
  private onVisibility: (() => void) | null = null;

  constructor() {
    if (!this.port) return;
    // Sign-in: pull the account's exclusions. Any change of account (sign-out,
    // or a direct switch A -> B) forgets the previous account's recent songs and
    // sync state on this device before the new account's are pulled.
    effect(() => {
      const id = this.auth.signedIn() ? (this.auth.user()?.id ?? null) : null;
      if (id === this.seenUser) return;
      const previous = this.seenUser;
      this.seenUser = id;
      untracked(() => {
        this.generation++;
        const generation = this.generation;
        if (previous && id !== previous) this.forgetAccount();
        // First sign-in on this device: if the stored state is another account's
        // (its session expired while the app was closed), clear it before any push
        // or pull for this account runs. Queued on the chain, so it runs first.
        if (!previous && id) {
          this.run(() => this.adoptStoredAccount(id, generation)).catch(
            () => undefined,
          );
        }
        this.lastPull = 0;
        if (id && this.started) this.pullNow();
      });
    });
    // A local exclusion was stamped (or playback ownership changed): push soon.
    effect(() => {
      this.player.exclusionVersion();
      this.session.ownsPlayback();
      untracked(() => {
        if (this.started && this.enabled()) this.scheduleSync(PUSH_DEBOUNCE_MS);
      });
    });
  }

  /**
   * Begin syncing. Call after the saved queue is restored. A no-op when
   * already started.
   */
  start(): void {
    if (!this.port || this.started) return;
    this.started = true;
    if (this.seenUser) this.pullNow();
    this.offNetwork =
      this.network?.onChange((state) => {
        if (state.connected) this.pullNow();
      }) ?? null;
    const doc = this.document;
    if (doc) {
      this.onVisibility = () => {
        // Leaving the app: push now, so a pending exclusion survives the app closing.
        if (doc.visibilityState === 'hidden')
          void this.push().catch(() => undefined);
        else if (Date.now() - this.lastPull > PULL_THROTTLE_MS) this.pullNow();
      };
      doc.addEventListener('visibilitychange', this.onVisibility);
    }
    this.destroyRef.onDestroy(() => {
      this.offNetwork?.();
      this.offNetwork = null;
      if (this.onVisibility) {
        doc?.removeEventListener('visibilitychange', this.onVisibility);
        this.onVisibility = null;
      }
      this.cancelTimers();
    });
  }

  /** Push this device's pending exclusions. Rejects when the write fails. */
  push(): Promise<void> {
    return this.run(() => this.pushPending());
  }

  /**
   * Push pending exclusions, then merge the account's into this device.
   * Rejects when either step fails; the pending exclusions stay for a retry.
   */
  pull(): Promise<void> {
    this.lastPull = Date.now();
    return this.run(async () => {
      // The pull runs even when the push failed: `known` only moves after a
      // successful write, so the merge does not lose the unpushed exclusions.
      let pushError: unknown = null;
      try {
        await this.pushPending();
      } catch (err) {
        pushError = err;
      }
      await this.pullRemote();
      if (pushError) throw pushError;
    });
  }

  /** `pull()` that never rejects; a failure retries later. */
  private pullNow(): void {
    this.pull().catch(() => this.schedulePull(RETRY_MS));
  }

  /** Serialize pushes and pulls so they never interleave. */
  private run(task: () => Promise<void>): Promise<void> {
    const next = this.chain.then(task);
    this.chain = next.catch(() => undefined);
    return next;
  }

  /** Debounced push. A failure retries after `RETRY_MS`. Never rejects. */
  private scheduleSync(delay: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.push().catch(() => this.scheduleSync(RETRY_MS));
    }, delay);
  }

  /** A pull again after `delay`; a later pull request replaces it. */
  private schedulePull(delay: number): void {
    if (this.pullTimer) clearTimeout(this.pullTimer);
    this.pullTimer = setTimeout(() => {
      this.pullTimer = null;
      this.pullNow();
    }, delay);
  }

  private cancelTimers(): void {
    if (this.timer) clearTimeout(this.timer);
    if (this.pullTimer) clearTimeout(this.pullTimer);
    this.timer = null;
    this.pullTimer = null;
  }

  /** Account change: this device keeps no previous account's sync state or recent songs. */
  private forgetAccount(): void {
    this.cancelTimers();
    this.player.clearRecentExclusions();
    this.known = { userId: '', times: new Map() };
    void this.saveKnown();
  }

  /** First sign-in: drop stored state that belongs to a different account. */
  private async adoptStoredAccount(me: string, generation: number): Promise<void> {
    const known = await this.loadKnown();
    if (generation !== this.generation) return;
    if (known.userId && known.userId !== me) this.forgetAccount();
  }

  private async pushPending(): Promise<void> {
    const port = this.port;
    const me = this.auth.user()?.id;
    if (!port || !this.enabled() || !me) return;
    if (this.session.ownsPlayback()) return;
    const generation = this.generation;

    const known = await this.loadKnown();
    // Re-checked after the await: a session may have taken playback meanwhile.
    if (this.session.ownsPlayback()) return;
    if (generation !== this.generation || this.auth.user()?.id !== me) return;
    // State stored for another account is not this account's: push everything.
    const sent = known.userId === me ? known.times : new Map<string, number>();

    const cutoff = Date.now() - EXCLUSION_WINDOW_MS;
    const pending: SyncExclusion[] = [];
    for (const [trackId, at] of Object.entries(this.player.recentExclusions())) {
      if (trackId.startsWith('local:') || !Number.isFinite(at) || at < cutoff)
        continue;
      const before = sent.get(trackId);
      if (before === undefined || at > before) pending.push({ trackId, at });
    }

    for (let i = 0; i < pending.length; i += PUSH_CHUNK) {
      const chunk = pending.slice(i, i + PUSH_CHUNK);
      await port.push(chunk);
      // A sign-out or account switch during the write: this chunk is not the
      // current account's state, so it is not recorded.
      if (
        generation !== this.generation ||
        !this.enabled() ||
        this.auth.user()?.id !== me
      )
        return;
      // Recorded per chunk, after its write, so a failed chunk is retried.
      await this.recordKnown(me, chunk);
    }
  }

  private async pullRemote(): Promise<void> {
    const port = this.port;
    const me = this.auth.user()?.id;
    if (!port || !this.enabled() || !me) return;
    if (this.session.ownsPlayback()) return;
    const generation = this.generation;

    const remote = await port.pull();
    // Signed out, switched account, or a session took playback: leave it alone.
    if (
      !this.enabled() ||
      generation !== this.generation ||
      this.auth.user()?.id !== me ||
      this.session.ownsPlayback()
    ) {
      return;
    }

    // Untrusted rows: drop unusable ids, local files and rows outside the window.
    const cutoff = Date.now() - EXCLUSION_WINDOW_MS;
    const fresh = new Map<string, number>();
    for (const [trackId, at] of Object.entries(remote)) {
      if (
        !trackId ||
        trackId.startsWith('local:') ||
        !Number.isFinite(at) ||
        at < cutoff
      )
        continue;
      fresh.set(trackId, at);
    }
    this.player.mergeRemoteExclusions(Object.fromEntries(fresh));

    // The account holds the remote rows now; earlier records are kept, since a
    // row the cap evicted is still known to the account until it expires. Per
    // song the later time wins, so a smaller remote time never lowers what this
    // device already pushed (which would trigger a repeat push).
    const known = await this.loadKnown();
    // Signed out or switched while the stored state loaded: do not write it.
    if (generation !== this.generation) return;
    const times = new Map<string, number>(
      known.userId === me ? known.times : [],
    );
    for (const [trackId, at] of fresh) {
      times.set(trackId, Math.max(at, times.get(trackId) ?? 0));
    }
    this.known = { userId: me, times };
    await this.saveKnown();
  }

  /** Record that the account now holds `items` (the later time per song). */
  private async recordKnown(
    me: string,
    items: readonly SyncExclusion[],
  ): Promise<void> {
    const times =
      this.known?.userId === me ? this.known.times : new Map<string, number>();
    for (const item of items) {
      times.set(item.trackId, Math.max(item.at, times.get(item.trackId) ?? 0));
    }
    this.known = { userId: me, times };
    await this.saveKnown();
  }

  /** The stored sync state (loaded once), for whichever account wrote it. */
  private async loadKnown(): Promise<Known> {
    if (!this.known) {
      let stored: unknown = null;
      try {
        stored = await this.storage.settings.get(SETTINGS_KEYS.exclusionSync);
      } catch (err) {
        console.error('Could not load exclusion sync state.', err);
      }
      this.known = parseKnown(stored) ?? { userId: '', times: new Map() };
    }
    return this.known;
  }

  private async saveKnown(): Promise<void> {
    if (!this.known) return;
    // Entries past the window are dropped: they no longer exclude anything.
    const cutoff = Date.now() - EXCLUSION_WINDOW_MS;
    for (const [trackId, at] of this.known.times) {
      if (at < cutoff) this.known.times.delete(trackId);
    }
    const value = {
      userId: this.known.userId,
      times: Object.fromEntries(this.known.times),
    };
    try {
      await this.storage.settings.set(
        SETTINGS_KEYS.exclusionSync,
        value as unknown as JsonValue,
      );
    } catch (err) {
      console.error('Could not save exclusion sync state.', err);
    }
  }
}

function parseKnown(value: unknown): Known | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as { userId?: unknown; times?: unknown };
  if (typeof v.userId !== 'string' || !v.times || typeof v.times !== 'object')
    return null;
  const times = new Map<string, number>();
  for (const [trackId, at] of Object.entries(v.times)) {
    if (typeof at === 'number' && Number.isFinite(at)) times.set(trackId, at);
  }
  return { userId: v.userId, times };
}
