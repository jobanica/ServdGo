-- Two corrections that reality forces on an order in progress.
--
-- 1. The menu price is wrong. Our copy of a store's menu goes stale the moment
--    the store reprices, and the rider is the one standing at the counter with
--    the real number. They can already mark an item sold out; they could not
--    say "it's ₱95 now, not ₱85", so the bill went out wrong and somebody ate
--    the difference.
--
-- 2. The pin is wrong. A customer drops a pin in the wrong place and only
--    notices once the order is in. Until now the only fix was cancelling.
--    Correcting a pin is allowed while nobody has collected anything yet, and
--    only within a short distance — this is for fixing a mistake, not for
--    moving a delivery across town after the fee was agreed.

-- ---------------------------------------------------------------------------
-- 1. The rider corrects a line item's price
-- ---------------------------------------------------------------------------
create or replace function rider_correct_item_price(p_item_id uuid, p_unit_price numeric)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rider uuid := current_rider_id();
  v_order uuid;
  v_name  text;
  v_qty   int;
  v_old   numeric;
begin
  if v_rider is null then raise exception 'not a rider'; end if;
  if p_unit_price is null or p_unit_price < 0 then
    raise exception 'Price must be zero or more.';
  end if;

  select i.order_id, i.name, i.qty, i.unit_price
    into v_order, v_name, v_qty, v_old
    from order_items i
    join orders o on o.id = i.order_id
   where i.id = p_item_id
     and o.rider_id = v_rider
     and o.status not in ('delivered', 'cancelled')
     and i.status in ('ok', 'proposed');
  if v_order is null then
    raise exception 'You can only change items on a delivery you are handling.';
  end if;

  if v_old = p_unit_price then return; end if;

  update order_items set unit_price = p_unit_price where id = p_item_id;
  perform recalc_order_goods(v_order);

  -- Say it in the thread the customer is already watching. A silent change to
  -- what someone owes is how you lose them.
  perform post_order_system_message(v_order, 'rider',
    format('💲 %s is %s at the store, not %s. I''ve corrected your bill%s.',
           v_name,
           to_char(p_unit_price, 'FM₱999G999D00'),
           to_char(v_old, 'FM₱999G999D00'),
           case when v_qty > 1 then format(' (%s × %s)', v_qty, to_char(p_unit_price, 'FM₱999G999D00')) else '' end));
end;
$$;

revoke all on function rider_correct_item_price(uuid, numeric) from public;
grant execute on function rider_correct_item_price(uuid, numeric) to authenticated;

-- ---------------------------------------------------------------------------
-- 2. The customer corrects a pin on their own order
-- ---------------------------------------------------------------------------

/** Rough great-circle distance in metres — enough to police a correction. */
create or replace function pin_distance_m(
  a_lat double precision, a_lng double precision,
  b_lat double precision, b_lng double precision
) returns double precision
language sql
immutable
as $$
  select 2 * 6371000 * asin(least(1, sqrt(
    power(sin(radians(b_lat - a_lat) / 2), 2) +
    cos(radians(a_lat)) * cos(radians(b_lat)) * power(sin(radians(b_lng - a_lng) / 2), 2)
  )));
$$;

/** How far a pin may be nudged. Beyond this it is a different delivery. */
create or replace function max_pin_correction_m() returns int
language sql immutable as $$ select 2000 $$;

create or replace function customer_correct_order_pins(
  p_order_id uuid,
  p_pickup_lat double precision default null,
  p_pickup_lng double precision default null,
  p_delivery_lat double precision default null,
  p_delivery_lng double precision default null,
  p_delivery_address text default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cust uuid := current_customer_id();
  o      orders%rowtype;
  v_moved text[] := '{}';
  v_far   double precision;
begin
  if v_cust is null then raise exception 'not a customer'; end if;

  select * into o from orders
   where id = p_order_id and customer_id = v_cust;
  if not found then
    raise exception 'That is not your order.';
  end if;

  -- Once the rider has the goods, the route is already being walked.
  if o.status not in ('pending', 'accepted', 'preparing') then
    return jsonb_build_object('updated', false, 'reason', 'too_late',
      'message', 'Your rider has already collected this order, so the map pin can no longer be changed. Message them in the chat instead.');
  end if;

  if p_pickup_lat is not null and p_pickup_lng is not null and o.pickup_lat is not null then
    v_far := pin_distance_m(o.pickup_lat, o.pickup_lng, p_pickup_lat, p_pickup_lng);
    if v_far > max_pin_correction_m() then
      return jsonb_build_object('updated', false, 'reason', 'too_far',
        'message', format('That is %s km from the original spot — too far to correct after ordering, because the delivery fee was worked out from it. Please cancel and place a new order.',
                          to_char(v_far / 1000, 'FM990D0')));
    end if;
  end if;

  if p_delivery_lat is not null and p_delivery_lng is not null and o.delivery_lat is not null then
    v_far := pin_distance_m(o.delivery_lat, o.delivery_lng, p_delivery_lat, p_delivery_lng);
    if v_far > max_pin_correction_m() then
      return jsonb_build_object('updated', false, 'reason', 'too_far',
        'message', format('That is %s km from the original drop-off — too far to correct after ordering, because the delivery fee was worked out from it. Please cancel and place a new order.',
                          to_char(v_far / 1000, 'FM990D0')));
    end if;
  end if;

  if p_pickup_lat is not null and p_pickup_lng is not null then
    update orders set pickup_lat = p_pickup_lat, pickup_lng = p_pickup_lng where id = p_order_id;
    v_moved := v_moved || 'where to buy';
  end if;

  if p_delivery_lat is not null and p_delivery_lng is not null then
    update orders set delivery_lat = p_delivery_lat, delivery_lng = p_delivery_lng where id = p_order_id;
    v_moved := v_moved || 'the drop-off';
  end if;

  if p_delivery_address is not null then
    update orders set delivery_address = nullif(btrim(p_delivery_address), '') where id = p_order_id;
    if not ('the drop-off' = any (v_moved)) then v_moved := v_moved || 'the address'; end if;
  end if;

  if array_length(v_moved, 1) is null then
    return jsonb_build_object('updated', false, 'reason', 'nothing_to_do');
  end if;

  -- The fee stays as quoted: a correction within a couple of streets should not
  -- reprice an order the customer already agreed to.
  perform post_order_system_message(p_order_id, 'customer',
    format('📍 I''ve corrected %s on the map — please check the pin before you set off.',
           array_to_string(v_moved, ' and ')));

  return jsonb_build_object('updated', true);
end;
$$;

revoke all on function customer_correct_order_pins(uuid, double precision, double precision, double precision, double precision, text) from public;
grant execute on function customer_correct_order_pins(uuid, double precision, double precision, double precision, double precision, text) to authenticated;
