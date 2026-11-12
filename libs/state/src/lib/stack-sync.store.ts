import {
  DOCUMENT,
  DestroyRef,
  Injectable,
  computed,
  effect,
  inject,
  untracked,
} from '@angular/core';
import type { StackEntry } from '@open-record/player';
import {
  SETTINGS_KEYS,
  StoragePort,
  type JsonValue,
} from '@open-record/storage';
import { AuthStore } from './auth.store';
import { PlayerStore } from './player.store';
import {
  NetworkStatusPort,
  StackFullError,
  StackSyncPort,
  type SyncStackEntry,
  type SyncStackMove,
  type SyncTrack,
} from './ports';
import { fitSyncTrack, fromSyncTrack } from './sync-merge';

/** Wait after a local stack change before pushing it (a burst goes up together). */
const PUSH_DEBOUNCE_MS = 2_000;
/** Wait before retrying a failed push or pull. */
const RETRY_MS = 30_000;
/** Foreground resumes closer together than this do not pull again. */
const PULL_THROTTLE_MS = 60_000;

/** Entries the account is known to hold: entry id -> position in the stack. */
interface Known {
  userId: string;
  entries: Map<string, number>;
}

interface SyncedEntry {
  entry: StackEntry;
  position: number;
}

/**
 * Your Stack sync over the signed-in account. Each entry is its own cloud row:
 * an add is an insert, a removal (manual, or played through) is a delete, and
 * a clear deletes the entries this device knows about. Entries another device
 * added but this one has not pulled yet are left alone, so adds from different
 * devices never conflict. Positions are spaced (`POSITION_SPACING`): a new entry
 * takes a midpoint and only a full gap renumbers the stack, so removals and
 * play-throughs rewrite no other row. A position change is an update to an
 * existing row, never an upsert, so it cannot re-create a row another device
 * deleted.
 *
 * The local stack is diffed against `known`, the entries the account is known
 * to hold, which is kept per account in storage. Applying a pull makes the
 * local stack equal `known`, so the change it causes produces no push: there
 * is no loop without any flag.
 *
 * Pushes are debounced after local changes. Pulls run on sign-in, when the
 * network comes back, when the app returns to the foreground and on start
 * (after the saved queue is restored). A pull runs after a push attempt even
 * when that push failed; the failed push is retried afterwards. A pull keeps
 * this device's unpushed adds (in neither `known` nor the remote) after the
 * remote rows, so a failed push is not lost. Only a full stack (`StackFullError`)
 * drops them.
 *
 * Local-only (`local:`) tracks never sync. Without a `StackSyncPort`, or when
 * signed out, the stack stays on this device and nothing here runs. While a
 * session owns playback (Cast, another device) the synced stack is the
 * session's stack: it is pushed and pulled the same way, and a pull applies
 * through the session (`setStack`). While that session stack is not known yet
 * (no state, or a partial one), nothing is pushed or pulled and a pull is
 * retried later: an unknown stack must not read as an empty one.
 */
@Injectable({ providedIn: 'root' })
export class StackSyncStore {
  private readonly port = inject(StackSyncPort, { optional: true });
  private readonly auth = inject(AuthStore);
  private readonly player = inject(PlayerStore);
  private readonly storage = inject(StoragePort);
  private readonly network = inject(NetworkStatusPort, { optional: true });
  private readonly document = inject(DOCUMENT, { optional: true });
  private readonly destroyRef = inject(DestroyRef);

  /** Your Stack sync is built into this app (a `StackSyncPort` is provided). */
  readonly available = !!this.port;
  /** Signed in with stack sync available: syncing can run. */
  readonly enabled = computed(() => this.available && this.auth.signedIn());

  private started = false;
  private seenUser: string | null = null;
  /** Bumped on every account change: a push that started earlier must not record state. */
  private generation = 0;
  /** Entries the cloud refused (this session only); they stay on this device. */
  private readonly rejected = new Set<string>();
  private known: Known | null = null;
  private chain: Promise<void> = Promise.resolve();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pullTimer: ReturnType<typeof setTimeout> | null = null;
  private lastPull = 0;
  private offNetwork: (() => void) | null = null;
  private onVisibility: (() => void) | null = null;

