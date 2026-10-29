import {
  DOCUMENT,
  DestroyRef,
  Injectable,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import type { Track } from '@open-record/models';
import { StoragePort, type PlayCountRecord } from '@open-record/storage';
import { AuthStore } from './auth.store';
import {
  NetworkStatusPort,
  PlayCountsPort,
  type SyncPlayCount,
  type SyncPlayIncrement,
} from './ports';
import { fromSyncTrack, toSyncTrack } from './sync-merge';

/** Wait after a play before uploading it (several plays upload together). */
const FLUSH_DEBOUNCE_MS = 10_000;
/** Increments uploaded per request. */
export const FLUSH_CHUNK = 500;
/** Foreground resumes closer together than this do not pull the account totals. */
const PULL_THROTTLE_MS = 60_000;

/**
 * Per-song play counts. Local-first: every play is counted and persisted on
 * this device immediately, whether or not anyone is signed in. When a
 * `PlayCountsPort` is provided and the user is signed in, plays upload as
 * additive increments (so two devices both count) and the account totals come
 * back on sign-in, when the network returns and when the app is resumed.
 *
 * Never requires an account: counting works signed out. A count carries a
 * track snapshot so it survives independently of the library. `PlayerStore`
 * reports each counted play through `recordPlay()`; this store never depends
 * on the player, so features that only need counts do not pull in the engine.
 */
@Injectable({ providedIn: 'root' })
export class PlayCountsStore {
  private readonly storage = inject(StoragePort);
  private readonly auth = inject(AuthStore);
  private readonly port = inject(PlayCountsPort, { optional: true });
  private readonly network = inject(NetworkStatusPort, { optional: true });
  private readonly document = inject(DOCUMENT, { optional: true });
  private readonly destroyRef = inject(DestroyRef);

  private readonly _counts = signal<ReadonlyMap<string, PlayCountRecord>>(
    new Map(),
  );

  /** Every tracked track's count by track id. */
  readonly counts = this._counts.asReadonly();
  /** Play-count sync is built into this app (a `PlayCountsPort` is provided). */
  readonly available = !!this.port;
  /** Signed in with play-count sync available: uploads and pulls can run. */
  readonly enabled = computed(() => this.available && this.auth.signedIn());
  /** Counts, most played first (ties: most recently played first). */
  readonly mostPlayed = computed(() =>
    [...this._counts().values()].sort(
      (a, b) => b.count - a.count || b.lastPlayedAt - a.lastPlayedAt,
    ),
  );

  private loaded: Promise<void> | null = null;
  /** Bumped by `clear()`: results of requests started before it are dropped. */
  private generation = 0;
  /** Serializes play-count writes so concurrent plays cannot interleave. */
  private writing: Promise<void> = Promise.resolve();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private flushing: Promise<void> | null = null;
  /** A flush was requested while one was running: run one more pass. */
  private again = false;
  private lastPull = 0;
  private started = false;
  private seenUser: string | null = null;
  private onVisibility: (() => void) | null = null;
  private offNetwork: (() => void) | null = null;

  constructor() {
    // Sign-in (or a switch of account): upload this device's plays, then
    // refresh the totals (guest plays recorded before signing in go up here).
    effect(() => {
      const id = this.auth.signedIn() ? (this.auth.user()?.id ?? null) : null;
      if (id === this.seenUser) return;
      this.seenUser = id;
      untracked(() => {
        this.lastPull = 0;
        if (id && this.started) void this.onSignedIn();
      });
    });
  }

  /** Plays of `trackId`, or 0. The account total once the user has synced. */
  count(trackId: string): number {
    return this._counts().get(trackId)?.count ?? 0;
  }

  /** Resolves once the stored counts are in memory (successfully or not). */
  async ready(): Promise<void> {
    await this.load();
  }

  /** Begin syncing (called once at app start). A no-op when already started. */
  start(): void {
    if (this.started) return;
    this.started = true;
    void this.load();
    if (this.auth.signedIn()) void this.onSignedIn();
    this.offNetwork =
      this.network?.onChange((state) => {
        if (state.connected) void this.flush().catch(() => undefined);
      }) ?? null;
    const doc = this.document;
    if (doc) {
      this.onVisibility = () => {
        if (doc.visibilityState === 'hidden')
          void this.flush().catch(() => undefined);
        else void this.pullIfStale();
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
      if (this.flushTimer) {
        clearTimeout(this.flushTimer);
        this.flushTimer = null;
      }
    });
  }

  /**
   * Count one play of `track`. Persists optimistically (the in-memory count
   * never rolls back) and schedules an upload when sync is available.
   */
  async recordPlay(track: Track, at = Date.now()): Promise<void> {
    await this.load();
    await this.enqueue(async () => {
      const prev = this._counts().get(track.id);
      // Local files have no cloud copy; without a port there is nowhere to go.
      const cloud = !!this.port && !track.id.startsWith('local:');
      const next: PlayCountRecord = {
        trackId: track.id,
        count: (prev?.count ?? 0) + 1,
        pending: (prev?.pending ?? 0) + (cloud ? 1 : 0),
        firstPlayedAt: prev?.firstPlayedAt ?? at,
        lastPlayedAt: Math.max(prev?.lastPlayedAt ?? 0, at),
        track: { ...track },
      };
      this._counts.update((m) => new Map(m).set(track.id, next));
      await this.write(() => this.storage.playCounts.save(next));
    });
    if (this.enabled()) this.scheduleFlush();
  }

  /**
   * Re-key a count when a track id is replaced (e.g. a new source link).
   * Does nothing when the old id is not counted.
   */
  async move(oldId: string, newId: string): Promise<void> {
    if (oldId === newId) return;
    await this.load();
    await this.enqueue(async () => {
      // The merge happens in storage; the in-memory value is replaced by it,
      // and any play queued behind this one reads the merged count.
      let moved: PlayCountRecord | undefined;
      try {
        moved = await this.storage.playCounts.replace(oldId, newId);
      } catch (err) {
        // Keep the old in-memory record: storage still has it under oldId.
        console.error('Could not move play count.', err);
        return;
      }
      // Storage had no record for the old id (e.g. its save failed): repair it
      // from memory so the plays are not stranded under a dead id. When storage
      // does have a record its merge is authoritative; a stale row from a
      // failed write is the residual divergence this does not resolve.
      if (!moved) {
        const orphan = this._counts().get(oldId);
        if (!orphan) return;
        const current = this._counts().get(newId);
        const merged: PlayCountRecord = current
          ? mergePair(orphan, current)
          : { ...orphan, trackId: newId };
        this._counts.update((m) => {
          const next = new Map(m);
          next.delete(oldId);
          next.set(newId, merged);
          return next;
        });
        await this.write(() => this.storage.playCounts.save(merged));
        return;
      }
      this._counts.update((m) => {
        const next = new Map(m);
        next.delete(oldId);
        next.set(newId, moved);
        return next;
      });
    });
  }

  /** Delete every count on this device (account deletion, app reset). */
  async clear(): Promise<void> {
    // Drops any pull or flush that was already in flight.
    this.generation++;
    await this.load();
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.again = false;
    this.lastPull = 0;
    // A flush in flight would merge its totals back after the clear.
    await this.flushing?.catch(() => undefined);
    // Ordered with plays and moves: a play queued before this is cleared, a
    // play queued after it counts as new.
    await this.enqueue(async () => {
      await this.storage.playCounts.clear();
      this._counts.set(new Map());
    });
  }

  /**
   * Upload the pending plays now. Rejects when a chunk fails (earlier chunks
   * stay applied); a concurrent call joins the running flush and asks for one
   * more pass so plays recorded meanwhile are included.
   */
  flush(): Promise<void> {
    // An explicit flush replaces the pending debounced one.
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.flushing) {
      this.again = true;
      return this.flushing;
    }
    this.flushing = this.flushLoop().finally(() => {
      this.flushing = null;
    });
    return this.flushing;
  }

  /** Fetch the account totals and merge them in. Rejects when it cannot. */
  async pull(): Promise<void> {
    const port = this.port;
    if (!port || !this.enabled()) return;
    const me = this.auth.user()?.id;
    const generation = this.generation;
    // A sign-out/switch while this was queued must not mix accounts.
    if ((await port.userId()) !== me) return;
    await this.load();
    const remote = await port.pull();
    // The account or the stored history can change while the request is in
    // flight: drop a result that no longer belongs here.
    if (
      this.generation !== generation ||
      this.auth.user()?.id !== me ||
      (await port.userId()) !== me
    ) {
      return;
    }
    const updates = new Map<
      string,
      (current: PlayCountRecord | undefined) => PlayCountRecord
    >();
    for (const r of remote) {
      if (r.trackId.startsWith('local:')) continue;
      updates.set(r.trackId, (current) => mergeRemote(current, r));
    }
    await this.apply(updates);
  }

  // ---- Internals -----------------------------------------------------------

  /** Hydration, run once (the first caller's promise is shared). */
  private load(): Promise<void> {
    this.loaded ??= this.hydrate();
    return this.loaded;
  }

  private async hydrate(): Promise<void> {
    try {
      const stored = await this.storage.playCounts.list();
      if (!stored.length) return;
      // Merge, never replace: a read must not drop a count already in memory.
      this._counts.update((m) => {
        const fresh = stored.filter((r) => !m.has(r.trackId));
        if (!fresh.length) return m;
        const next = new Map(m);
        for (const record of fresh) next.set(record.trackId, record);
        return next;
      });
    } catch (err) {
      console.error('Could not load play counts.', err);
    }
  }

  /** Queue a read-modify-write so plays, moves and pulls cannot interleave. */
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.writing.then(task);
    this.writing = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** A storage write that never rejects: memory keeps the value on failure. */
  private async write(save: () => Promise<void>): Promise<void> {
    try {
      await save();
    } catch (err) {
      console.error('Could not save play counts.', err);
    }
  }

  /** Run flushes until no further flush was requested during the last one. */
  private async flushLoop(): Promise<void> {
    do {
      this.again = false;
      await this.doFlush();
    } while (this.again && this.enabled());
  }

  private async doFlush(): Promise<void> {
    const port = this.port;
    if (!port || !this.enabled()) return;
    const me = this.auth.user()?.id;
    const generation = this.generation;
    // Upload only for the account that is signed in right now.
    if ((await port.userId()) !== me) return;
    await this.load();
    if (this.generation !== generation) return;
    const pending = [...this._counts().values()].filter(
      (r) => r.pending > 0 && !r.trackId.startsWith('local:'),
    );
    for (let i = 0; i < pending.length; i += FLUSH_CHUNK) {
      const batch = pending.slice(i, i + FLUSH_CHUNK);
      const plays: SyncPlayIncrement[] = batch.map((r) => ({
        trackId: r.trackId,
        count: r.pending,
        firstPlayedAt: r.firstPlayedAt,
        at: r.lastPlayedAt,
        ...(r.track ? { track: toSyncTrack(r.track) } : {}),
      }));
      try {
        const totals = await port.record(plays);
        // The account or the stored history can change while the request is
        // in flight: drop a result that no longer belongs here.
        if (
          this.generation !== generation ||
          this.auth.user()?.id !== me ||
          (await port.userId()) !== me
        ) {
          return;
        }
        await this.applyTotals(
          totals,
          new Map(batch.map((r) => [r.trackId, r.pending])),
        );
      } catch (err) {
        // Earlier chunks stay applied; retry the rest later.
        console.error('Could not upload play counts.', err);
        this.scheduleFlush();
        throw err;
      }
    }
  }

  /**
   * Apply the account totals a `record()` returned. `uploaded` holds the
   * increments that request acknowledged: plays recorded meanwhile stay
   * pending (0 when none arrived).
   */
  private applyTotals(
    totals: readonly SyncPlayCount[],
    uploaded: ReadonlyMap<string, number>,
  ): Promise<void> {
    const updates = new Map<
      string,
      (current: PlayCountRecord | undefined) => PlayCountRecord
    >();
    for (const total of totals) {
      if (total.trackId.startsWith('local:')) continue;
      const acknowledged = uploaded.get(total.trackId) ?? 0;
      updates.set(total.trackId, (current) =>
        mergeTotal(current, total, acknowledged),
      );
    }
    return this.apply(updates);
  }

  /**
   * Merge records into the map inside the write chain, so a play queued
   * behind a pull or a flush is never overwritten by a stale snapshot. Only
   * records that actually change are written back.
   */
  private apply(
    updates: ReadonlyMap<
      string,
      (current: PlayCountRecord | undefined) => PlayCountRecord
    >,
  ): Promise<void> {
    if (!updates.size) return Promise.resolve();
    return this.enqueue(async () => {
      const next = new Map(this._counts());
      const changed: PlayCountRecord[] = [];
      for (const [id, merge] of updates) {
        const current = next.get(id);
        const record = merge(current);
        if (sameRecord(current, record)) continue;
        next.set(id, record);
        changed.push(record);
      }
      if (!changed.length) return;
      this._counts.set(next);
      await this.write(() => this.storage.playCounts.saveMany(changed));
    });
  }

  /** Upload this device's plays, then refresh the account totals. Never rejects. */
  private async onSignedIn(): Promise<void> {
    await this.load();
    try {
      await this.flush();
    } catch {
      // Offline or a failing chunk: the plays stay pending and retry later.
    }
    await this.pull().catch(() => undefined);
  }

  /** Pull when the last pull is older than the throttle (foreground resumes). */
  private async pullIfStale(): Promise<void> {
    if (!this.enabled()) return;
    if (Date.now() - this.lastPull <= PULL_THROTTLE_MS) return;
    this.lastPull = Date.now();
    await this.pull().catch(() => undefined);
  }

  /** Debounced flush: several plays upload in one request. */
  private scheduleFlush(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      // The debounced path must never surface an unhandled rejection.
      void this.flush().catch(() => undefined);
    }, FLUSH_DEBOUNCE_MS);
  }
}

