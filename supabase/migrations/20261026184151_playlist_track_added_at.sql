-- Per-track "date added" for playlists, synced across devices.
-- Nullable: rows written by older clients (or before this migration) have none.
alter table public.playlist_tracks
  add column added_at timestamptz;

-- push_playlist gains p_added_at, aligned by index with p_track_ids (a null
-- element or a missing/short array stores null). It defaults to null so
-- clients that omit it keep working. The old 8-argument overload is dropped
-- so PostgREST does not see two candidates for the same named arguments.
drop function public.push_playlist(text, text, text, boolean, timestamptz, timestamptz, timestamptz, text[]);

-- Upsert one playlist and replace its ordered track list in one transaction,
-- last-write-wins on updated_at (an older write is ignored). Runs as the
-- caller, so row-level security still applies. Returns true when applied.
create function public.push_playlist(
  p_id text,
  p_name text,
  p_visibility text,
  p_auto_download boolean,
  p_created_at timestamptz,
  p_updated_at timestamptz,
  p_deleted_at timestamptz,
  p_track_ids text[],
  p_added_at timestamptz[] default null
)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  uid uuid := auth.uid();
  current_updated timestamptz;
begin
  if uid is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  if coalesce(array_length(p_track_ids, 1), 0) > 10000
     or coalesce(array_length(p_added_at, 1), 0) > 10000 then
    raise exception 'playlist too long' using errcode = '22023';
  end if;

  select updated_at into current_updated
    from public.playlists
    where user_id = uid and id = p_id
    for update;
  if found and current_updated >= p_updated_at then
    return false;
  end if;

  insert into public.playlists as p
      (user_id, id, name, visibility, auto_download, created_at, updated_at, deleted_at)
    values
      (uid, p_id, p_name, coalesce(p_visibility, 'private'), coalesce(p_auto_download, false),
       coalesce(p_created_at, p_updated_at), p_updated_at, p_deleted_at)
    on conflict (user_id, id) do update set
      name = excluded.name,
      visibility = excluded.visibility,
      auto_download = excluded.auto_download,
      updated_at = excluded.updated_at,
      deleted_at = excluded.deleted_at;

  delete from public.playlist_tracks where user_id = uid and playlist_id = p_id;
  if p_deleted_at is null then
    insert into public.playlist_tracks (user_id, playlist_id, position, track_id, added_at)
      select uid, p_id, (t.ord - 1)::integer, t.track_id, p_added_at[t.ord::integer]
      from unnest(coalesce(p_track_ids, '{}'::text[])) with ordinality as t (track_id, ord);
  end if;
  return true;
end;
$$;

-- Sync RPC: signed-in users only.
revoke execute on function
  public.push_playlist(text, text, text, boolean, timestamptz, timestamptz, timestamptz, text[], timestamptz[])
  from public, anon;
grant execute on function
  public.push_playlist(text, text, text, boolean, timestamptz, timestamptz, timestamptz, text[], timestamptz[])
  to authenticated;
