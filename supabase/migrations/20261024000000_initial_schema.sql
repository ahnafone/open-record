-- Open Record: accounts schema (Supabase Postgres).
--
-- Track metadata only: audio is never stored here (saved audio stays on the
-- device). Every row belongs to one user and row-level security limits each
-- signed-in user to their own rows (user_id = auth.uid()). The anon role gets
-- no table access at all.
--
-- Offline-first sync: on synced tables (library_items, playlists) `updated_at`
-- is the client's change clock and `deleted_at` is a tombstone. A trigger
-- drops any update older than the stored row (last-write-wins), so a stale
-- device can never overwrite a newer change or resurrect a delete.

-- ---------------------------------------------------------------------------
-- Shared trigger functions.
-- ---------------------------------------------------------------------------

-- Server-stamped tables: keep updated_at current on every update.
create function public.touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- Client-clocked (synced) tables: skip an update that is older than the
-- stored row. Returning null from a BEFORE trigger silently drops the row
-- change, which also makes an upsert's ON CONFLICT branch a no-op.
create function public.lww_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.updated_at < old.updated_at then
    return null;
  end if;
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- profiles: one row per account, created by the trigger below.
-- ---------------------------------------------------------------------------
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text check (char_length(display_name) <= 80),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id) values (new.id) on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

create trigger profiles_touch_updated_at
  before update on public.profiles
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- library_items: the app's synced tracks (metadata only, never audio) and
-- their saved state. track_id is the app's provider-namespaced Track.id
-- (e.g. `remote:<id>` or an import placeholder `spotify:<id>`). One row per
-- (user, track). A tombstone (deleted_at set) may omit the metadata.
-- ---------------------------------------------------------------------------
create table public.library_items (
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  track_id text not null check (char_length(track_id) between 1 and 512),
  provider_id text check (char_length(provider_id) between 1 and 64),
  title text check (char_length(title) <= 500),
  artist text check (char_length(artist) <= 500),
  album text check (char_length(album) <= 500),
  year integer check (year between 0 and 9999),
  genre text check (char_length(genre) <= 100),
  duration_sec integer check (duration_sec >= 0),
  art_url text check (char_length(art_url) <= 2048),
  isrc text check (char_length(isrc) <= 32),
  spotify_id text check (char_length(spotify_id) <= 64),
  source_site text check (char_length(source_site) <= 64),
  source_url text check (char_length(source_url) <= 4096),
  source_id text check (char_length(source_id) <= 512),
  -- Saved (bookmarked) in the user's library; unsaved rows are tracks kept
  -- for playlists or imports.
  saved boolean not null default false,
  saved_at timestamptz,
  added_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  primary key (user_id, track_id),
  check (deleted_at is not null or (provider_id is not null and title is not null and artist is not null))
);

create index library_items_updated_idx on public.library_items (user_id, updated_at);

create trigger library_items_lww
  before update on public.library_items
  for each row execute function public.lww_guard();

create index library_items_isrc_idx on public.library_items (user_id, isrc) where isrc is not null;

-- ---------------------------------------------------------------------------
-- playlists and their tracks. id is the app's playlist id.
-- ---------------------------------------------------------------------------
create table public.playlists (
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  id text not null check (char_length(id) between 1 and 128),
  name text not null check (char_length(name) between 1 and 200),
  visibility text not null default 'private' check (visibility in ('private', 'public')),
  auto_download boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  primary key (user_id, id)
);

create index playlists_updated_idx on public.playlists (user_id, updated_at);

create trigger playlists_lww
  before update on public.playlists
  for each row execute function public.lww_guard();

