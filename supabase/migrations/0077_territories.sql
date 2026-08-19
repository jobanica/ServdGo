-- ServdGo — territories: a city operator's own settings, people and boundary.
--
-- Easy Buy assumed one operator running one service area, and that assumption
-- sits in app_settings: a single row holding the service centre, the radius, the
-- commission rate, the fee table and the payout details. Two cities cannot both
-- be right in one row.
--
-- This migration makes the territory the thing that owns all of it, seeds the
-- first territory from the settings row that exists, and leaves app_settings
-- holding only what is genuinely platform-wide. Nothing is dropped here — the
-- old columns keep working until 0081 turns app_settings into a per-territory
-- view, so this migration is safe to apply on its own.

create type territory_status as enum (
  'draft',      -- created by the franchisor, cannot trade yet
  'active',     -- open for business
  'suspended'   -- stopped taking new orders; history intact
);

create table territories (
  id                   uuid primary key default gen_random_uuid(),
  name                 text not null,
  slug                 text not null unique,
  status               territory_status not null default 'draft',

  -- The operator who runs this city. Null while the franchisor is recruiting.
  operator_profile_id  uuid references profiles (id) on delete set null,

  -- Boundary. The centre and radius that used to live in app_settings; a
  -- delivery belongs to the territory its pickup falls inside (decision 4).
  service_center_lat   double precision,
  service_center_lng   double precision,
  service_radius_km    numeric(6, 2) not null default 0,

  -- Trading hours and the switch.
  is_open              boolean not null default true,
  closed_message       text,
  schedule             jsonb,
  settlement_cutoff    time not null default '00:00',

  -- What the operator charges. commission_rate is held to the platform band by
  -- territory_commission_within_band() below.
  commission_rate      numeric(5, 4) not null default 0.15,
  markup_operator_share numeric(4, 3) not null default 1.000,
  default_delivery_fee numeric(10, 2) not null default 50,
  per_store_fee        numeric(10, 2) not null default 25,
  delivery_fee_model   delivery_fee_model not null default 'flat',
  delivery_base_fare   numeric(10, 2) not null default 50,
  delivery_base_km     numeric(6, 2) not null default 2,
  delivery_per_km      numeric(10, 2) not null default 10,
  convenience_fee      numeric(10, 2) not null default 0,
  convenience_fee_mode convenience_fee_mode not null default 'pass_through',
  convenience_fee_food   numeric(10, 2) not null default 0,
  convenience_fee_pabili numeric(10, 2) not null default 0,
  convenience_fee_padala numeric(10, 2) not null default 0,

  -- Which services this city runs.
  service_food         boolean not null default true,
  service_pabili       boolean not null default true,
  service_padala       boolean not null default true,
  max_active_orders_per_rider integer not null default 0,
  sms_notify_stores    boolean not null default false,

  -- Where this city's riders send their commission. Getting this wrong means a
  -- rider paying the wrong operator, so it is per-territory and never global.
  settlement_gcash_number text,
  settlement_gcash_name   text,
  settlement_qr_url       text,

  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),

  constraint territories_radius_positive check (service_radius_km >= 0),
  constraint territories_markup_share_range check (markup_operator_share between 0 and 1)
);

create index territories_status_idx on territories (status);
create index territories_operator_idx on territories (operator_profile_id);

comment on table territories is
  'One city operator: their boundary, their fees, their payout details. Replaces the single app_settings row.';
comment on column territories.status is
  'Only the franchisor moves this. A territory cannot trade until it is active (decision 5).';

-- ---------------------------------------------------------------------------
-- The franchisor: a role above operator.
--
-- Compared as text rather than as an enum literal so this migration does not
-- depend on the new value being visible in its own transaction.
-- ---------------------------------------------------------------------------
alter type user_role add value if not exists 'franchisor';

-- Which city a member of staff or a rider belongs to. Null for the franchisor,
-- who is not in any one city, and for customers, who are not staff of one.
alter table profiles add column if not exists territory_id uuid references territories (id) on delete restrict;
create index if not exists profiles_territory_idx on profiles (territory_id);

comment on column profiles.territory_id is
  'The city this person operates in. Null for the franchisor and for customers.';

create or replace function is_franchisor()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from profiles where id = auth.uid() and role::text = 'franchisor'
  );
$$;
revoke all on function is_franchisor() from public;
grant execute on function is_franchisor() to anon, authenticated;

-- The caller's own city, or null if they are not bound to one.
create or replace function current_territory_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select territory_id from profiles where id = auth.uid();
$$;
revoke all on function current_territory_id() from public;
grant execute on function current_territory_id() to anon, authenticated;

-- The city whose settings apply to this request. Staff and riders carry their
-- own; everyone else falls back to the only active city, which is the honest
-- answer while there is exactly one and null once there are more.
create or replace function effective_territory_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select territory_id from profiles where id = auth.uid()),
    (select t.id from territories t
      where t.status = 'active'
        and (select count(*) from territories where status = 'active') = 1)
  );
$$;
revoke all on function effective_territory_id() from public;
grant execute on function effective_territory_id() to anon, authenticated;