  constructor() {
    if (!this.port) return;
    // Sign-in (or a switch of account): pull the account's stack. Sign-out
    // forgets the account's stack and sync state on this device.
    effect(() => {
      const id = this.auth.signedIn() ? (this.auth.user()?.id ?? null) : null;
      if (id === this.seenUser) return;
      const previous = this.seenUser;
      this.seenUser = id;
      untracked(() => {
        this.generation++;
        this.rejected.clear();
        if (!id && previous) this.forgetAccount();
        this.lastPull = 0;
        if (id && this.started) this.pullNow();
      });
    });
    // Your Stack changed (add, remove, reorder, a play-through, a remote apply),
    // on this device or in the session that owns playback. Safe for applied
    // pulls: the diff against `known` is then empty.
    effect(() => {
      this.player.stackEntries();
      // A session stack that became known is a change too (its push was skipped).
      this.player.stackKnown();
      untracked(() => {
        if (this.started && this.enabled()) this.scheduleSync(PUSH_DEBOUNCE_MS);
      });
    });
  }

  /**
   * Begin syncing. Call after the saved queue is restored, so a pull cannot
   * apply over the restore. A no-op when already started.
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
        // Leaving the app: push now, so a pending change survives the app closing.
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

  /** Push this device's pending stack changes. Rejects when the write fails. */
  push(): Promise<void> {
    return this.run(() => this.pushPending());
  }

