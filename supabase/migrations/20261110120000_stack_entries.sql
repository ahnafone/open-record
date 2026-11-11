-- Your Stack (user-added queue entries), synced across the account's devices.
-- Metadata only: the audio never leaves the device that downloaded it.
--
-- One row per queue entry, so two devices adding songs never conflict: an add
-- is an insert, a removal (manual, or played through) is a delete, and a clear
-- deletes the entries the client knows about. A duplicate song is allowed; each
-- entry has its own entry_id, which is the row identity.
--
-- `position` is a spaced sort key (gaps left between entries, so a new entry
-- takes a midpoint and a removal rewrites no other row). A reorder or a
-- renumber updates only the rows that moved; an existing row is updated, never
-- upserted, so a row another device deleted is not re-created. Ties between
-- devices sort by entry_id, so ordering is last-write-wins.
--
-- A user holds at most 500 entries (enforced by the trigger below, the same
-- cap the app applies).
--
-- `track` holds the app's SyncTrack (camelCase keys, same shape as the
-- metadata copies in play_counts) so the entry can be rebuilt on another device
-- even when the track is not in its library.
--
-- Account deletion cascades through auth.users like every other table.
create table public.stack_entries (
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  entry_id text not null check (char_length(entry_id) between 1 and 64),
  position integer not null check (position between 0 and 2000000000),
  track jsonb not null check (jsonb_typeof(track) = 'object' and pg_column_size(track) <= 8192),
  created_at timestamptz not null default now(),
  primary key (user_id, entry_id)
);

-- Ordered reads on pull: the stack's play order.
create index stack_entries_position_idx on public.stack_entries (user_id, position);

-- The per-user cap. An insert of an existing entry (an upsert that updates it)
-- is allowed; a new entry past the cap is rejected.
create function public.stack_entries_enforce_cap()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  -- Serialize inserts per user, so two concurrent inserts cannot both pass the
  -- count. Released at the end of the transaction.
  perform pg_advisory_xact_lock(hashtext(new.user_id::text));
  if exists (
    select 1 from public.stack_entries
    where user_id = new.user_id and entry_id = new.entry_id
  ) then
    return new;
  end if;
  if (
    select count(*) from public.stack_entries where user_id = new.user_id
  ) >= 500 then
    raise exception 'Your Stack is full (500 entries)' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

-- Trigger function: only the trigger runs it, never an API role.
revoke execute on function public.stack_entries_enforce_cap() from public, anon, authenticated;

create trigger stack_entries_cap
  before insert on public.stack_entries
  for each row execute function public.stack_entries_enforce_cap();

-- Row-level security: each signed-in user sees and writes only their rows.
-- (select auth.uid()) is evaluated once per statement, not per row.
alter table public.stack_entries enable row level security;

create policy "stack_entries: own rows" on public.stack_entries
  for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

-- Accounts only: the public anon key reads and writes nothing.
revoke all on public.stack_entries from anon;

-- Account deletion: re-issued so the function keeps listing every synced table
-- (the foreign key already cascades from auth.users). create or replace keeps
-- the existing grants (authenticated only).
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
  delete from public.play_counts where user_id = uid;
  delete from public.import_sessions where user_id = uid;
  delete from public.stack_entries where user_id = uid;
  delete from public.import_jobs where user_id = uid;
  delete from public.match_cache where user_id = uid;
  delete from public.profiles where id = uid;
  delete from auth.users where id = uid;
end;
$$;
