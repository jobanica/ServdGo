-- The rider fixes where the Pabili shop actually is, and the fee follows.
--
-- The button existed (0064) and did half a job. It wrote the corrected pin into
-- buy_stores, which drives the navigation arrow — and nothing else. The
-- delivery fee is quoted from orders.pickup_lat/lng, the pin the *customer*
-- dropped, and that was left untouched. So a rider could fix the map, ride the
-- real distance, and still be paid for the wrong one.
--
-- Worse in practice than it sounds: on Pabili the customer is pinning a shop
-- they are not standing in, from memory, on a map. Getting it wrong is the
-- normal case, not the exception. The rider is the one who finds out.
--
-- Correcting the first store now moves the order's pickup pin too and re-quotes
-- the fee from it. Later stores are extra stops — they are paid for by the
-- store fee, so fixing their pins helps navigation without touching the bill.

-- The audit trail already records drop-off corrections; say which end moved.
alter table order_pin_corrections
  add column if not exists kind text not null default 'dropoff'
    check (kind in ('dropoff', 'pickup'));

-- Was `returns void`; it now reports what it did to the fee.
drop function if exists rider_set_buy_store_location(uuid, int, double precision, double precision);

create or replace function rider_set_buy_store_location(
  p_order_id uuid,
  p_index int,
  p_lat double precision,
  p_lng double precision
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rider   uuid := current_rider_id();
  o         orders%rowtype;
  v_stores  jsonb;
  v_name    text;
  v_moved   double precision;
  v_new_fee numeric;
  v_lat     double precision;
  v_lng     double precision;
  v_radius  numeric;
  v_km      double precision;
  v_drives_fee boolean;
begin
  if v_rider is null then raise exception 'not a rider'; end if;
  if p_lat is null or p_lng is null then raise exception 'A location is required.'; end if;

  select * into o from orders
   where id = p_order_id and rider_id = v_rider and status not in ('delivered', 'cancelled');
  if not found then
    raise exception 'You can only change a delivery you are handling.';
  end if;

  v_stores := coalesce(o.buy_stores, '[]'::jsonb);
  if p_index < 0 or p_index >= jsonb_array_length(v_stores) then
    raise exception 'That store is not on this order.';
  end if;
  v_name := coalesce(nullif(btrim(v_stores -> p_index ->> 'name'), ''), 'the store');

  -- Bounded by where we deliver, exactly as the drop-off correction is. A shop
  -- outside the service area is a misplaced pin, not a stop we can serve.
  select service_center_lat, service_center_lng, service_radius_km
    into v_lat, v_lng, v_radius from app_settings limit 1;
  if v_lat is not null and v_lng is not null and coalesce(v_radius, 0) > 0 then
    v_km := km_between(v_lat, v_lng, p_lat, p_lng);
    if v_km > v_radius then
      return jsonb_build_object('updated', false, 'reason', 'outside_area',
        'message', format('That spot is about %s km out, past our %s km area. Check the pin — that cannot be the shop.',
                          round(v_km::numeric, 1), v_radius));
    end if;
  end if;

  update orders
     set buy_stores = jsonb_set(
           jsonb_set(v_stores, array[p_index::text, 'lat'], to_jsonb(p_lat), true),
           array[p_index::text, 'lng'], to_jsonb(p_lng), true)
   where id = p_order_id;

  -- The customer pins one shop, and it is stored as the order's pickup. That
  -- is the pin the fee is measured from, so correcting the first store has to
  -- move it — otherwise the map says one thing and the bill says another.
  v_drives_fee := (p_index = 0);
  if not v_drives_fee then
    perform post_order_system_message(p_order_id, 'rider',
      format('📍 I''ve put the map pin for %s where the shop actually is.', v_name));
    return jsonb_build_object('updated', true, 'repriced', false);
  end if;

  if o.pickup_lat is not null and o.pickup_lng is not null then
    v_moved := pin_distance_m(o.pickup_lat, o.pickup_lng, p_lat, p_lng);
    if v_moved < 20 then
      return jsonb_build_object('updated', false, 'reason', 'unchanged',
        'message', 'That is the same spot the pin is already on.');
    end if;
  end if;

  update orders set pickup_lat = p_lat, pickup_lng = p_lng where id = p_order_id;

  v_new_fee := case
    when o.delivery_lat is not null and o.delivery_lng is not null
      then quote_delivery_fee(p_order_id, o.delivery_lat, o.delivery_lng)
    else o.delivery_fee end;

  update orders set delivery_fee = v_new_fee where id = p_order_id;
  perform recalc_order_commission(p_order_id);

  insert into order_pin_corrections
    (order_id, rider_id, kind, from_lat, from_lng, to_lat, to_lng, moved_m, old_fee, new_fee)
  values
    (p_order_id, v_rider, 'pickup', o.pickup_lat, o.pickup_lng, p_lat, p_lng,
     v_moved, o.delivery_fee, v_new_fee);

  perform post_order_system_message(p_order_id, 'rider',
    format('📍 %s is not where the pin was%s. I''ve corrected it%s.',
           v_name,
           case when v_moved is not null and v_moved >= 1000
                then format(' — about %s km off', to_char(v_moved / 1000, 'FM990D0')) else '' end,
           case when v_new_fee <> o.delivery_fee
                then format(', so the delivery fee changes from %s to %s',
                            to_char(o.delivery_fee, 'FM₱999G999D00'),
                            to_char(v_new_fee, 'FM₱999G999D00'))
                else '' end));

  return jsonb_build_object(
    'updated', true, 'repriced', true,
    'moved_m', v_moved, 'old_fee', o.delivery_fee, 'new_fee', v_new_fee);
end;
$$;

revoke all on function rider_set_buy_store_location(uuid, int, double precision, double precision) from public;
grant execute on function rider_set_buy_store_location(uuid, int, double precision, double precision) to authenticated;
