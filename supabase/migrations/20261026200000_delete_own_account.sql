-- Self-service account deletion from the app (Account > Delete account),
-- without ever shipping the service_role key. Runs as the function owner
-- (security definer) so it can remove the caller's auth.users row; it only
-- ever touches rows of auth.uid(), never an id passed in.
--
-- Every synced table references auth.users with on delete cascade; the
-- explicit deletes below keep that true even if a table is added later
-- without a cascade, and run in one transaction with the user delete.
create function public.delete_own_account()
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
  delete from public.import_jobs where user_id = uid;
  delete from public.match_cache where user_id = uid;
  delete from public.profiles where id = uid;
  delete from auth.users where id = uid;
end;
$$;

-- Signed-in users only (each can delete only their own account).
revoke execute on function public.delete_own_account() from public, anon;
grant execute on function public.delete_own_account() to authenticated;
