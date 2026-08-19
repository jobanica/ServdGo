-- ServdGo — the franchisor can look at a city through its operator's eyes,
-- and cannot touch anything while doing it.
--
-- The obvious implementation — a ?hq_view_tenant= parameter — cannot work here.
-- Row-level security resolves the caller's city inside Postgres, from their
-- profile, and never sees a URL. Anything the client asserts is a suggestion.
--
-- So the session is a row. While it is open:
--
--   current_territory_id()  returns the city being viewed
--   is_staff()              becomes true, so the operator's read policies apply
--   is_franchisor()         becomes FALSE, so cross-city reads stop — otherwise
--                           "view as" would still show every city and prove
--                           nothing
--
-- Read-only is enforced by a statement-level trigger on every table rather than
-- by trusting the UI. Statement-level so it costs one call per statement, not
-- one per row, and on every table so there is no surface anyone forgot.

create table hq_view_sessions (
  id            bigint generated always as identity primary key,
  franchisor_id uuid not null references profiles (id) on delete cascade,
  territory_id  uuid not null references territories (id) on delete cascade,
  reason        text,
  started_at    timestamptz not null default now(),
  ended_at      timestamptz
);

-- One open session per person: viewing two cities at once is not a thing, and
-- the uniqueness is what makes "am I viewing?" a single cheap lookup.
create unique index hq_view_sessions_open on hq_view_sessions (franchisor_id)
  where ended_at is null;
create index hq_view_sessions_recent on hq_view_sessions (started_at desc);

comment on table hq_view_sessions is
  'An open row means the franchisor is looking at one city as its operator, and every write is refused.';

/** The city the caller is currently viewing as, or null. */
create or replace function viewing_as_territory()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select territory_id from hq_view_sessions
   where franchisor_id = auth.uid() and ended_at is null
   limit 1;
$$;
revoke all on function viewing_as_territory() from public;
grant execute on function viewing_as_territory() to anon, authenticated;

-- ---------------------------------------------------------------------------
-- The three functions the whole security model rests on, taught about it.
-- ---------------------------------------------------------------------------
create or replace function is_franchisor()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from profiles where id = auth.uid() and role::text = 'franchisor'
  )
  -- While viewing as an operator, the franchisor is not one. Otherwise the
  -- cross-city policies keep firing and the view shows everything.
  and viewing_as_territory() is null;
$$;

create or replace function is_staff()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from profiles
    where id = auth.uid()
      and role::text in ('admin', 'manager', 'dispatcher', 'support')
  )
  or viewing_as_territory() is not null;
$$;

create or replace function current_territory_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    viewing_as_territory(),
    (select p.territory_id from profiles p where p.id = auth.uid()),
    (select r.territory_id from riders r where r.profile_id = auth.uid())
  );
$$;

-- ---------------------------------------------------------------------------
-- Read-only, enforced.
-- ---------------------------------------------------------------------------
create or replace function hq_readonly_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if viewing_as_territory() is not null then
    raise exception 'You are viewing % as its operator. Leave the view before changing anything.',
      (select name from territories where id = viewing_as_territory())
      using errcode = 'insufficient_privilege';
  end if;
  return null;
end;
$$;

-- Attached to every table, except the two that have to keep working while a
-- session is open: the session table itself (or it could never be closed) and
-- the audit log (or the visit could not be recorded).
--
-- Kept as a function rather than a one-off DO block because a later migration
-- that adds a table has to call it again — Supabase's postgres role cannot
-- create the event trigger that would do this automatically.
create or replace function hq_attach_readonly_guards()
returns integer
language plpgsql
as $$
declare
  t record;
  n integer := 0;
begin
  for t in
    select tablename from pg_tables
     where schemaname = 'public'
       and tablename not in ('hq_view_sessions', 'audit_log')
  loop
    execute format(
      'drop trigger if exists zz_hq_readonly on public.%I', t.tablename);
    execute format(
      'create trigger zz_hq_readonly before insert or update or delete on public.%I
         for each statement execute function hq_readonly_guard()', t.tablename);
    n := n + 1;
  end loop;
  return n;
end;
$$;
comment on function hq_attach_readonly_guards() is
  'Call at the end of any migration that adds a public table, so view-as stays read-only everywhere.';

select hq_attach_readonly_guards();

-- ---------------------------------------------------------------------------
-- Starting and ending a visit. Both are recorded.
-- ---------------------------------------------------------------------------
create or replace function begin_view_as(p_territory uuid, p_reason text default null)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id bigint;
  v_name text;
begin
  -- Deliberately checks the profile directly: is_franchisor() is false while a
  -- session is open, which would make this un-callable twice in a row.
  if not exists (select 1 from profiles where id = auth.uid() and role::text = 'franchisor') then
    raise exception 'Only the franchisor can view a city as its operator'
      using errcode = 'insufficient_privilege';
  end if;
  select name into v_name from territories where id = p_territory;
  if v_name is null then
    raise exception 'No such territory' using errcode = 'no_data_found';
  end if;

  update hq_view_sessions set ended_at = now()
   where franchisor_id = auth.uid() and ended_at is null;

  insert into hq_view_sessions (franchisor_id, territory_id, reason)
  values (auth.uid(), p_territory, nullif(btrim(p_reason), ''))
  returning id into v_id;

  perform log_action('hq.view_as_started', 'territory', p_territory::text, p_territory,
                     jsonb_build_object('territory', v_name, 'reason', p_reason));
  return v_id;
end;
$$;
revoke all on function begin_view_as(uuid, text) from public;
grant execute on function begin_view_as(uuid, text) to authenticated;

create or replace function end_view_as()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare v_territory uuid;
begin
  select territory_id into v_territory from hq_view_sessions
   where franchisor_id = auth.uid() and ended_at is null;
  if v_territory is null then
    return;
  end if;
  update hq_view_sessions set ended_at = now()
   where franchisor_id = auth.uid() and ended_at is null;
  perform log_action('hq.view_as_ended', 'territory', v_territory::text, v_territory, null);
end;
$$;
revoke all on function end_view_as() from public;
grant execute on function end_view_as() to authenticated;

grant select on hq_view_sessions to authenticated;
grant all on hq_view_sessions to service_role;
alter table hq_view_sessions enable row level security;

-- Readable by the person doing it, and by anyone who is genuinely the
-- franchisor — read directly from the profile, since is_franchisor() is false
-- mid-session by design.
create policy hq_view_sessions_read on hq_view_sessions
  for select using (
    franchisor_id = auth.uid()
    or exists (select 1 from profiles where id = auth.uid() and role::text = 'franchisor'));
