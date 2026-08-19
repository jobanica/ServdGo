-- The rider fixes a wrong drop-off pin, and the fee follows the real distance.
--
-- A customer pins the wrong place — the map opens on somebody else's barangay,
-- or they tap before it finishes loading. The rider is the one who finds out,
-- standing in the wrong street with a bag of food. Until now there was nothing
-- they could do: the customer's own correction (0059) only works before the
-- goods are collected, which is exactly when nobody has noticed yet.
--
-- The fee has to move with the pin. Under per-km pricing the delivery fee IS
-- the distance from the store to the door; if the door turns out to be three
-- kilometres further, the rider is riding those kilometres for free. That is
-- the whole point of this change, and it is why the recalculation happens in
-- the database rather than in the rider's app: the number a rider collects is
-- not a number a rider gets to type.

-- ---------------------------------------------------------------------------
-- Where a delivery is measured from
-- ---------------------------------------------------------------------------

/**
 * The pins the delivery fee is measured from, one row each.
 *
 * Food starts at the restaurants' own pins, Pabili and Padala at the pickup
 * pin the customer dropped. Mirrors `resolveDeliveryFee` in @ebd/shared — the
 * farthest leg wins, because a rider visiting several stores covers at least
 * that distance, and extra stops are billed through the store fee.
 *
 * Pabili's "where to buy" pin is stored on the order as pickup_lat/lng; the
 * per-store pins in buy_stores are usually empty and only get filled in when a
 * rider fixes one on the ground. Preferring the pickup pin reproduces the fee
 * the customer was originally quoted, and stops a rider from repricing an
 * order by moving a store pin rather than the drop-off.
 */
create or replace function order_origin_pins(p_order_id uuid)
returns table (lat double precision, lng double precision)
language sql
stable
security definer
set search_path = public
as $$
  select s.lat, s.lng
    from orders o
    join order_stores os on os.order_id = o.id
    join stores s on s.id = os.store_id
   where o.id = p_order_id and o.service_type = 'food'
     and s.lat is not null and s.lng is not null
  union all
  select o.pickup_lat, o.pickup_lng
    from orders o
   where o.id = p_order_id and o.service_type in ('pabili', 'padala')
     and o.pickup_lat is not null and o.pickup_lng is not null
  union all
  -- Only when the customer never pinned a shop at all.
  select (e ->> 'lat')::double precision, (e ->> 'lng')::double precision
    from orders o, jsonb_array_elements(coalesce(o.buy_stores, '[]'::jsonb)) e
   where o.id = p_order_id and o.service_type = 'pabili'
     and o.pickup_lat is null
     and e ->> 'lat' is not null and e ->> 'lng' is not null;
$$;

/**
 * What this order's delivery fee would be with the drop-off at (lat, lng).
 *
 * The SQL twin of `resolveDeliveryFee`: flat pricing ignores the geography,
 * per-km charges baseFare plus perKm for every kilometre past baseKm, and an
 * order with no origin pin at all falls back to the flat fee rather than
 * quoting zero.
 */
create or replace function quote_delivery_fee(
  p_order_id uuid,
  p_lat double precision,
  p_lng double precision
) returns numeric
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  s       app_settings%rowtype;
  v_km    double precision;
begin
  select * into s from app_settings limit 1;
  if s.delivery_fee_model is distinct from 'per_km' then
    return round(coalesce(s.default_delivery_fee, 50)::numeric, 2);
  end if;

  select max(km_between(o.lat, o.lng, p_lat, p_lng))
    into v_km
    from order_origin_pins(p_order_id) o;

  if v_km is null then
    return round(coalesce(s.default_delivery_fee, 50)::numeric, 2);
  end if;

  return round((coalesce(s.delivery_base_fare, 50)
    + coalesce(s.delivery_per_km, 10) * greatest(0, v_km - coalesce(s.delivery_base_km, 2)))::numeric, 2);
end;
$$;

-- ---------------------------------------------------------------------------
-- The audit trail
-- ---------------------------------------------------------------------------

-- Moving a pin moves money, so every correction is written down: who, from
-- where to where, and what it did to the fee. A rider who nudges pins outward
-- to pad their earnings shows up here as a pattern, which is the only way
-- anyone would ever catch it.
create table if not exists order_pin_corrections (
  id           uuid primary key default gen_random_uuid(),
  order_id     uuid not null references orders (id) on delete cascade,
  rider_id     uuid references riders (id) on delete set null,
  from_lat     double precision,
  from_lng     double precision,
  to_lat       double precision not null,
  to_lng       double precision not null,
  moved_m      double precision,
  old_fee      numeric(10, 2),
  new_fee      numeric(10, 2),
  created_at   timestamptz not null default now()
);
create index if not exists order_pin_corrections_order_idx on order_pin_corrections (order_id);
create index if not exists order_pin_corrections_rider_idx on order_pin_corrections (rider_id, created_at desc);