-- Can the caller see a row belonging to this territory? Franchisor sees every
-- city; staff see their own; a null territory is platform-wide and visible to
-- any staff. Customer and rider access stays governed by the ownership
-- predicates already on each table.
create or replace function staff_sees(p_territory uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select is_franchisor()
      or (is_staff() and (p_territory is null or p_territory = current_territory_id()));
$$;
revoke all on function staff_sees(uuid) from public;
grant execute on function staff_sees(uuid) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- app_settings keeps only what is platform-wide, and gains the commission band.
--
-- Your royalty is a share of whatever an operator charges, so an operator who
-- undercuts to poach riders from the next city cuts your income with them
-- (decision 3). The band is set centrally; operators move freely inside it.
-- ---------------------------------------------------------------------------
alter table app_settings
  add column if not exists commission_rate_min numeric(5, 4) not null default 0.10,
  add column if not exists commission_rate_max numeric(5, 4) not null default 0.25,
  add constraint app_settings_commission_band check (commission_rate_min <= commission_rate_max);

comment on column app_settings.commission_rate_min is
  'Floor for every territory commission rate. Franchisor-set; operators cannot go below it.';

create or replace function territory_commission_within_band()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_min numeric(5, 4);
  v_max numeric(5, 4);
begin
  select commission_rate_min, commission_rate_max into v_min, v_max
    from app_settings where id = true;

  if new.commission_rate < v_min or new.commission_rate > v_max then
    raise exception
      'Commission rate % is outside the platform band of % to %',
      new.commission_rate, v_min, v_max
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger trg_territory_commission_band
  before insert or update of commission_rate on territories
  for each row execute function territory_commission_within_band();

-- ---------------------------------------------------------------------------
-- Seed the first territory from the settings that exist, so a single-city
-- database keeps its exact configuration rather than reverting to defaults.
-- ---------------------------------------------------------------------------
insert into territories (
  name, slug, status,
  service_center_lat, service_center_lng, service_radius_km,
  is_open, closed_message, schedule, settlement_cutoff,
  commission_rate, markup_operator_share,
  default_delivery_fee, per_store_fee, delivery_fee_model,
  delivery_base_fare, delivery_base_km, delivery_per_km,
  convenience_fee, convenience_fee_mode,
  convenience_fee_food, convenience_fee_pabili, convenience_fee_padala,
  service_food, service_pabili, service_padala,
  max_active_orders_per_rider, sms_notify_stores,
  settlement_gcash_number, settlement_gcash_name, settlement_qr_url
)
select
  'First city', 'first-city', 'active',
  s.service_center_lat, s.service_center_lng, s.service_radius_km,
  s.is_open, s.closed_message, s.schedule, s.settlement_cutoff,
  s.commission_rate, s.markup_operator_share,
  s.default_delivery_fee, s.per_store_fee, s.delivery_fee_model,
  s.delivery_base_fare, s.delivery_base_km, s.delivery_per_km,
  s.convenience_fee, s.convenience_fee_mode,
  s.convenience_fee_food, s.convenience_fee_pabili, s.convenience_fee_padala,
  s.service_food, s.service_pabili, s.service_padala,
  s.max_active_orders_per_rider, s.sms_notify_stores,
  s.settlement_gcash_number, s.settlement_gcash_name, s.settlement_qr_url
from app_settings s
where s.id = true
  and not exists (select 1 from territories);

-- ---------------------------------------------------------------------------
-- Access. Everyone may read the active cities — the customer app needs the
-- boundary before anyone signs in. Only the franchisor creates one or changes
-- its status; the operator edits their own city's fees.
-- ---------------------------------------------------------------------------
grant select on territories to anon, authenticated;
grant all on territories to service_role;
grant insert, update, delete on territories to authenticated;
alter table territories enable row level security;

create policy territories_public_read on territories
  for select using (status = 'active' or staff_sees(id) or is_franchisor());

create policy territories_franchisor_write on territories
  for all using (is_franchisor()) with check (is_franchisor());

-- The operator may edit their own city, but never its status or its boundary —
-- opening, suspending and drawing the map stay with the franchisor.
create policy territories_operator_update on territories
  for update
  using (is_admin() and id = current_territory_id())
  with check (is_admin() and id = current_territory_id());

-- Deliberately NOT security definer: the guard compares current_user against
-- service_role, and a definer function would report its owner instead. Same
-- reasoning as the profile role guard in 0012.
create or replace function territory_operator_guard()
returns trigger
language plpgsql
as $$
begin
  -- service_role is server-side provisioning, the same exemption the profile
  -- role guard in 0012 makes.
  if is_franchisor() or current_user = 'service_role' then
    return new;
  end if;
  if new.status is distinct from old.status then
    raise exception 'Only the franchisor can open or suspend a territory'
      using errcode = 'insufficient_privilege';
  end if;
  if new.service_center_lat is distinct from old.service_center_lat
     or new.service_center_lng is distinct from old.service_center_lng
     or new.service_radius_km is distinct from old.service_radius_km then
    raise exception 'Only the franchisor can change a territory boundary'
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end;
$$;

create trigger trg_territory_operator_guard
  before update on territories
  for each row execute function territory_operator_guard();

create or replace function touch_territory_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end;
$$;
create trigger trg_territory_touch
  before update on territories
  for each row execute function touch_territory_updated_at();
