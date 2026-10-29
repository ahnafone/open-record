import type { Track } from '@open-record/models';

/** Tracks kept ahead of the current one in a radio-like auto queue. */
export const AUTO_QUEUE_AHEAD = 50;

/** Tracks kept ahead of the current one in a playlist session. */
export const PLAYLIST_QUEUE_AHEAD = 100;

/** Played entries kept behind the cursor so "previous" can go back. */
export const QUEUE_HISTORY_KEEP = 20;

/** Where a bounded queue window's ahead size comes from. */
export type QueueKind = 'auto' | 'playlist';

/** Ahead size for a queue kind (`AUTO_QUEUE_AHEAD` or `PLAYLIST_QUEUE_AHEAD`). */
export function queueAheadFor(kind: QueueKind): number {
  return kind === 'playlist' ? PLAYLIST_QUEUE_AHEAD : AUTO_QUEUE_AHEAD;
}

export interface QueueWindowOptions {
  /** Tracks the window keeps ahead of the queue (50 or 100). */
  limit: number;
  /** Whether `take` draws in random order. */
  shuffle: boolean;
  /** Random source for shuffling, injectable for tests. Default `Math.random`. */
  random?: () => number;
}

/** The first queue chunk plus the window holding the unplayed remainder. */
export interface BuiltQueue {
  /**
   * Play order: up to `QUEUE_HISTORY_KEEP` played entries, the current track,
   * then up to the ahead size after it. Shuffled builds hold the tapped track
   * first and no history.
   */
  tracks: readonly Track[];
  /** Index into `tracks` of the current entry; -1 when the build is empty. */
  cursor: number;
  /** The unplayed remainder, for topping the queue up as it drains. */
  window: QueueWindow;
}

/** A pool entry with the position it had in the source order. */
interface WindowEntry {
  readonly track: Track;
  /** Position in the source order; turning shuffle off restores this order. */
  readonly origin: number;
}

/**
 * Bounded queue of unplayed tracks. Holds the whole remaining pool and hands
 * it out as the queue drains, either in the source order or randomly. The
 * origin of each entry is remembered so shuffle can be turned off without
 * losing the natural order. Framework-free: no Angular dependency.
 */
export class QueueWindow {
  /** Tracks the window keeps ahead of the queue. */
  readonly limit: number;

  private entries: WindowEntry[];
  private shuffledOn: boolean;
  private readonly random: () => number;

  /** `pool` is the unplayed tracks, in play order. */
  constructor(pool: readonly Track[], options: QueueWindowOptions) {
    this.limit = options.limit;
    this.entries = pool.map((track, origin) => ({ track, origin }));
    this.shuffledOn = options.shuffle;
    this.random = options.random ?? Math.random;
  }

  get shuffle(): boolean {
    return this.shuffledOn;
  }

  /** Tracks left in the pool (the queue's remaining after the built chunk). */
  get remaining(): number {
    return this.entries.length;
  }

  /**
   * Remove and return up to `count` tracks: from the front in the source
   * order, or random picks while shuffled. Never more than `remaining`, and
   * `[]` once exhausted.
   */
  take(count: number): Track[] {
    const n = Math.min(Math.max(0, Math.floor(count)), this.entries.length);
    const taken: Track[] = [];
    for (let i = 0; i < n; i++) {
      const at = this.shuffledOn
        ? Math.min(
            Math.max(0, Math.floor(this.random() * this.entries.length)),
            this.entries.length - 1,
          )
        : 0;
      const [entry] = this.entries.splice(at, 1);
      if (entry) taken.push(entry.track);
    }
    return taken;
  }

  /**
   * Turn shuffle on (reshuffle the remaining entries) or off (restore the
   * source order). Entries already taken are unaffected.
   */
  setShuffle(on: boolean): void {
    if (on === this.shuffledOn) return;
    this.shuffledOn = on;
    this.entries = on
      ? shuffled(this.entries, this.random)
      : [...this.entries].sort((a, b) => a.origin - b.origin);
  }

  /** Remaining pool ids in their current order, for persistence. */
  ids(): string[] {
    return this.entries.map((e) => e.track.id);
  }
}

/**
 * Build the first queue chunk around `startIndex` and a window over the rest.
 * Unshuffled builds keep up to `QUEUE_HISTORY_KEEP` played entries before the
 * current track; shuffled builds start at the tapped track with no history.
 * An empty context or an out-of-range index builds an empty queue instead of
 * throwing.
 */
export function buildQueueWindow(
  context: readonly Track[],
  startIndex: number,
  kind: QueueKind,
  options: { shuffle: boolean; random?: () => number },
): BuiltQueue {
  const ahead = queueAheadFor(kind);
  const random = options.random ?? Math.random;
  if (
    !context.length ||
    !Number.isInteger(startIndex) ||
    startIndex < 0 ||
    startIndex >= context.length
  ) {
    return {
      tracks: [],
      cursor: -1,
      window: new QueueWindow([], {
        limit: ahead,
        shuffle: options.shuffle,
        random,
      }),
    };
  }

  if (options.shuffle) {
    const tapped = context[startIndex];
    const others = context.map((_, i) => i).filter((i) => i !== startIndex);
    const deck = shuffled(others, random);
    const drawn = deck.slice(0, Math.min(ahead, deck.length));
    // The undrawn tracks keep the source order; origins restore it on toggle.
    const pool = deck
      .slice(drawn.length)
      .sort((a, b) => a - b)
      .map((i) => context[i]);
    return {
      tracks: [tapped, ...drawn.map((i) => context[i])],
      cursor: 0,
      window: new QueueWindow(pool, { limit: ahead, shuffle: true, random }),
    };
  }

  const history = Math.min(QUEUE_HISTORY_KEEP, startIndex);
  return {
    tracks: context.slice(startIndex - history, startIndex + 1 + ahead),
    cursor: history,
    window: new QueueWindow(context.slice(startIndex + 1 + ahead), {
      limit: ahead,
      shuffle: false,
      random,
    }),
  };
}

/**
 * Rebuild a window from persisted pool ids. Resolves every id through
 * `resolve` and returns `null` if any is missing (e.g. a deleted track). The
 * persisted order becomes each entry's origin, so turning shuffle off restores
 * it.
 */
export function restoreQueueWindow(
  ids: readonly string[],
  resolve: (id: string) => Track | undefined,
  options: QueueWindowOptions,
): QueueWindow | null {
  const tracks: Track[] = [];
  for (const id of ids) {
    const track = resolve(id);
    if (!track) return null;
    tracks.push(track);
  }
  return new QueueWindow(tracks, options);
}

/** Fisher-Yates with the injected random source. */
function shuffled<T>(items: readonly T[], random: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.min(Math.max(0, Math.floor(random() * (i + 1))), i);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
