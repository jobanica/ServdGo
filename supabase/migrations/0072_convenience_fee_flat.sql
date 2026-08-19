-- One convenience fee per order, whatever the store count.
--
-- 0070 charged it per stop. Seen in the field it reads wrong: a two-store run
-- showed ₱70 convenience next to a ₱25 store fee, and the extra stop is already
-- what the store fee is for. Charging both per stop bills the same thing twice.
--
-- Only the multiplier goes. Store fees stay per extra stop, and the delivery
-- fee is still re-quoted from the new route when a store is added.
create or replace function recalc_order_fees(p_order_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  o        orders%rowtype;
  s        app_settings%rowtype;
  v_stores int;
  v_conv   numeric;
begin
  select * into o from orders where id = p_order_id;
  if not found then return; end if;
  select * into s from app_settings limit 1;

  v_stores := case o.service_type
    when 'pabili' then greatest(1, coalesce(jsonb_array_length(o.buy_stores), 1))
    when 'padala' then 1
    else greatest(1, (select count(*)::int from order_stores os where os.order_id = p_order_id))
  end;

  v_conv := coalesce(case o.service_type
    when 'food'   then s.convenience_fee_food
    when 'pabili' then s.convenience_fee_pabili
    else s.convenience_fee_padala
  end, s.convenience_fee, 0);

  update orders
     set store_fee_total = round(greatest(0, v_stores - 1) * coalesce(s.per_store_fee, 0), 2),
         -- Flat: one per order, not one per stop.
         convenience_fee = round(v_conv, 2),
         delivery_fee    = case
           when o.delivery_lat is not null and o.delivery_lng is not null
             then quote_delivery_fee(p_order_id, o.delivery_lat, o.delivery_lng)
           else delivery_fee end
   where id = p_order_id;

  perform recalc_order_commission(p_order_id);
end;
$$;

-- Orders still in flight were quoted the doubled fee and their rider is about
-- to collect it. Put them back to a single fee; anything already delivered is
-- left alone, because that money has changed hands.
update orders o
   set convenience_fee = round(coalesce(
         case o.service_type
           when 'food'   then s.convenience_fee_food
           when 'pabili' then s.convenience_fee_pabili
           else s.convenience_fee_padala
         end, s.convenience_fee, 0), 2)
  from app_settings s
 where o.status not in ('delivered', 'cancelled')
   and o.convenience_fee > coalesce(
         case o.service_type
           when 'food'   then s.convenience_fee_food
           when 'pabili' then s.convenience_fee_pabili
           else s.convenience_fee_padala
         end, s.convenience_fee, 0);
