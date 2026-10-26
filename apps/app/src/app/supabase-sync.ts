import {
  SyncPort,
  type SyncLibraryItem,
  type SyncPlaylist,
  type SyncSnapshot,
  type SyncTrack,
} from '@open-record/state';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { SupabaseAuth } from './supabase-auth';

/** PostgREST returns at most this many rows per request by default. */
const PAGE = 1000;
/** Rows per upsert request. */
const CHUNK = 500;

interface LibraryRow {
  track_id: string;
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
  saved: boolean;
  saved_at: string | null;
  updated_at: string;
  deleted_at: string | null;
}

interface PlaylistRow {
  id: string;
  name: string;
  visibility: 'private' | 'public';
  auto_download: boolean;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

interface PlaylistTrackRow {
  playlist_id: string;
  position: number;
  track_id: string;
  added_at: string | null;
}

const LIBRARY_COLUMNS =
  'track_id,provider_id,title,artist,album,year,genre,duration_sec,art_url,isrc,spotify_id,source_site,source_url,source_id,saved,saved_at,updated_at,deleted_at';

/**
 * Account sync over the signed-in Supabase session (the client is shared
 * with `SupabaseAuth`). Row-level security scopes every query to the user;
 * the database applies last-write-wins on `updated_at`.
 */
export class SupabaseSync extends SyncPort {
  constructor(private readonly auth: SupabaseAuth) {
    super();
  }

  async userId(): Promise<string | null> {
    const client = await this.auth.sharedClient();
    if (!client) return null;
    const { data } = await client.auth.getSession();
    return data.session?.user.id ?? null;
  }

  async pull(): Promise<SyncSnapshot> {
    const client = await this.requireClient();
    const [library, playlists, tracks] = await Promise.all([
      pageAll<LibraryRow>(client, 'library_items', LIBRARY_COLUMNS, ['track_id']),
      pageAll<PlaylistRow>(
        client,
        'playlists',
        'id,name,visibility,auto_download,created_at,updated_at,deleted_at',
        ['id'],
      ),
      pageAll<PlaylistTrackRow>(
        client,
        'playlist_tracks',
        'playlist_id,position,track_id,added_at',
        ['playlist_id', 'position'],
      ),
    ]);
    const trackIds = new Map<string, string[]>();
    const addedAt = new Map<string, Record<string, number>>();
    for (const t of tracks) {
      const list = trackIds.get(t.playlist_id) ?? [];
      list.push(t.track_id);
      trackIds.set(t.playlist_id, list);
      // Null for rows written before the column existed or by older clients.
      const at = t.added_at ? ms(t.added_at) : NaN;
      if (Number.isFinite(at) && at > 0) {
        const times = addedAt.get(t.playlist_id) ?? {};
        // A repeated track keeps its first (earliest position) time.
        if (!(t.track_id in times)) times[t.track_id] = at;
        addedAt.set(t.playlist_id, times);
      }
    }
    return {
      library: library.map(fromLibraryRow),
      playlists: playlists.map((p) =>
        fromPlaylistRow(p, trackIds.get(p.id) ?? [], addedAt.get(p.id)),
      ),
    };
  }

  async push(changes: SyncSnapshot): Promise<void> {
    const client = await this.requireClient();
    const userId = await this.userId();
    if (!userId) throw new Error('Sign in to sync.');
    const rows = changes.library.map((i) => toLibraryRow(i, userId));
    for (let i = 0; i < rows.length; i += CHUNK) {
      const { error } = await client
        .from('library_items')
        .upsert(rows.slice(i, i + CHUNK), { onConflict: 'user_id,track_id' });
      if (error) throw new Error(error.message);
    }
    for (const p of changes.playlists) {
      const { error } = await client.rpc('push_playlist', {
        p_id: p.id,
        // A tombstone keeps no name locally; the column requires one.
        p_name: p.name || 'Deleted playlist',
        p_visibility: p.visibility,
        p_auto_download: p.autoDownload,
        p_created_at: iso(p.createdAt),
        p_updated_at: iso(p.updatedAt),
        p_deleted_at: p.deletedAt ? iso(p.deletedAt) : null,
        p_track_ids: p.deletedAt ? [] : p.trackIds,
        // Aligned with p_track_ids; null where the date is unknown.
        p_added_at: p.deletedAt
          ? []
          : p.trackIds.map((id) => {
              const at = p.addedAt?.[id];
              return at !== undefined && Number.isFinite(at) && at > 0 ? iso(at) : null;
            }),
      });
      if (error) throw new Error(error.message);
    }
  }

  private async requireClient(): Promise<SupabaseClient> {
    const client = await this.auth.sharedClient();
    if (!client) throw new Error('Accounts are not set up.');
    return client;
  }
}

async function pageAll<T>(
  client: SupabaseClient,
  table: string,
  columns: string,
  order: readonly string[],
): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += PAGE) {
    let query = client.from(table).select(columns);
    for (const column of order) query = query.order(column, { ascending: true });
    const { data, error } = await query.range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as unknown as T[];
    out.push(...rows);
    if (rows.length < PAGE) return out;
  }
}

const iso = (ms: number) => new Date(ms).toISOString();
const ms = (value: string) => Date.parse(value);

function toLibraryRow(i: SyncLibraryItem, userId: string): LibraryRow & { user_id: string } {
  // Every key is sent so a tombstone clears the metadata of a live row.
  const t = i.deletedAt ? undefined : i.track;
  return {
    user_id: userId,
    track_id: i.trackId,
    provider_id: t?.providerId ?? null,
    title: t?.title ?? null,
    artist: t?.artist ?? null,
    album: t?.album ?? null,
    year: t?.year ?? null,
    genre: t?.genre ?? null,
    duration_sec: t?.durationSec ?? null,
    art_url: t?.artUrl ?? null,
    isrc: t?.isrc ?? null,
    spotify_id: t?.spotifyId ?? null,
    source_site: t?.sourceSite ?? null,
    source_url: t?.sourceUrl ?? null,
    source_id: t?.sourceId ?? null,
    saved: !i.deletedAt && i.saved,
    saved_at: !i.deletedAt && i.saved && i.savedAt ? iso(i.savedAt) : null,
    updated_at: iso(i.updatedAt),
    deleted_at: i.deletedAt ? iso(i.deletedAt) : null,
  };
}

function fromLibraryRow(r: LibraryRow): SyncLibraryItem {
  const item: SyncLibraryItem = {
    trackId: r.track_id,
    saved: r.saved,
    updatedAt: ms(r.updated_at),
  };
  if (r.saved_at) item.savedAt = ms(r.saved_at);
  if (r.deleted_at) {
    item.deletedAt = ms(r.deleted_at);
    item.saved = false;
    return item;
  }
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

function fromPlaylistRow(
  r: PlaylistRow,
  trackIds: string[],
  addedAt?: Record<string, number>,
): SyncPlaylist {
  const p: SyncPlaylist = {
    id: r.id,
    name: r.name,
    visibility: r.visibility,
    autoDownload: r.auto_download,
    trackIds,
    createdAt: ms(r.created_at),
    updatedAt: ms(r.updated_at),
  };
  if (r.deleted_at) p.deletedAt = ms(r.deleted_at);
  else if (addedAt && Object.keys(addedAt).length) p.addedAt = addedAt;
  return p;
}
