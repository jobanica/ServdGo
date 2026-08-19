-- The rider fixes where a pabili store actually is.
--
-- The customer pins a store from home, from memory, off a map — and lands a
-- street away or on the wrong corner. The rider is the one standing in the
-- doorway, so let them drop the real pin with one tap of their own location.
--
-- It corrects the store list on the order, which is what the next rider (on a
-- transfer) and the navigation button both read.
create or replace function rider_set_buy_store_location(
  p_order_id uuid,
  p_index int,
  p_lat double precision,
  p_lng double precision
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rider  uuid := current_rider_id();
  v_stores jsonb;
  v_name   text;
begin
  if v_rider is null then raise exception 'not a rider'; end if;
  if p_lat is null or p_lng is null then raise exception 'A location is required.'; end if;

  select buy_stores into v_stores
    from orders
   where id = p_order_id
     and rider_id = v_rider
     and status not in ('delivered', 'cancelled');
  if v_stores is null then
    raise exception 'You can only change a delivery you are handling.';
  end if;

  if p_index < 0 or p_index >= jsonb_array_length(v_stores) then
    raise exception 'That store is not on this order.';
  end if;

  v_name := v_stores -> p_index ->> 'name';

  update orders
     set buy_stores = jsonb_set(
           jsonb_set(v_stores, array[p_index::text, 'lat'], to_jsonb(p_lat), true),
           array[p_index::text, 'lng'], to_jsonb(p_lng), true)
   where id = p_order_id;

  perform post_order_system_message(p_order_id, 'rider',
    format('📍 I''ve updated the map pin for %s to where the store actually is.',
           coalesce(nullif(btrim(v_name), ''), 'the store')));
end;
$$;

revoke all on function rider_set_buy_store_location(uuid, int, double precision, double precision) from public;
grant execute on function rider_set_buy_store_location(uuid, int, double precision, double precision) to authenticated;
