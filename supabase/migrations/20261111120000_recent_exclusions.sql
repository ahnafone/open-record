-- Recent exclusions (songs played, skipped or removed in the last 12 hours),
-- synced across the account's devices. A shuffled Keep Spinning fill on one
-- device then skips what another device just excluded. Metadata only: a song
-- id and a time, never audio.
--
-- Writes go only through record_exclusions(), which clamps times and enforces
-- the 12-hour window and the per-user cap. Clients have select-only access to
-- their own rows; direct insert, update and delete are revoked.
--
-- One row per song: the latest exclusion time wins (greatest), so a stale
-- batch cannot move a song's time backwards. Rows older than 12 hours are
-- deleted on every write, and a per-user cap of 2000 rows evicts the oldest.
--
-- `local:` tracks are device-only and never reach this table.
--
-- Account deletion cascades through auth.users like every other table.
create table public.recent_exclusions (
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  track_id text not null check (
    char_length(track_id) between 1 and 512 and track_id not like 'local:%'
  ),
  excluded_at timestamptz not null,
  primary key (user_id, track_id)
);

-- Window reads and the age and cap deletes in record_exclusions().
create index recent_exclusions_recent_idx on public.recent_exclusions (user_id, excluded_at);

-- Row-level security: a signed-in user reads only their rows. There is no
-- insert, update or delete policy and no grant for them (below); writes happen
-- in record_exclusions(), which runs as the table owner and filters on uid.
-- (select auth.uid()) is evaluated once per statement, not per row.
alter table public.recent_exclusions enable row level security;

create policy "recent_exclusions: own rows" on public.recent_exclusions
  for select to authenticated
  using (user_id = (select auth.uid()));

-- Accounts only: the public anon key reads and writes nothing. Signed-in users
-- may read their rows but never write them directly (the RPC is the only writer).
revoke all on public.recent_exclusions from anon, authenticated;
grant select on public.recent_exclusions to authenticated;

-- Record a batch of exclusions. p_items is a JSON array of
-- { "track_id", "at" } entries, where "at" is epoch milliseconds.
--
-- Security definer so it can write past the revoked grants, which makes the
-- checks here the only guard: uid comes from auth.uid() (never a parameter),
-- and every statement is limited to user_id = uid. Malformed entries (no track
-- id, a non-number time, a local: track) are skipped rather than failing the
-- batch. A time outside the sane range is clamped into it and never later than
-- now(): a future time would otherwise never age out of the window. Entries
-- older than the 12-hour window are not written.
--
-- A CHECK constraint cannot compare against now() (it is not immutable), so the
-- clamp here is the protection for excluded_at.
create function public.record_exclusions(p_items jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid uuid := auth.uid();
begin
  if uid is null then
    raise exception 'Not signed in.' using errcode = '28000';
  end if;

  -- Nothing to record: missing, not an array, or empty.
  if p_items is null or jsonb_typeof(p_items) <> 'array' then
    return;
  end if;
  if jsonb_array_length(p_items) = 0 then
    return;
  end if;
  -- The client sends at most 2000 per call (its chunk size).
  if jsonb_array_length(p_items) > 2000 then
    raise exception 'too many exclusions' using errcode = '22023';
  end if;

  -- One statement: parse, drop invalid entries, keep the latest time per track
  -- (a single INSERT ... ON CONFLICT cannot touch the same row twice), then
  -- upsert with greatest() so an older time never overwrites a newer one.
  insert into public.recent_exclusions as re (user_id, track_id, excluded_at)
  select uid, batch.track_id, batch.excluded_at
  from (
    select
      parsed.track_id,
      max(parsed.excluded_at) as excluded_at
    from (
      select
        case
          when jsonb_typeof(e.value -> 'track_id') = 'string'
            then nullif(btrim(e.value ->> 'track_id'), '')
        end as track_id,
        -- Nested so the numeric cast only runs for a JSON number.
        case
          when jsonb_typeof(e.value -> 'at') = 'number' then
            least(
              to_timestamp(
                least(greatest((e.value ->> 'at')::numeric, 946684800000), 4102444800000)
                  / 1000.0
              ),
              now()
            )
        end as excluded_at
      from jsonb_array_elements(p_items) as e (value)
    ) as parsed
    where parsed.track_id is not null
      and char_length(parsed.track_id) <= 512
      and parsed.track_id not like 'local:%'
      and parsed.excluded_at is not null
      and parsed.excluded_at >= now() - interval '12 hours'
    group by parsed.track_id
  ) as batch
  on conflict (user_id, track_id) do update set
    excluded_at = greatest(re.excluded_at, excluded.excluded_at);

  -- Drop this user's rows that have left the 12-hour window.
  delete from public.recent_exclusions
  where user_id = uid
    and excluded_at < now() - interval '12 hours';

  -- Per-user cap: keep the newest 2000 rows, evict the rest (oldest first).
  delete from public.recent_exclusions
  where user_id = uid
    and track_id in (
      select rx.track_id
      from public.recent_exclusions as rx
      where rx.user_id = uid
      order by rx.excluded_at desc, rx.track_id
      offset 2000
    );
end;
$$;

-- Sync RPC: signed-in users only.
revoke execute on function public.record_exclusions(jsonb) from public, anon;
grant execute on function public.record_exclusions(jsonb) to authenticated;

-- Account deletion: re-issued so the function keeps listing every synced table
-- (the foreign key already cascades from auth.users). create or replace keeps
-- the existing grants (authenticated only). Copied from stack_entries' version
-- with the recent_exclusions line added.
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
  delete from public.recent_exclusions where user_id = uid;
  delete from public.import_jobs where user_id = uid;
  delete from public.match_cache where user_id = uid;
  delete from public.profiles where id = uid;
  delete from auth.users where id = uid;
end;
$$;
