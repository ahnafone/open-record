-- Approval-gated public signup. Visitors cannot create accounts themselves
-- (enable_signup is off); they REQUEST access here. The single admin approves,
-- denies or revokes each request through the Edge Functions, and approval sends
-- a Supabase invite.
--
-- Only the service role touches this table (the Edge Functions and the Node
-- server). RLS is on with NO policies and anon/authenticated are revoked, so
-- nothing signed-in or public can read or write a request, including other
-- people's emails and notes.

create table public.access_requests (
  id uuid primary key default gen_random_uuid(),
  -- Stored lowercased (the request-access function normalises it). The unique
  -- index below makes "one request per address" hold regardless of case.
  email text not null check (char_length(email) between 3 and 254 and email = lower(email)),
  -- Optional message from the requester, shown to the admin only.
  note text check (char_length(note) <= 500),
  status text not null default 'pending' check (
    status in ('pending', 'approved', 'denied', 'revoked')
  ),
  -- Set once the invite (or an existing account) is linked; null until then.
  user_id uuid references auth.users (id) on delete set null,
  requested_at timestamptz not null default now(),
  decided_at timestamptz,
  -- Hex SHA-256 of the requester's IP salted with REQUEST_IP_SALT (or "unknown").
  -- Never the raw IP. Used only to throttle request-access per source.
  source_ip_hash text check (char_length(source_ip_hash) <= 128),
  -- Last time the "you already have access" notice was emailed for this row.
  -- Used to cap that notice to once per hour per address.
  last_notice_at timestamptz
);

create unique index access_requests_email_key on public.access_requests (lower(email));
create index access_requests_user_id_idx on public.access_requests (user_id);
create index access_requests_requested_at_idx on public.access_requests (requested_at);
create index access_requests_source_requested_idx
  on public.access_requests (source_ip_hash, requested_at);

alter table public.access_requests enable row level security;

-- No policies on purpose: with RLS on and no policy, every non-service role is
-- denied. The revoke is belt and braces so a future policy cannot expose rows
-- by accident.
revoke all on public.access_requests from anon, authenticated;
