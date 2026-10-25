-- Open Record: accounts schema (Supabase Postgres).
--
-- Track metadata only: audio is never stored here (saved audio stays on the
-- device). Every row belongs to one user and row-level security limits each
-- signed-in user to their own rows (user_id = auth.uid()). The anon role gets
-- no table access at all.
--
-- Sync is not wired yet. `updated_at` is written by the client and
-- `deleted_at` is a tombstone, so the follow-up offline-first sync can apply
-- last-write-wins without losing deletes.

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

-- ---------------------------------------------------------------------------
-- library_items: bookmarked records (the app's Track metadata, no audio).
-- track_id is the app's provider-namespaced Track.id.
-- ---------------------------------------------------------------------------
create table public.library_items (
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  track_id text not null check (char_length(track_id) between 1 and 512),
  provider_id text not null check (char_length(provider_id) between 1 and 64),
  title text not null check (char_length(title) <= 500),
  artist text not null check (char_length(artist) <= 500),
  album text check (char_length(album) <= 500),
  year integer check (year between 0 and 9999),
  genre text check (char_length(genre) <= 100),
  duration_sec integer check (duration_sec >= 0),
  art_url text check (char_length(art_url) <= 2048),
  isrc text check (char_length(isrc) <= 32),
  spotify_id text check (char_length(spotify_id) <= 64),
  source_site text check (char_length(source_site) <= 64),
  source_url text check (char_length(source_url) <= 4096),
  added_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  primary key (user_id, track_id)
);

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

-- One row per entry (a playlist may list the same track twice). Carries a
-- small metadata snapshot so a playlist renders without the library.
create table public.playlist_tracks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid(),
  playlist_id text not null,
  position double precision not null,
  track_id text not null check (char_length(track_id) between 1 and 512),
  title text not null check (char_length(title) <= 500),
  artist text not null check (char_length(artist) <= 500),
  album text check (char_length(album) <= 500),
  duration_sec integer check (duration_sec >= 0),
  isrc text check (char_length(isrc) <= 32),
  spotify_id text check (char_length(spotify_id) <= 64),
  source_url text check (char_length(source_url) <= 4096),
  added_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  foreign key (user_id, playlist_id) references public.playlists (user_id, id) on delete cascade
);

create index playlist_tracks_order_idx on public.playlist_tracks (user_id, playlist_id, position);

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
