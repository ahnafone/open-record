import type { Track } from '@open-record/models';
import type { SyncPlaylist, SyncTrack } from './ports';

/**
 * Pure account-sync logic (no Angular, no I/O): local change detection,
 * last-write-wins merge and the Track <-> SyncTrack projection.
 *
 * Local records carry no clocks of their own (except playlists), so a small
 * ledger remembers, per synced id, a hash of the content last agreed with the
 * cloud and its clock. A changed hash means "changed here since"; an id in the
 * ledger that is gone locally means "deleted here" (a tombstone).
 */

/** Ledger entry: content hash (`''` for a tombstone), updatedAt, deletedAt. */
export interface SyncLedgerEntry {
  h: string;
  u: number;
  d?: number;
}

/** Persisted under `SETTINGS_KEYS.syncState`. Ids, hashes and clocks only. */
export interface SyncLedger {
  v: 1;
  userId: string;
  lastSyncedAt?: number;
  library: Record<string, SyncLedgerEntry>;
  playlists: Record<string, SyncLedgerEntry>;
}

/** A record with a sync clock; `deletedAt` marks a tombstone. */
export interface Clocked {
  updatedAt: number;
  deletedAt?: number;
}

export function emptyLedger(userId: string): SyncLedger {
  return { v: 1, userId, library: {}, playlists: {} };
}

/** Reads a stored ledger, or null when absent or malformed. */
export function readLedger(raw: unknown): SyncLedger | null {
  const v = raw as Partial<SyncLedger> | null;
  if (
    !v ||
    v.v !== 1 ||
    typeof v.userId !== 'string' ||
    typeof v.library !== 'object' ||
    typeof v.playlists !== 'object' ||
    !v.library ||
    !v.playlists
  )
    return null;
  return v as SyncLedger;
}

/** Stable JSON (sorted keys, undefined dropped) for hashing. */
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable(obj[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** Short content hash (FNV-1a, 32 bit, plus length). */
export function contentHash(value: unknown): string {
  const text = stable(value);
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `${(h >>> 0).toString(36)}.${text.length.toString(36)}`;
}

/**
 * Give local records clocks. `current` maps id -> content (what would sync).
 * - unchanged since the last sync: the ledger clock;
 * - changed (or re-added after a delete): `now`;
 * - never synced: `clockOf(content)` when the record has its own clock
 *   (playlists), else `now`, or 0 on the account's first sync so the cloud
 *   copy wins a conflict there;
 * - in the ledger but gone locally: a tombstone at `now`.
 */
export function stampLocal<C>(
  current: ReadonlyMap<string, C>,
  ledger: Readonly<Record<string, SyncLedgerEntry>>,
  now: number,
  options: { firstSync: boolean; clockOf?: (content: C) => number },
): Map<string, Clocked & { content?: C }> {
  const out = new Map<string, Clocked & { content?: C }>();
  for (const [id, content] of current) {
    const entry = ledger[id];
    const h = contentHash(content);
    let updatedAt: number;
    if (options.clockOf) updatedAt = options.clockOf(content);
    else if (entry && !entry.d && entry.h === h) updatedAt = entry.u;
    else if (entry || !options.firstSync) updatedAt = now;
    else updatedAt = 0;
    out.set(id, { content, updatedAt });
  }
  for (const [id, entry] of Object.entries(ledger)) {
    if (out.has(id)) continue;
    out.set(
      id,
      entry.d
        ? { updatedAt: entry.u, deletedAt: entry.d }
        : { updatedAt: now, deletedAt: now },
    );
  }
  return out;
}

export interface MergeResult<T> {
  /** Local records newer than the cloud (or missing there): upload. */
  push: T[];
  /** Cloud records newer than this device (or missing here): apply locally. */
  apply: T[];
}

/**
 * Last-write-wins merge by `updatedAt`. On a tie the cloud copy wins unless
 * `same` says the contents already agree. Tombstones the other side never had
 * are neither pushed nor applied (there is nothing to delete).
 */
export function mergeRecords<T extends Clocked>(
  local: ReadonlyMap<string, T>,
  remote: ReadonlyMap<string, T>,
  same: (a: T, b: T) => boolean,
): MergeResult<T> {
  const push: T[] = [];
  const apply: T[] = [];
  for (const [id, l] of local) {
    const r = remote.get(id);
    if (!r) {
      if (!l.deletedAt) push.push(l);
    } else if (l.updatedAt > r.updatedAt) {
      push.push(l);
    } else if (r.updatedAt > l.updatedAt || !same(l, r)) {
      apply.push(r);
    }
  }
  for (const [id, r] of remote) {
    if (!local.has(id) && !r.deletedAt) apply.push(r);
  }
  return { push, apply };
}

// ---- Track projection -------------------------------------------------------

/**
 * The synced subset of a track: identity and display metadata only. Never
 * device paths (`sourceFile`, `coverPath`), sizes or raw provider payloads.
 */
export function toSyncTrack(t: Track): SyncTrack {
  const out: SyncTrack = {
    id: t.id,
    providerId: t.providerId,
    title: t.title,
    artist: t.artist,
  };
  if (t.album) out.album = t.album;
  if (t.year !== undefined) out.year = t.year;
  if (t.genre) out.genre = t.genre;
  if (t.durationSec !== undefined) out.durationSec = Math.round(t.durationSec);
  if (t.artUrl && /^https?:\/\//i.test(t.artUrl)) out.artUrl = t.artUrl;
  if (t.isrc) out.isrc = t.isrc;
  if (t.external?.spotifyId) out.spotifyId = t.external.spotifyId;
  if (t.source?.url) {
    out.sourceUrl = t.source.url;
    if (t.source.site) out.sourceSite = t.source.site;
    if (t.source.id) out.sourceId = t.source.id;
  }
  return out;
}

export function fromSyncTrack(s: SyncTrack): Track {
  const t: Track = {
    id: s.id,
    providerId: s.providerId,
    title: s.title,
    artist: s.artist,
  };
  if (s.album) t.album = s.album;
  if (s.year !== undefined) t.year = s.year;
  if (s.genre) t.genre = s.genre;
  if (s.durationSec !== undefined) t.durationSec = s.durationSec;
  if (s.artUrl) t.artUrl = s.artUrl;
  if (s.isrc) t.isrc = s.isrc;
  if (s.spotifyId) t.external = { spotifyId: s.spotifyId };
  if (s.sourceUrl)
    t.source = {
      site: s.sourceSite ?? '',
      url: s.sourceUrl,
      ...(s.sourceId ? { id: s.sourceId } : {}),
    };
  return t;
}

/** Synced content of a playlist (what its hash covers). */
export function playlistContent(p: SyncPlaylist): unknown {
  return {
    name: p.name,
    visibility: p.visibility,
    autoDownload: p.autoDownload,
    trackIds: p.trackIds,
  };
}