-- Ordered entries (a playlist may list the same track twice). The whole list
-- is replaced together with its playlist row by push_playlist() below, so the
-- playlist's updated_at is the clock for its order too. Track metadata lives
-- in library_items.
create table public.playlist_tracks (
  user_id uuid not null default auth.uid(),
  playlist_id text not null,
  position integer not null check (position >= 0),
  track_id text not null check (char_length(track_id) between 1 and 512),
  primary key (user_id, playlist_id, position),
  foreign key (user_id, playlist_id) references public.playlists (user_id, id) on delete cascade
);

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
  p_track_ids text[]
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
  if coalesce(array_length(p_track_ids, 1), 0) > 10000 then
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
    insert into public.playlist_tracks (user_id, playlist_id, position, track_id)
      select uid, p_id, (t.ord - 1)::integer, t.track_id
      from unnest(coalesce(p_track_ids, '{}'::text[])) with ordinality as t (track_id, ord);
  end if;
  return true;
end;
$$;

-- ---------------------------------------------------------------------------
-- import_jobs: Spotify imports (resumable progress, counts only).
-- ---------------------------------------------------------------------------
create table public.import_jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  source text not null check (source in ('spotify_api', 'exportify_csv', 'spotify_json')),
  status text not null default 'pending'
    check (status in ('pending', 'running', 'paused', 'done', 'failed', 'cancelled')),
  label text check (char_length(label) <= 200),
  total integer not null default 0 check (total >= 0),
  matched integer not null default 0 check (matched >= 0),
  review integer not null default 0 check (review >= 0),
  unmatched integer not null default 0 check (unmatched >= 0),
  -- Index of the next track to match, so an interrupted job can resume.
  cursor integer not null default 0 check (cursor >= 0),
  error text check (char_length(error) <= 1000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index import_jobs_user_idx on public.import_jobs (user_id, created_at desc);

create trigger import_jobs_touch_updated_at
  before update on public.import_jobs
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- match_cache: per-user import matches (including manual fixes), so a
-- re-import does not search again. Never shared across users.
-- key is e.g. `isrc:<code>`, `spotify:<id>` or a normalized artist/title/duration.
-- ---------------------------------------------------------------------------
create table public.match_cache (
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  key text not null check (char_length(key) between 1 and 600),
  -- Null records a confirmed "no match".
  matched_url text check (char_length(matched_url) <= 4096),
  site text check (char_length(site) <= 64),
  title text check (char_length(title) <= 500),
  artist text check (char_length(artist) <= 500),
  duration_sec integer check (duration_sec >= 0),
  score real check (score between 0 and 1),
  manual boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, key)
);

create trigger match_cache_touch_updated_at
  before update on public.match_cache
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Row-level security: each signed-in user sees and writes only their rows.
-- (select auth.uid()) is evaluated once per statement, not per row.
-- ---------------------------------------------------------------------------
alter table public.profiles enable row level security;
alter table public.library_items enable row level security;
alter table public.playlists enable row level security;
alter table public.playlist_tracks enable row level security;
alter table public.import_jobs enable row level security;
alter table public.match_cache enable row level security;

create policy "profiles: read own" on public.profiles
  for select to authenticated using (id = (select auth.uid()));
create policy "profiles: update own" on public.profiles
  for update to authenticated
  using (id = (select auth.uid())) with check (id = (select auth.uid()));

create policy "library_items: own rows" on public.library_items
  for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

create policy "playlists: own rows" on public.playlists
  for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

create policy "playlist_tracks: own rows" on public.playlist_tracks
  for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

create policy "import_jobs: own rows" on public.import_jobs
  for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

create policy "match_cache: own rows" on public.match_cache
  for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

-- Accounts only: the public anon key reads and writes nothing.
revoke all on
  public.profiles,
  public.library_items,
  public.playlists,
  public.playlist_tracks,
  public.import_jobs,
  public.match_cache
from anon;

-- Profiles are created by the trigger and removed with the account.
revoke insert, delete on public.profiles from authenticated;
revoke execute on function public.handle_new_user() from public, anon, authenticated;
revoke execute on function public.touch_updated_at() from public, anon, authenticated;
revoke execute on function public.lww_guard() from public, anon, authenticated;

-- Sync RPC: signed-in users only.
revoke execute on function
  public.push_playlist(text, text, text, boolean, timestamptz, timestamptz, timestamptz, text[])
  from public, anon;
grant execute on function
  public.push_playlist(text, text, text, boolean, timestamptz, timestamptz, timestamptz, text[])
  to authenticated;
