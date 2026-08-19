-- ServdGo — the settings HQ owns: platform defaults, feature flags, and the
-- notices that appear in the partner panels.
--
-- They all answer the same question from different angles: what is
-- true everywhere unless a city says otherwise.
--
--   platform_settings one row, platform-wide facts (app versions, support desk)
--   feature_flags     a default per feature, overridable per city
--   announcements     a message HQ wants a particular audience to see

-- ---------------------------------------------------------------------------
-- 1. Platform-wide facts live on platform_settings, which is already the
--    singleton HQ owns (0081). No second settings table.
-- ---------------------------------------------------------------------------
alter table platform_settings
  add column if not exists min_rider_app_version    text not null default '1.0.0',
  add column if not exists min_customer_app_version text not null default '1.0.0',
  add column if not exists support_email            text,
  add column if not exists support_mobile           text,
  add column if not exists maintenance_message      text;

comment on column platform_settings.min_rider_app_version is
  'Riders on an older build are told to update before they can go online.';

/**
 * What an unauthenticated client is allowed to know about the platform.
 *
 * The rider app has to ask whether it is too old to run before anybody signs
 * in, so this is deliberately reachable by anon — and deliberately returns only
 * these five fields rather than the settings row.
 */
create or replace function public_config()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'min_rider_app_version',    min_rider_app_version,
    'min_customer_app_version', min_customer_app_version,
    'support_email',            support_email,
    'support_mobile',           support_mobile,
    'maintenance_message',      maintenance_message)
  from platform_settings where id;
$$;
revoke all on function public_config() from public;
grant execute on function public_config() to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. Feature flags — a platform default, and a per-city override.
-- ---------------------------------------------------------------------------
create table feature_flags (
  key             text primary key check (key ~ '^[a-z][a-z0-9_]{2,63}$'),
  description     text not null,
  default_enabled boolean not null default false,
  updated_at      timestamptz not null default now()
);
comment on table feature_flags is
  'One row per switchable feature. The default applies to every city that has no override.';

create table feature_flag_overrides (
  flag_key     text not null references feature_flags (key) on delete cascade,
  territory_id uuid not null references territories (id) on delete cascade,
  enabled      boolean not null,
  note         text,
  updated_at   timestamptz not null default now(),
  updated_by   uuid references profiles (id),
  primary key (flag_key, territory_id)
);
create index feature_flag_overrides_territory on feature_flag_overrides (territory_id);

/**
 * Whether a feature is on for a city. An override wins; otherwise the default;
 * an unknown flag is off, so a typo turns a feature off rather than on.
 */
create or replace function feature_enabled(p_key text, p_territory uuid default null)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select o.enabled from feature_flag_overrides o
      where o.flag_key = p_key
        and o.territory_id = coalesce(p_territory, current_territory_id())),
    (select f.default_enabled from feature_flags f where f.key = p_key),
    false);
$$;
revoke all on function feature_enabled(text, uuid) from public;
grant execute on function feature_enabled(text, uuid) to anon, authenticated, service_role;

alter table feature_flags enable row level security;
alter table feature_flag_overrides enable row level security;

-- Every signed-in client may read the flags — that is the point of them.
create policy feature_flags_read on feature_flags for select to authenticated using (true);
create policy feature_flags_write on feature_flags
  for all using (is_franchisor()) with check (is_franchisor());

create policy feature_flag_overrides_read on feature_flag_overrides
  for select using (staff_sees(territory_id));
create policy feature_flag_overrides_write on feature_flag_overrides
  for all using (is_franchisor()) with check (is_franchisor());

grant select on feature_flags, feature_flag_overrides to authenticated;
grant all on feature_flags, feature_flag_overrides to service_role;

insert into feature_flags (key, description, default_enabled) values
  ('merchant_api',     'Restaurants and shops may book deliveries over the API', true),
  ('pabili',           'Pabili (buy-for-me) orders', true),
  ('padala',           'Padala (point-to-point) orders', true),
  ('rider_chat',       'In-order chat between rider and customer', true),
  ('scheduled_orders', 'Orders booked for a later time', false)
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- 3. Announcements — HQ has something to say, to somebody in particular.
-- ---------------------------------------------------------------------------
create type announcement_audience as enum
  ('operators', 'riders', 'merchants', 'customers', 'everyone');