/** Smallest present (positive) timestamp, else 0. */
function earliest(...values: (number | undefined)[]): number {
  const present = values.filter(
    (v): v is number => typeof v === 'number' && v > 0,
  );
  return present.length ? Math.min(...present) : 0;
}

/** All counted fields agree (`track` by presence, not deep equality). */
function sameRecord(
  a: PlayCountRecord | undefined,
  b: PlayCountRecord,
): boolean {
  return (
    !!a &&
    a.count === b.count &&
    a.pending === b.pending &&
    a.firstPlayedAt === b.firstPlayedAt &&
    a.lastPlayedAt === b.lastPlayedAt &&
    !!a.track === !!b.track
  );
}

/**
 * Account totals over the local record. `count` only grows, and `pending`
 * stays: plays not uploaded yet are not in the totals.
 */
function mergeRemote(
  current: PlayCountRecord | undefined,
  remote: SyncPlayCount,
): PlayCountRecord {
  const next: PlayCountRecord = {
    trackId: remote.trackId,
    count: Math.max(current?.count ?? 0, remote.count),
    pending: current?.pending ?? 0,
    firstPlayedAt: earliest(current?.firstPlayedAt, remote.firstPlayedAt),
    lastPlayedAt: Math.max(current?.lastPlayedAt ?? 0, remote.lastPlayedAt),
  };
  const track =
    current?.track ?? (remote.track ? fromSyncTrack(remote.track) : undefined);
  if (track) next.track = track;
  return next;
}

