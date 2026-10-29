-- Per-track play counts, synced across the account's devices. Metadata only:
-- the audio never leaves the device that downloaded it.
--
-- Counts are ADDITIVE, not last-write-wins: a play total only ever grows, so
-- replaying an old batch cannot clobber a newer total the way a stale
-- library_items/playlists write could. There is deliberately no lww_guard() and
-- no touch_updated_at() trigger here; record_plays() adds increments and stamps
-- updated_at itself.
--
-- The client sends only the increments it has not uploaded yet (one
-- { track_id, count, at } entry per track) and clears its pending queue only
-- after a successful call. Delivery is therefore at-least-once: a response lost
-- after the server committed makes the next flush add that batch again.
--
-- Track metadata is a copy of the library_items row, kept so a total survives
-- the track being removed from the library. Metadata already stored on the row
-- wins; a batch never overwrites it.
--
-- `local:` tracks are device-only (the audio exists on one device only) and are
-- never uploaded, so they never produce a row here.
--
-- Account deletion cascades through auth.users like every other table.
create table public.play_counts (
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  track_id text not null check (
    char_length(track_id) between 1 and 512 and track_id not like 'local:%'
  ),
  count bigint not null default 0 check (count >= 0),
  first_played_at timestamptz not null default now(),
  last_played_at timestamptz not null default now(),
  -- Optional metadata, same columns and bounds as library_items.
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
  -- Server-stamped by record_plays(); not a client change clock.
  updated_at timestamptz not null default now(),
  primary key (user_id, track_id)
);

-- "Recently played" reads: newest first.
create index play_counts_recent_idx on public.play_counts (user_id, last_played_at desc);

-- Row-level security: each signed-in user sees and writes only their rows.
-- (select auth.uid()) is evaluated once per statement, not per row.
alter table public.play_counts enable row level security;

create policy "play_counts: own rows" on public.play_counts
  for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

-- Accounts only: the public anon key reads and writes nothing.
revoke all on public.play_counts from anon;

-- Add a batch of play increments and return the touched rows. p_plays is a JSON
-- array of { "track_id", "count", "at", "track": { metadata } } entries, where
-- "at" is epoch milliseconds and "track" uses the app's camelCase field names.
--
-- Runs as the caller, so row-level security still applies. Malformed entries are
-- ignored rather than failing the whole batch, so one bad track cannot lose the
-- other plays; the batch is aggregated by track_id first because a single
-- INSERT ... ON CONFLICT cannot touch the same row twice.
create function public.record_plays(p_plays jsonb)
returns table (
  track_id text,
  count bigint,
  first_played_at timestamptz,
  last_played_at timestamptz
)
language plpgsql
security invoker
set search_path = ''
as $$
-- The RETURNS TABLE names (track_id, count, ...) are also plpgsql variables.
-- use_column keeps the unqualified names required by ON CONFLICT
-- (user_id, track_id) and the SET targets pointing at the table, not a
-- variable; every other column reference below is table-qualified anyway.
#variable_conflict use_column
declare
  uid uuid := auth.uid();
