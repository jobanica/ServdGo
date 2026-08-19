-- Serviceable areas: Province → City/Municipality → Barangay.
-- The operator lists the barangays they deliver to and ticks which are active;
-- customers pick their area at checkout and can only order if it is served.

create table if not exists service_areas (
  id         uuid primary key default gen_random_uuid(),
  province   text not null,
  city       text not null,          -- city / municipality
  barangay   text not null,
  is_active  boolean not null default true,
  created_at timestamptz not null default now(),
  unique (province, city, barangay)
);
create index if not exists service_areas_lookup_idx on service_areas (province, city, barangay);

grant all on service_areas to authenticated, service_role;
grant select on service_areas to anon;
alter table service_areas enable row level security;

-- Anyone may read the active areas (the customer app needs them before sign-in);
-- staff manage the list.
drop policy if exists service_areas_public_read on service_areas;
create policy service_areas_public_read on service_areas
  for select using (is_active or is_staff());

drop policy if exists service_areas_staff_write on service_areas;
create policy service_areas_staff_write on service_areas
  for all using (is_staff()) with check (is_staff());

-- Record the chosen area on the order so riders/admin see it and reports can
-- group by barangay.
alter table orders
  add column if not exists area_province text,
  add column if not exists area_city     text,
  add column if not exists area_barangay text;

-- Remember the customer's area on their saved addresses too.
alter table customer_addresses
  add column if not exists province text,
  add column if not exists city     text,
  add column if not exists barangay text;

-- Is a given barangay currently served? Used by the customer app before
-- letting an order through.
create or replace function is_area_serviceable(p_province text, p_city text, p_barangay text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from service_areas
    where is_active
      and lower(btrim(province)) = lower(btrim(p_province))
      and lower(btrim(city))     = lower(btrim(p_city))
      and lower(btrim(barangay)) = lower(btrim(p_barangay))
  );
$$;
revoke all on function is_area_serviceable(text, text, text) from public;
grant execute on function is_area_serviceable(text, text, text) to anon, authenticated;
