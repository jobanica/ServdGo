-- ServdGo — an order lands in the city it was picked up in (decision 4).
--
-- A pickup in one territory and a drop-off in another would otherwise leave two
-- operators with a claim on the same order. The pickup decides, and a drop-off
-- outside that territory's radius is refused rather than quietly served.
--
-- Trigger order matters here. Postgres fires BEFORE triggers on a table in name
-- order, so orders_assign_territory must sort ahead of orders_enforce_service_area
-- ('a' before 'e') — the radius check reads the territory this trigger sets.

-- Which active territory contains a point? Nearest centre wins where radii
-- overlap, so an overlap is resolved rather than ambiguous.
create or replace function territory_for_point(p_lat double precision, p_lng double precision)
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select t.id
  from territories t
  where t.status = 'active'
    and t.service_center_lat is not null
    and t.service_center_lng is not null
    and t.service_radius_km > 0
    and p_lat is not null and p_lng is not null
    and km_between(t.service_center_lat, t.service_center_lng, p_lat, p_lng) <= t.service_radius_km
  order by km_between(t.service_center_lat, t.service_center_lng, p_lat, p_lng)
  limit 1;
$$;
revoke all on function territory_for_point(double precision, double precision) from public;
grant execute on function territory_for_point(double precision, double precision) to anon, authenticated;

comment on function territory_for_point(double precision, double precision) is
  'The active territory a coordinate falls inside. Nearest centre wins when radii overlap.';

-- ---------------------------------------------------------------------------
-- Assign the territory as the order is written.
--
-- Padala and Pabili carry a pickup pin, so that pin decides. A Food order has no
-- pickup yet — its stores are linked immediately after the insert — so it is
-- routed by the drop-off, and order_stores_match_territory() below then refuses
-- any store that turns out to sit in another city.
-- ---------------------------------------------------------------------------
create or replace function assign_order_territory()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_territory uuid;
begin
  if new.territory_id is not null then
    return new;
  end if;

  if new.pickup_lat is not null and new.pickup_lng is not null then
    v_territory := territory_for_point(new.pickup_lat, new.pickup_lng);
  end if;

  -- No pickup pin (Food, or a Pabili where the customer named no shop): the
  -- drop-off stands in for it, and is checked against that territory's radius.
  if v_territory is null then
    v_territory := territory_for_point(
      coalesce(new.delivery_lat, new.dropoff_lat),
      coalesce(new.delivery_lng, new.dropoff_lng));
  end if;

  -- Single-city databases where no boundary has been drawn yet: everything
  -- belongs to the one active territory rather than to nothing.
  if v_territory is null then
    select t.id into v_territory
    from territories t
    where t.status = 'active'
      and (select count(*) from territories where status = 'active') = 1;
  end if;

  new.territory_id := v_territory;
  return new;
end;
$$;

drop trigger if exists orders_assign_territory on orders;
create trigger orders_assign_territory
  before insert on orders
  for each row execute function assign_order_territory();

-- ---------------------------------------------------------------------------
-- A Food order's stores must all sit in the order's own city.
-- ---------------------------------------------------------------------------
create or replace function order_stores_match_territory()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order_territory uuid;
  v_store_territory uuid;
  v_store_name      text;
begin
  select territory_id into v_order_territory from orders where id = new.order_id;
  select territory_id, name into v_store_territory, v_store_name from stores where id = new.store_id;

  if v_store_territory is null then
    return new;   -- store not yet assigned to a city; nothing to contradict
  end if;

  if v_order_territory is null then
    update orders set territory_id = v_store_territory where id = new.order_id;
    return new;
  end if;

  if v_store_territory <> v_order_territory then
    raise exception '% is in another delivery area, so it cannot be added to this order.', v_store_name
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

drop trigger if exists order_stores_territory on order_stores;
create trigger order_stores_territory
  after insert on order_stores
  for each row execute function order_stores_match_territory();

-- ---------------------------------------------------------------------------
-- The radius and the serviceable-barangay list are now the territory's, not the
-- platform's. Same guard as before, read one level down.
-- ---------------------------------------------------------------------------
create or replace function enforce_service_area()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_any     int;
  v_lat     double precision;
  v_lng     double precision;
  v_radius  numeric;
  v_km      double precision;
begin
  if is_staff() then
    return new;
  end if;

  -- A drop-off that lands in no active territory at all is out of area, whatever
  -- the barangay list says.
  if new.territory_id is null
     and exists (select 1 from territories where status = 'active' and service_radius_km > 0) then
    raise exception 'Sorry, that location is outside every area we deliver to.'
      using errcode = 'check_violation';
  end if;

  select count(*) into v_any
    from service_areas
   where is_active
     and (territory_id is null or territory_id = new.territory_id);

  if v_any > 0 then
    if new.area_barangay is null or btrim(new.area_barangay) = '' then
      raise exception 'Please choose your delivery area before ordering.'
        using errcode = 'check_violation';
    end if;
    if not exists (
      select 1 from service_areas
      where is_active
        and (territory_id is null or territory_id = new.territory_id)
        and lower(btrim(province)) = lower(btrim(coalesce(new.area_province, '')))
        and lower(btrim(city))     = lower(btrim(coalesce(new.area_city, '')))
        and lower(btrim(barangay)) = lower(btrim(new.area_barangay))
    ) then
      raise exception 'Sorry, we do not deliver to % yet.', new.area_barangay
        using errcode = 'check_violation';
    end if;
  end if;

  select service_center_lat, service_center_lng, service_radius_km
    into v_lat, v_lng, v_radius
  from territories where id = new.territory_id;

  if v_lat is not null and v_lng is not null and coalesce(v_radius, 0) > 0
     and new.delivery_lat is not null and new.delivery_lng is not null then
    v_km := km_between(v_lat, v_lng, new.delivery_lat, new.delivery_lng);
    if v_km > v_radius then
      raise exception 'That drop-off is about % km away, outside our % km delivery area. Please pin a location we serve.',
        round(v_km::numeric, 1), v_radius using errcode = 'check_violation';
    end if;
  end if;

  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- Money rows inherit the city of what they are about.
--
-- The ledger and settlement inserts live inside the existing settlement
-- functions. Filling the column with a trigger catches every path into those
-- tables — including ones written later — instead of editing money code that
-- already works.
-- ---------------------------------------------------------------------------
create or replace function fill_ledger_territory()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.territory_id is null then
    select o.territory_id into new.territory_id from orders o where o.id = new.order_id;
  end if;
  if new.territory_id is null then
    select r.territory_id into new.territory_id from riders r where r.id = new.rider_id;
  end if;
  return new;
end;
$$;

drop trigger if exists commission_ledger_territory on commission_ledger;
create trigger commission_ledger_territory
  before insert on commission_ledger
  for each row execute function fill_ledger_territory();

create or replace function fill_settlement_territory()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.territory_id is null then
    select r.territory_id into new.territory_id from riders r where r.id = new.rider_id;
  end if;
  return new;
end;
$$;

drop trigger if exists settlements_territory on settlements;
create trigger settlements_territory
  before insert on settlements
  for each row execute function fill_settlement_territory();

-- A rider or a store joins the city of the staff member who created them, or
-- the only active one.
create or replace function fill_territory_from_session()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.territory_id is null then
    new.territory_id := effective_territory_id();
  end if;
  return new;
end;
$$;

drop trigger if exists riders_territory on riders;
create trigger riders_territory
  before insert on riders
  for each row execute function fill_territory_from_session();

drop trigger if exists stores_territory on stores;
create trigger stores_territory
  before insert on stores
  for each row execute function fill_territory_from_session();