begin
  if uid is null then
    raise exception 'Not signed in.' using errcode = '28000';
  end if;

  -- Nothing to record: missing, not an array, or empty.
  if p_plays is null or jsonb_typeof(p_plays) <> 'array' then
    return;
  end if;
  if jsonb_array_length(p_plays) = 0 then
    return;
  end if;
  -- Same order of magnitude as the other batch RPCs (push_playlist).
  if jsonb_array_length(p_plays) > 10000 then
    raise exception 'too many plays' using errcode = '22023';
  end if;

  -- Aggregated batch. A temp table (not a CTE) because the upsert below must be
  -- a single statement and the RETURN QUERY then needs the same ids again. It is
  -- dropped on commit, and recreated here first so a repeated call inside one
  -- transaction does not collide (to_regclass keeps that quiet).
  if to_regclass('pg_temp.play_counts_batch') is not null then
    drop table pg_temp.play_counts_batch;
  end if;

  create temp table pg_temp.play_counts_batch on commit drop as
  with entries as (
    select e.value as entry, e.ord
    from jsonb_array_elements(p_plays) with ordinality as e (value, ord)
  ),
  parsed as (
    select
      entries.ord,
      -- track_id must be a non-empty string.
      case
        when jsonb_typeof(entries.entry -> 'track_id') = 'string'
          then nullif(btrim(entries.entry ->> 'track_id'), '')
      end as track_id,
      -- count must be a number; non-positive counts are dropped below.
      case
        when jsonb_typeof(entries.entry -> 'count') = 'number'
          then (entries.entry ->> 'count')::numeric
      end as plays,
      -- Epoch ms to timestamptz; missing or absurd values fall back to now().
      case
        when jsonb_typeof(entries.entry -> 'at') = 'number'
         and (entries.entry ->> 'at')::numeric between 946684800000 and 4102444800000
          then to_timestamp(((entries.entry ->> 'at')::numeric / 1000.0)::double precision)
      end as played_at,
      -- Earliest play of the increment (falls back to the latest one).
      case
        when jsonb_typeof(entries.entry -> 'first') = 'number'
         and (entries.entry ->> 'first')::numeric between 946684800000 and 4102444800000
          then to_timestamp(((entries.entry ->> 'first')::numeric / 1000.0)::double precision)
      end as first_at,
      entries.entry -> 'track' as track
    from entries
  ),
  cleaned as (
    select
      parsed.ord,
      parsed.track_id,
      trunc(least(coalesce(parsed.plays, 0), 10000))::bigint as plays,
      coalesce(parsed.played_at, now()) as played_at,
      coalesce(parsed.first_at, parsed.played_at, now()) as first_at,
      left(nullif(btrim(parsed.track ->> 'providerId'), ''), 64) as provider_id,
      left(nullif(btrim(parsed.track ->> 'title'), ''), 500) as title,
      left(nullif(btrim(parsed.track ->> 'artist'), ''), 500) as artist,
      left(nullif(btrim(parsed.track ->> 'album'), ''), 500) as album,
      case
        when (parsed.track ->> 'year') ~ '^[0-9]{1,4}$'
          then (parsed.track ->> 'year')::integer
      end as year,
      left(nullif(btrim(parsed.track ->> 'genre'), ''), 100) as genre,
      case
        when (parsed.track ->> 'durationSec') ~ '^[0-9]{1,6}$'
          then (parsed.track ->> 'durationSec')::integer
      end as duration_sec,
      left(nullif(btrim(parsed.track ->> 'artUrl'), ''), 2048) as art_url,
      left(nullif(btrim(parsed.track ->> 'isrc'), ''), 32) as isrc,
      left(nullif(btrim(parsed.track ->> 'spotifyId'), ''), 64) as spotify_id,
      left(nullif(btrim(parsed.track ->> 'sourceSite'), ''), 64) as source_site,
      left(nullif(btrim(parsed.track ->> 'sourceUrl'), ''), 4096) as source_url,
      left(nullif(btrim(parsed.track ->> 'sourceId'), ''), 512) as source_id
    from parsed
    where parsed.track_id is not null
      and char_length(parsed.track_id) <= 512
      and parsed.track_id not like 'local:%'
      and parsed.plays >= 1
  )
  -- One row per track_id: counts add up, the window widens, and the earliest
  -- non-null metadata in the batch is the one offered for the upsert.
  select
    cleaned.track_id,
    sum(cleaned.plays)::bigint as count,
    min(cleaned.first_at) as first_played_at,
    max(cleaned.played_at) as last_played_at,
    (array_agg(cleaned.provider_id order by cleaned.ord)
      filter (where cleaned.provider_id is not null))[1] as provider_id,
    (array_agg(cleaned.title order by cleaned.ord)
      filter (where cleaned.title is not null))[1] as title,
    (array_agg(cleaned.artist order by cleaned.ord)
      filter (where cleaned.artist is not null))[1] as artist,
    (array_agg(cleaned.album order by cleaned.ord)
      filter (where cleaned.album is not null))[1] as album,
    (array_agg(cleaned.year order by cleaned.ord)
      filter (where cleaned.year is not null))[1] as year,
    (array_agg(cleaned.genre order by cleaned.ord)
      filter (where cleaned.genre is not null))[1] as genre,
    (array_agg(cleaned.duration_sec order by cleaned.ord)
      filter (where cleaned.duration_sec is not null))[1] as duration_sec,
    (array_agg(cleaned.art_url order by cleaned.ord)
      filter (where cleaned.art_url is not null))[1] as art_url,
    (array_agg(cleaned.isrc order by cleaned.ord)
      filter (where cleaned.isrc is not null))[1] as isrc,
    (array_agg(cleaned.spotify_id order by cleaned.ord)
      filter (where cleaned.spotify_id is not null))[1] as spotify_id,
    (array_agg(cleaned.source_site order by cleaned.ord)
      filter (where cleaned.source_site is not null))[1] as source_site,
    (array_agg(cleaned.source_url order by cleaned.ord)
      filter (where cleaned.source_url is not null))[1] as source_url,
    (array_agg(cleaned.source_id order by cleaned.ord)
      filter (where cleaned.source_id is not null))[1] as source_id
  from cleaned
  group by cleaned.track_id;

  -- One statement for the whole batch: increments add, the window widens, and
  -- metadata already stored on the row wins over the batch's copy. Ordered by
  -- track_id - user_id is constant per call, so this is the whole conflict key -
  -- which helps concurrent calls reach the same rows in the same order.
  insert into public.play_counts as pc (
    user_id, track_id, count, first_played_at, last_played_at,
    provider_id, title, artist, album, year, genre, duration_sec, art_url,
    isrc, spotify_id, source_site, source_url, source_id
  )
  select
    uid, b.track_id, b.count, b.first_played_at, b.last_played_at,
    b.provider_id, b.title, b.artist, b.album, b.year, b.genre, b.duration_sec,
    b.art_url, b.isrc, b.spotify_id, b.source_site, b.source_url, b.source_id
  from pg_temp.play_counts_batch as b
  order by b.track_id
  on conflict (user_id, track_id) do update set
    count = pc.count + excluded.count,
    first_played_at = least(pc.first_played_at, excluded.first_played_at),
    last_played_at = greatest(pc.last_played_at, excluded.last_played_at),
    updated_at = now(),
    provider_id = coalesce(pc.provider_id, excluded.provider_id),
    title = coalesce(pc.title, excluded.title),
    artist = coalesce(pc.artist, excluded.artist),
    album = coalesce(pc.album, excluded.album),
    year = coalesce(pc.year, excluded.year),
    genre = coalesce(pc.genre, excluded.genre),
    duration_sec = coalesce(pc.duration_sec, excluded.duration_sec),
    art_url = coalesce(pc.art_url, excluded.art_url),
    isrc = coalesce(pc.isrc, excluded.isrc),
    spotify_id = coalesce(pc.spotify_id, excluded.spotify_id),
    source_site = coalesce(pc.source_site, excluded.source_site),
    source_url = coalesce(pc.source_url, excluded.source_url),
    source_id = coalesce(pc.source_id, excluded.source_id);

  -- The stored totals after the batch, so the client can adopt them directly.
  return query
    select pc.track_id, pc.count, pc.first_played_at, pc.last_played_at
    from public.play_counts as pc
    join pg_temp.play_counts_batch as b on b.track_id = pc.track_id
    where pc.user_id = uid
    order by pc.track_id;
end;
$$;

-- Sync RPC: signed-in users only.
revoke execute on function public.record_plays(jsonb) from public, anon;
grant execute on function public.record_plays(jsonb) to authenticated;

-- Account deletion: the foreign key above already cascades from auth.users;
-- re-issuing the function keeps it listing every synced table.
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
  delete from public.play_counts where user_id = uid;
  delete from public.import_sessions where user_id = uid;
  delete from public.import_jobs where user_id = uid;
  delete from public.match_cache where user_id = uid;
  delete from public.profiles where id = uid;
  delete from auth.users where id = uid;
end;
$$;
