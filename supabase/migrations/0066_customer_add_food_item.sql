-- Adding one more thing from the same store, after ordering.
--
-- Someone forgets the drinks, or the household shouts an extra order through
-- the door thirty seconds after checkout. Until now the only options were a
-- second delivery fee or a phone call to the rider, and the bill would not
-- match what was actually bought.
--
-- Allowed while the rider is still at or heading to the store — accepted or
-- preparing, and pending too, when nobody has taken it yet. Once they have the
-- food and are on the way, the counter is behind them and the answer is no.
--
-- No approval step: the customer is choosing from the same store's menu at the
-- store's own price, and paying for it. The rider is told in the chat, and if
-- the kitchen is out of it they mark it sold out exactly as they would have on
-- the original order.
create or replace function customer_add_order_item(
  p_order_id uuid,
  p_menu_item_id uuid,
  p_qty int default 1,
  p_notes text default null
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cust   uuid := current_customer_id();
  v_status order_status;
  v_store  uuid;
  v_name   text;
  v_price  numeric;
  v_avail  boolean;
  v_item   uuid;
begin
  if v_cust is null then raise exception 'not a customer'; end if;
  if coalesce(p_qty, 0) < 1 then raise exception 'Quantity must be at least 1.'; end if;

  select o.status into v_status
    from orders o
   where o.id = p_order_id and o.customer_id = v_cust and o.service_type = 'food';
  if not found then
    raise exception 'That is not your food order.';
  end if;

  if v_status not in ('pending', 'accepted', 'preparing') then
    raise exception 'Your rider has already collected this order, so nothing more can be added. Message them in the chat if it''s urgent.'
      using errcode = 'check_violation';
  end if;

  -- Same store only. A second store is a second trip, which is what the
  -- extra-stop request is for.
  select m.store_id, m.name, m.price, m.is_available
    into v_store, v_name, v_price, v_avail
    from menu_items m
   where m.id = p_menu_item_id;
  if v_store is null then raise exception 'That item is no longer on the menu.'; end if;
  if v_avail is not true then raise exception '% is not available right now.', v_name; end if;

  if not exists (select 1 from order_stores os where os.order_id = p_order_id and os.store_id = v_store) then
    raise exception 'You can only add items from a store already on this order.';
  end if;

  insert into order_items (order_id, store_id, menu_item_id, name, qty, unit_price, notes, status)
  values (p_order_id, v_store, p_menu_item_id, v_name, p_qty, v_price,
          nullif(btrim(p_notes), ''), 'ok')
  returning id into v_item;

  perform recalc_order_goods(p_order_id);
  perform post_order_system_message(p_order_id, 'customer',
    format('➕ Please add %s× %s (%s) from the same store — sorry, and thank you!',
           p_qty, v_name, to_char(v_price * p_qty, 'FM₱999G999D00')));

  return v_item;
end;
$$;

revoke all on function customer_add_order_item(uuid, uuid, int, text) from public;
grant execute on function customer_add_order_item(uuid, uuid, int, text) to authenticated;