alter table order_pin_corrections enable row level security;

drop policy if exists order_pin_corrections_read on order_pin_corrections;
create policy order_pin_corrections_read on order_pin_corrections
  for select using (rider_id = current_rider_id() or is_admin());

-- ---------------------------------------------------------------------------
-- The correction itself
-- ---------------------------------------------------------------------------
create or replace function rider_correct_delivery_pin(
  p_order_id uuid,
  p_lat double precision,
  p_lng double precision,
  p_address text default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rider   uuid := current_rider_id();
  o         orders%rowtype;
  v_moved   double precision;
  v_new_fee numeric;
  v_lat     double precision;
  v_lng     double precision;
  v_radius  numeric;
  v_km      double precision;
  v_msg     text;
begin
  if v_rider is null then raise exception 'not a rider'; end if;
  if p_lat is null or p_lng is null then raise exception 'A location is required.'; end if;

  select * into o from orders
   where id = p_order_id and rider_id = v_rider;
  if not found then
    raise exception 'You can only change a delivery you are handling.';
  end if;
  if o.status in ('delivered', 'cancelled') then
    raise exception 'This delivery is finished, so the pin can no longer be changed.'
      using errcode = 'check_violation';
  end if;

  -- The correction is bounded by where we actually deliver, not by how far the
  -- customer's mistake was. Capping the *move* would block the one case that
  -- needs this most — a pin dropped in the wrong province entirely.
  select service_center_lat, service_center_lng, service_radius_km
    into v_lat, v_lng, v_radius
    from app_settings limit 1;
  if v_lat is not null and v_lng is not null and coalesce(v_radius, 0) > 0 then
    v_km := km_between(v_lat, v_lng, p_lat, p_lng);
    if v_km > v_radius then
      return jsonb_build_object('updated', false, 'reason', 'outside_area',
        'message', format('That spot is about %s km out, past our %s km delivery area. Call the customer and check where they actually are.',
                          round(v_km::numeric, 1), v_radius));
    end if;
  end if;

  if o.delivery_lat is not null and o.delivery_lng is not null then
    v_moved := pin_distance_m(o.delivery_lat, o.delivery_lng, p_lat, p_lng);
    -- A few metres is GPS drift, not a correction worth telling anyone about.
    if v_moved < 20 and p_address is null then
      return jsonb_build_object('updated', false, 'reason', 'unchanged',
        'message', 'That is the same spot the pin is already on.');
    end if;
  end if;

  v_new_fee := quote_delivery_fee(p_order_id, p_lat, p_lng);

  update orders
     set delivery_lat = p_lat,
         delivery_lng = p_lng,
         -- Padala carries the drop-off twice; keep the copy honest.
         dropoff_lat  = case when dropoff_lat is not null then p_lat else dropoff_lat end,
         dropoff_lng  = case when dropoff_lng is not null then p_lng else dropoff_lng end,
         delivery_address = coalesce(nullif(btrim(p_address), ''), delivery_address),
         delivery_fee = v_new_fee
   where id = p_order_id;

  -- The operator's cut is a share of the delivery fee, so it moves too.
  perform recalc_order_commission(p_order_id);

  insert into order_pin_corrections
    (order_id, rider_id, from_lat, from_lng, to_lat, to_lng, moved_m, old_fee, new_fee)
  values
    (p_order_id, v_rider, o.delivery_lat, o.delivery_lng, p_lat, p_lng, v_moved, o.delivery_fee, v_new_fee);

  -- Told in the thread the customer is already watching. A delivery fee that
  -- changes without a word is how a rider gets argued with at the door.
  v_msg := '📍 I''ve moved the drop-off pin to where you actually are';
  if v_moved is not null and v_moved >= 1000 then
    v_msg := v_msg || format(' — the old pin was %s km off', to_char(v_moved / 1000, 'FM990D0'));
  end if;
  v_msg := v_msg || '.';
  if v_new_fee <> o.delivery_fee then
    v_msg := v_msg || format(' The delivery fee is worked out by distance, so it changes from %s to %s.',
                             to_char(o.delivery_fee, 'FM₱999G999D00'),
                             to_char(v_new_fee, 'FM₱999G999D00'));
  end if;
  perform post_order_system_message(p_order_id, 'rider', v_msg);

  return jsonb_build_object(
    'updated', true,
    'moved_m', v_moved,
    'old_fee', o.delivery_fee,
    'new_fee', v_new_fee);
end;
$$;

revoke all on function rider_correct_delivery_pin(uuid, double precision, double precision, text) from public;
grant execute on function rider_correct_delivery_pin(uuid, double precision, double precision, text) to authenticated;