/**
 * The totals a flush returned. `acknowledged` plays left the pending queue;
 * any recorded meanwhile stay pending.
 */
function mergeTotal(
  current: PlayCountRecord | undefined,
  total: SyncPlayCount,
  acknowledged: number,
): PlayCountRecord {
  const next: PlayCountRecord = {
    trackId: total.trackId,
    count: Math.max(current?.count ?? 0, total.count),
    pending: Math.max(0, (current?.pending ?? 0) - acknowledged),
    firstPlayedAt: earliest(current?.firstPlayedAt, total.firstPlayedAt),
    lastPlayedAt: Math.max(current?.lastPlayedAt ?? 0, total.lastPlayedAt),
  };
  const track =
    current?.track ?? (total.track ? fromSyncTrack(total.track) : undefined);
  if (track) next.track = track;
  return next;
}

/** Sum two records of the same track, keeping the earliest and latest play. */
function mergePair(a: PlayCountRecord, b: PlayCountRecord): PlayCountRecord {
  const next: PlayCountRecord = {
    trackId: b.trackId,
    count: a.count + b.count,
    pending: a.pending + b.pending,
    firstPlayedAt: earliest(a.firstPlayedAt, b.firstPlayedAt),
    lastPlayedAt: Math.max(a.lastPlayedAt, b.lastPlayedAt),
  };
  const track = b.track ?? a.track;
  if (track) next.track = track;
  return next;
}