  /**
   * Push pending changes, then apply the account's stack to this device.
   * Rejects when either step fails; the pending changes stay for a retry.
   */
  pull(): Promise<void> {
    this.lastPull = Date.now();
    return this.run(async () => {
      // The pull runs even when the push failed: `known` only moves after a
      // successful write, so the pull's diff stays correct. The push failure
      // still rejects, so the caller retries it.
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

  /** `pull()` that never rejects; a failure retries later (push and pull). */
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

  /**
   * Sign-out: this device keeps no account's stack or sync state. The stack
   * clears through the store, so the change effect finds nothing to push.
   */
  private forgetAccount(): void {
    this.cancelTimers();
    // The stack must not survive into the next account's sync, even when a
    // session holds it: the session's stack is cleared too (best effort).
    this.player.discardStackOnSignOut();
    this.known = { userId: '', entries: new Map() };
    void this.saveKnown();
  }

  /**
   * While a session owns playback and its stack is not known yet, the stack
   * this device sees is not the account's: nothing is pushed or pulled, and a
   * pull is scheduled for later. A loaded session stack (even an empty one)
   * syncs as it is.
   */
  private stackUnknown(): boolean {
    if (this.player.stackKnown()) return false;
    this.schedulePull(RETRY_MS);
    return true;
  }

  private async pushPending(): Promise<void> {
    const port = this.port;
    const me = this.auth.user()?.id;
    if (!port || !this.enabled() || !me) return;
    if (this.stackUnknown()) return;
    if ((await port.userId()) !== me) return;
    const generation = this.generation;

    const known = await this.loadKnown();
    // The stack on this device belongs to another account: it is replaced by
    // that account's pull, never pushed into this one.
    if (known.userId && known.userId !== me) return;
    const stored = known.userId === me ? known.entries : new Map<string, number>();

    // Entries that cannot be a row stay on this device only: a track too large
    // even after trimming, or one the cloud rejected. Neither blocks the rest.
    const synced: { entryId: string; track: SyncTrack }[] = [];
    for (const entry of this.syncedStack()) {
      if (this.rejected.has(entry.entryId)) continue;
      const track = fitSyncTrack(entry.track);
      if (track) synced.push({ entryId: entry.entryId, track });
    }
    const ids = synced.map((s) => s.entryId);
    const localIds = new Set(ids);
    const remove = [...stored.keys()].filter((id) => !localIds.has(id));
    const positions = planPositions(ids, stored) ?? renumber(ids);

    const upsert: SyncStackEntry[] = [];
    const move: SyncStackMove[] = [];
    synced.forEach((s, i) => {
      const position = positions[i];
      if (position === undefined) return;
      const before = stored.get(s.entryId);
      if (before === undefined) {
        upsert.push({ entryId: s.entryId, position, track: s.track });
      } else if (before !== position) {
        move.push({ entryId: s.entryId, position });
      }
    });
    if (!upsert.length && !move.length && !remove.length) return;

    let rejected: string[];
    try {
      ({ rejected } = await port.push({ upsert, move, remove }));
    } catch (err) {
      if (!(err instanceof StackFullError)) throw err;
      // The account is at its cap, so these entries cannot be stored. Drop only
      // the failing write's entries (earlier writes are stored), then push the
      // rest: known entries, moves and removals must not wait for the next change.
      console.warn('Your Stack is full; dropped the entries that did not fit.');
      for (const id of err.entryIds) await this.player.removeStackEntry(id);
      if (err.entryIds.length) return this.pushPending();
      return;
    }
    if (rejected.length) {
      // Refused rows are not retried: keep them local and push the rest.
      for (const id of rejected) this.rejected.add(id);
      return this.pushPending();
    }
    // A sign-out or account switch during the write: this push's state is not
    // the current account's, so it is not recorded.
    if (
      generation !== this.generation ||
      !this.enabled() ||
      this.auth.user()?.id !== me
    )
      return;
    // Recorded only after the write, so a failed push is retried in full.
    this.known = {
      userId: me,
      entries: new Map(ids.map((id, i) => [id, positions[i] ?? 0])),
    };
    await this.saveKnown();
  }

  private async pullRemote(): Promise<void> {
    const port = this.port;
    const me = this.auth.user()?.id;
    if (!port || !this.enabled() || !me) return;
    if (this.stackUnknown()) return;
    if ((await port.userId()) !== me) return;
    const known = await this.loadKnown();
    const before = this.stackKey();
    const rows = await port.pull();
    // Signed out or switched account while the request was in flight.
    if (!this.enabled() || this.auth.user()?.id !== me) return;
    // The session lost its stack state while the request was in flight.
    if (this.stackUnknown()) return;
    // The stack changed while the request was in flight: these rows are stale.
    // The change's own push goes up; pull again shortly to pick up the account.
    if (this.stackKey() !== before) {
      this.schedulePull(RETRY_MS);
      return;
    }

    const remote = fromRows(rows);
    const remoteIds = new Set(remote.map((r) => r.entry.entryId));
    // Another account's stack on this device is replaced, never kept.
    const foreign = known.userId !== '' && known.userId !== me;
    const stored =
      known.userId === me ? known.entries : new Map<string, number>();
    const local = this.player.stackEntries();
    // Kept after the synced ones, in local order: local files (never sync) and
    // entries this device added that the account does not hold yet (a failed
    // push; they go up on the retry). An entry `known` holds but the remote
    // lacks was removed on another device, so it is dropped.
    // An entry id the account already holds is never kept twice: the session
    // refuses duplicate ids, which would fail every retry of this pull.
    const kept = local.filter(
      (e) =>
        !remoteIds.has(e.entryId) &&
        (e.track.id.startsWith('local:') ||
          (!foreign && !stored.has(e.entryId))),
    );
    const next = [...remote.map((r) => r.entry), ...kept];
    // Applied before `known` moves: a refused apply throws, so the diff is
    // retried instead of being recorded as done.
    if (!sameEntries(next, local)) await this.player.setStackFromRemote(next);

    this.known = {
      userId: me,
      entries: new Map(remote.map((r) => [r.entry.entryId, r.position])),
    };
    await this.saveKnown();
  }

  /** The synced part of the stack: local files excluded, positions counted over it. */
  private syncedStack(): StackEntry[] {
    return this.player
      .stackEntries()
      .filter((entry) => !entry.track.id.startsWith('local:'));
  }

  /** Every entry id in the effective stack, in order (detects any change). */
  private stackKey(): string {
    return this.player
      .stackEntries()
      .map((e) => e.entryId)
      .join('\n');
  }

  /** The stored sync state (loaded once), for whichever account wrote it. */
  private async loadKnown(): Promise<Known> {
    if (!this.known) {
      let stored: unknown = null;
      try {
        stored = await this.storage.settings.get(SETTINGS_KEYS.stackSync);
      } catch (err) {
        console.error('Could not load stack sync state.', err);
      }
      this.known = parseKnown(stored) ?? { userId: '', entries: new Map() };
    }
    return this.known;
  }

  private async saveKnown(): Promise<void> {
    if (!this.known) return;
    const value = {
      userId: this.known.userId,
      entries: Object.fromEntries(this.known.entries),
    };
    try {
      await this.storage.settings.set(
        SETTINGS_KEYS.stackSync,
        value as unknown as JsonValue,
      );
    } catch (err) {
      console.error('Could not save stack sync state.', err);
    }
  }
}

/**
 * Untrusted cloud rows: a row without a usable track is dropped, and the
 * result is in play order (position, then entry id) with duplicate ids dropped.
 */
function fromRows(rows: readonly SyncStackEntry[]): SyncedEntry[] {
  const seen = new Set<string>();
  const out: SyncedEntry[] = [];
  for (const row of rows) {
    const entry = fromRow(row);
    if (!entry || seen.has(entry.entry.entryId)) continue;
    seen.add(entry.entry.entryId);
    out.push(entry);
  }
  return out.sort((a, b) => a.position - b.position || byId(a.entry, b.entry));
}

const byId = (a: StackEntry, b: StackEntry): number =>
  a.entryId < b.entryId ? -1 : a.entryId > b.entryId ? 1 : 0;

function fromRow(row: SyncStackEntry): SyncedEntry | null {
  const t = row.track;
  if (
    typeof row.entryId !== 'string' ||
    !row.entryId ||
    !Number.isFinite(row.position) ||
    !t ||
    typeof t !== 'object' ||
    typeof t.id !== 'string' ||
    !t.id ||
    typeof t.providerId !== 'string' ||
    typeof t.title !== 'string' ||
    typeof t.artist !== 'string' ||
    t.id.startsWith('local:')
  ) {
    return null;
  }
  return {
    entry: { entryId: row.entryId, track: fromSyncTrack(t) },
    position: row.position,
  };
}

/** Gap between stored positions, so a later insert can take a midpoint. */
const POSITION_SPACING = 1024;
/** Highest position written (the column is a 32-bit integer). */
const MAX_POSITION = 2_000_000_000;

/**
 * Positions for `ids` (play order), aligned with `ids`. An entry the account
 * already holds keeps its stored position while the stored positions still
 * increase in play order. A new entry takes the midpoint between its
 * neighbours, or a spaced slot past the last one. Returns null when a gap has
 * no room left; the caller renumbers the whole stack.
 */
export function planPositions(
  ids: readonly string[],
  stored: ReadonlyMap<string, number>,
): number[] | null {
  const anchor: (number | undefined)[] = [];
  let last = -1;
  for (const id of ids) {
    const p = stored.get(id);
    if (p !== undefined && Number.isInteger(p) && p > last && p <= MAX_POSITION) {
      anchor.push(p);
      last = p;
    } else {
      anchor.push(undefined);
    }
  }

  const out: number[] = new Array<number>(ids.length);
  let lo = -1;
  let i = 0;
  while (i < ids.length) {
    const fixed = anchor[i];
    if (fixed !== undefined) {
      out[i] = fixed;
      lo = fixed;
      i++;
      continue;
    }
    // A run of new entries between two anchors (or after the last one).
    let j = i;
    while (j < ids.length && anchor[j] === undefined) j++;
    const count = j - i;
    const hi = j < ids.length ? anchor[j] : undefined;
    const step =
      hi === undefined
        ? POSITION_SPACING
        : Math.floor((hi - lo) / (count + 1));
    if (step < 1) return null;
    for (let k = 0; k < count; k++) {
      const at = lo + step * (k + 1);
      if (at > MAX_POSITION) return null;
      out[i + k] = at;
    }
    i = j;
  }
  return out;
}

/** Evenly spaced positions for every entry (used when a gap runs out). */
function renumber(ids: readonly string[]): number[] {
  return ids.map((_, k) => (k + 1) * POSITION_SPACING);
}

function sameEntries(
  a: readonly StackEntry[],
  b: readonly StackEntry[],
): boolean {
  return a.length === b.length && a.every((e, i) => e.entryId === b[i].entryId);
}

function parseKnown(value: unknown): Known | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as { userId?: unknown; entries?: unknown };
  if (
    typeof v.userId !== 'string' ||
    !v.entries ||
    typeof v.entries !== 'object'
  )
    return null;
  const entries = new Map<string, number>();
  for (const [id, position] of Object.entries(v.entries)) {
    if (typeof position === 'number' && Number.isFinite(position))
      entries.set(id, position);
  }
  return { userId: v.userId, entries };
}