create table announcements (
  id           bigint generated always as identity primary key,
  title        text not null check (btrim(title) <> ''),
  body         text not null check (btrim(body) <> ''),
  audience     announcement_audience not null default 'operators',
  -- Null means every city. A city means only that city sees it.
  territory_id uuid references territories (id) on delete cascade,
  severity     text not null default 'info' check (severity in ('info', 'warning', 'critical')),
  starts_at    timestamptz not null default now(),
  ends_at      timestamptz,
  created_by   uuid references profiles (id),
  created_at   timestamptz not null default now(),
  check (ends_at is null or ends_at > starts_at)
);
create index announcements_live on announcements (starts_at desc);
comment on table announcements is
  'A notice from HQ. Null territory means every city; the audience decides which app shows it.';

create table announcement_reads (
  announcement_id bigint not null references announcements (id) on delete cascade,
  profile_id      uuid not null references profiles (id) on delete cascade,
  read_at         timestamptz not null default now(),
  primary key (announcement_id, profile_id)
);

/** The audiences a profile belongs to. A rider who is also staff is both. */
create or replace function audiences_for(p_profile uuid)
returns announcement_audience[]
language sql
stable
security definer
set search_path = public
as $$
  select array_remove(array[
    'everyone'::announcement_audience,
    case when exists (select 1 from profiles
                       where id = p_profile
                         and role::text in ('admin','manager','dispatcher','support'))
         then 'operators'::announcement_audience end,
    case when exists (select 1 from profiles where id = p_profile and role::text = 'rider')
         then 'riders'::announcement_audience end,
    case when exists (select 1 from profiles where id = p_profile and role::text = 'customer')
         then 'customers'::announcement_audience end
  ], null);
$$;

/** Live announcements the caller has not dismissed yet. */
create or replace function unread_announcements()
returns setof announcements
language sql
stable
security definer
set search_path = public
as $$
  select a.* from announcements a
   where a.starts_at <= now()
     and (a.ends_at is null or a.ends_at > now())
     and a.audience = any (audiences_for(auth.uid()))
     and (a.territory_id is null or a.territory_id = current_territory_id())
     and not exists (select 1 from announcement_reads r
                      where r.announcement_id = a.id and r.profile_id = auth.uid())
   order by a.starts_at desc;
$$;
revoke all on function unread_announcements() from public;
grant execute on function unread_announcements() to authenticated;

create or replace function mark_announcement_read(p_id bigint)
returns void
language sql
security definer
set search_path = public
as $$
  insert into announcement_reads (announcement_id, profile_id)
  select p_id, auth.uid()
   where p_id is not null and auth.uid() is not null
  on conflict do nothing;
$$;
revoke all on function mark_announcement_read(bigint) from public;
grant execute on function mark_announcement_read(bigint) to authenticated;

create or replace function publish_announcement(
  p_title text, p_body text,
  p_audience announcement_audience default 'operators',
  p_territory uuid default null,
  p_severity text default 'info',
  p_ends_at timestamptz default null
)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare v_id bigint;
begin
  if not is_franchisor() then
    raise exception 'Only the franchisor publishes announcements'
      using errcode = 'insufficient_privilege';
  end if;
  insert into announcements (title, body, audience, territory_id, severity, ends_at, created_by)
  values (btrim(p_title), btrim(p_body), p_audience, p_territory, p_severity, p_ends_at, auth.uid())
  returning id into v_id;
  perform log_action('hq.announcement_published', 'announcement', v_id::text, p_territory,
                     jsonb_build_object('title', p_title, 'audience', p_audience));
  return v_id;
end;
$$;
revoke all on function publish_announcement(text, text, announcement_audience, uuid, text, timestamptz) from public;
grant execute on function publish_announcement(text, text, announcement_audience, uuid, text, timestamptz) to authenticated;

alter table announcements enable row level security;
alter table announcement_reads enable row level security;

-- You may read a notice addressed to you, and HQ may read all of them.
create policy announcements_read on announcements
  for select to authenticated using (
    is_franchisor()
    or (audience = any (audiences_for(auth.uid()))
        and (territory_id is null or territory_id = current_territory_id())));
create policy announcements_write on announcements
  for all using (is_franchisor()) with check (is_franchisor());

create policy announcement_reads_own on announcement_reads
  for all to authenticated using (profile_id = auth.uid()) with check (profile_id = auth.uid());

grant select on announcements to authenticated;
grant select, insert on announcement_reads to authenticated;
grant all on announcements, announcement_reads to service_role;

-- New tables, so the view-as guard has to be put on them.
select hq_attach_readonly_guards();
