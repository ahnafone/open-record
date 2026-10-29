import {
  FLUSH_CHUNK,
  PlayCountsPort,
  type SyncPlayCount,
  type SyncPlayIncrement,
  type SyncTrack,
} from '@open-record/state';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { SupabaseAuth } from './supabase-auth';
import { pageAll } from './supabase-sync';

/**
 * Rows per `record_plays` call. Never smaller than the store's flush chunk: a
 * flush split across several calls would re-count the earlier plays if a later
 * call fails (they are committed remotely but stay pending here).
 */
const CHUNK = Math.max(500, FLUSH_CHUNK);

interface PlayCountRow {
  track_id: string;
  count: number;
  first_played_at: string;
  last_played_at: string;
  provider_id: string | null;
  title: string | null;
  artist: string | null;
  album: string | null;
  year: number | null;
  genre: string | null;
  duration_sec: number | null;
  art_url: string | null;
  isrc: string | null;
  spotify_id: string | null;
  source_site: string | null;
  source_url: string | null;
  source_id: string | null;
}

/** What `record_plays` returns: the account totals of the batch's tracks. */
interface PlayCountTotalRow {
  track_id: string;
  count: number;
  first_played_at: string;
  last_played_at: string;
}

const PLAY_COUNT_COLUMNS =
  'track_id,count,first_played_at,last_played_at,provider_id,title,artist,album,year,genre,duration_sec,art_url,isrc,spotify_id,source_site,source_url,source_id';

/**
 * Additive per-track play counts over the signed-in Supabase session (the
 * client is shared with `SupabaseAuth`). Unlike `SupabaseSync` nothing here is
 * last-write-wins: `record_plays` adds the increments and returns the new
 * account totals, so two devices playing the same track both count.
 *
 * Local-only (`local:`) tracks never reach this port; their plays stay on the
 * device that holds the audio.
 */
export class SupabasePlayCounts extends PlayCountsPort {
  constructor(private readonly auth: SupabaseAuth) {
    super();
  }

  async userId(): Promise<string | null> {
    const client = await this.auth.sharedClient();
    if (!client) return null;
    const { data } = await client.auth.getSession();
    return data.session?.user.id ?? null;
  }

  async pull(): Promise<SyncPlayCount[]> {
    const client = await this.requireClient();
    const rows = await pageAll<PlayCountRow>(client, 'play_counts', PLAY_COUNT_COLUMNS, [
      'track_id',
    ]);
    const out: SyncPlayCount[] = [];
    for (const r of rows) {
      const item = fromRow(r);
      if (item) out.push(item);
    }
    return out;
  }

  async record(plays: readonly SyncPlayIncrement[]): Promise<SyncPlayCount[]> {
    if (!plays.length) return [];
    const client = await this.requireClient();
    // Keyed by track so a track split across chunks resolves to its latest
    // total; insertion order keeps the output stable.
    const totals = new Map<string, SyncPlayCount>();
    for (let i = 0; i < plays.length; i += CHUNK) {
      const chunk = plays.slice(i, i + CHUNK).map(toPayload);
      const { data, error } = await client.rpc('record_plays', { p_plays: chunk });
      if (error) throw new Error(error.message);
      for (const r of (data ?? []) as unknown as PlayCountTotalRow[]) {
        const item = fromTotalRow(r);
        if (item) totals.set(item.trackId, item);
      }
    }
    return [...totals.values()];
  }

  private async requireClient(): Promise<SupabaseClient> {
    const client = await this.auth.sharedClient();
    if (!client) throw new Error('Accounts are not set up.');
    return client;
  }
}

const ms = (value: string) => Date.parse(value);

/** Finite, positive, whole plays; anything else counts as none. */
const count = (n: number) => (Number.isFinite(n) && n > 0 ? Math.floor(n) : 0);

/** Untrusted row: null when the play window is unreadable. */
function fromRow(r: PlayCountRow): SyncPlayCount | null {
  const firstPlayedAt = ms(r.first_played_at);
  const lastPlayedAt = ms(r.last_played_at);
  if (!Number.isFinite(firstPlayedAt) || !Number.isFinite(lastPlayedAt)) return null;
  const item: SyncPlayCount = {
    trackId: r.track_id,
    count: count(r.count),
    firstPlayedAt,
    lastPlayedAt,
  };
  if (r.provider_id && r.title !== null && r.artist !== null) {
    // Nulls are dropped so content hashes match the local projection.
    const t: SyncTrack = {
      id: r.track_id,
      providerId: r.provider_id,
      title: r.title,
      artist: r.artist,
    };
    if (r.album) t.album = r.album;
    if (r.year !== null) t.year = r.year;
    if (r.genre) t.genre = r.genre;
    if (r.duration_sec !== null) t.durationSec = r.duration_sec;
    if (r.art_url) t.artUrl = r.art_url;
    if (r.isrc) t.isrc = r.isrc;
    if (r.spotify_id) t.spotifyId = r.spotify_id;
    if (r.source_url) {
      t.sourceUrl = r.source_url;
      if (r.source_site) t.sourceSite = r.source_site;
      if (r.source_id) t.sourceId = r.source_id;
    }
    item.track = t;
  }
  return item;
}

/** RPC result rows carry totals only, never the stored metadata copy. */
function fromTotalRow(r: PlayCountTotalRow): SyncPlayCount | null {
  const firstPlayedAt = ms(r.first_played_at);
  const lastPlayedAt = ms(r.last_played_at);
  if (!Number.isFinite(firstPlayedAt) || !Number.isFinite(lastPlayedAt)) return null;
  return {
    trackId: r.track_id,
    count: count(r.count),
    firstPlayedAt,
    lastPlayedAt,
  };
}

/** Untrusted increment: at least one play, whatever the caller passed. */
const plays = (n: number) => (Number.isFinite(n) ? Math.max(1, Math.floor(n)) : 1);

function toPayload(p: SyncPlayIncrement) {
  return {
    track_id: p.trackId,
    count: plays(p.count),
    // Epoch ms; the RPC falls back to now() when it is not a sane value.
    first: p.firstPlayedAt,
    at: p.at,
    ...(p.track ? { track: toPayloadTrack(p.track) } : {}),
  };
}

/** `SyncTrack` with the app's camelCase keys the RPC reads; no undefined keys. */
interface PlayPayloadTrack {
  providerId: string;
  title: string;
  artist: string;
  album?: string;
  year?: number;
  genre?: string;
  durationSec?: number;
  artUrl?: string;
  isrc?: string;
  spotifyId?: string;
  sourceSite?: string;
  sourceUrl?: string;
  sourceId?: string;
}

function toPayloadTrack(t: SyncTrack): PlayPayloadTrack {
  const out: PlayPayloadTrack = {
    providerId: t.providerId,
    title: t.title,
    artist: t.artist,
  };
  if (t.album !== undefined) out.album = t.album;
  if (t.year !== undefined) out.year = t.year;
  if (t.genre !== undefined) out.genre = t.genre;
  if (t.durationSec !== undefined) out.durationSec = t.durationSec;
  if (t.artUrl !== undefined) out.artUrl = t.artUrl;
  if (t.isrc !== undefined) out.isrc = t.isrc;
  if (t.spotifyId !== undefined) out.spotifyId = t.spotifyId;
  if (t.sourceSite !== undefined) out.sourceSite = t.sourceSite;
  if (t.sourceUrl !== undefined) out.sourceUrl = t.sourceUrl;
  if (t.sourceId !== undefined) out.sourceId = t.sourceId;
  return out;
}
