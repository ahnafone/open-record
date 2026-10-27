-- Import history (Settings > Import history) synced across the account's
-- devices. Metadata only: a label, counts and track ids per import run, never
-- raw Spotify payloads or file contents. Spotify session track ids are import
-- item keys (e.g. `spotify:<id>`); they only resolve on devices holding the
-- matching import job, other devices fall back to the stored counts.
--
-- Synced like library_items: `updated_at` is the client's change clock,
-- `deleted_at` a tombstone, and lww_guard() drops any update older than the
-- stored row. A tombstone may omit kind and label.
create table public.import_sessions (
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  -- The app's local session id (a UUID, or a short fallback id).
  id text not null check (char_length(id) between 1 and 128),
  kind text check (kind in ('files', 'spotify', 'youtube')),
  label text check (char_length(label) between 1 and 300),
  -- When the import ran (the session's createdAt).
  created_at timestamptz not null default now(),
  added integer not null default 0 check (added >= 0),
  skipped integer not null default 0 check (skipped >= 0),
  failed integer not null default 0 check (failed >= 0),
  track_ids text[] not null default '{}'::text[]
    check (cardinality(track_ids) <= 10000),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  primary key (user_id, id),
  check (deleted_at is not null or (kind is not null and label is not null))
);

create index import_sessions_updated_idx on public.import_sessions (user_id, updated_at);

create trigger import_sessions_lww
  before update on public.import_sessions
  for each row execute function public.lww_guard();

alter table public.import_sessions enable row level security;

create policy "import_sessions: own rows" on public.import_sessions
  for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

-- Accounts only: the public anon key reads and writes nothing.
revoke all on public.import_sessions from anon;

-- Account deletion: the foreign key above already cascades from auth.users;
-- the explicit delete keeps delete_own_account() listing every synced table.
-- create or replace keeps the existing grants (authenticated only).
create or replace function public.delete_own_account()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid uuid := auth.uid();
begin
  if uid is null then
    raise exception 'Not signed in' using errcode = '28000';
  end if;

  delete from public.playlist_tracks where user_id = uid;
  delete from public.playlists where user_id = uid;
  delete from public.library_items where user_id = uid;
  delete from public.import_sessions where user_id = uid;
  delete from public.import_jobs where user_id = uid;
  delete from public.match_cache where user_id = uid;
  delete from public.profiles where id = uid;
  delete from auth.users where id = uid;
end;
$$;
