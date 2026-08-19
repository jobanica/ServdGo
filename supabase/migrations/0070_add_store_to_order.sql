-- Adding a whole extra store to an order that is already under way.
--
-- 0066 let a customer add one more thing from a store the rider is already
-- visiting. This is the other half: "can you also grab something from the
-- bakery on the way?" — up to the three stores an order may span.
--
-- A new store is a new stop: another queue, another counter, another wait, and
-- often a detour. So it is priced like one — the per-store fee, a convenience
-- fee for the extra stop, and the delivery fee re-quoted from the new set of
-- pickup pins — and the rider is asked before any of it is charged. Adding to a
-- store already on the order stays instant, because it costs the rider nothing
-- but a second look at the same counter.

-- The extra-stop request grows a real store and a real basket behind it.
alter table order_addons
  add column if not exists store_id uuid references stores (id) on delete set null;

create table if not exists order_addon_items (
  id           uuid primary key default gen_random_uuid(),
  addon_id     uuid not null references order_addons (id) on delete cascade,
  menu_item_id uuid not null references menu_items (id) on delete cascade,
  name         text not null,
  qty          int  not null check (qty > 0),
  unit_price   numeric(10, 2) not null
);
create index if not exists order_addon_items_addon_idx on order_addon_items (addon_id);

alter table order_addon_items enable row level security;

drop policy if exists order_addon_items_party on order_addon_items;
create policy order_addon_items_party on order_addon_items
  for select using (
    exists (
      select 1 from order_addons a
        join orders o on o.id = a.order_id
       where a.id = order_addon_items.addon_id
         and (o.customer_id = current_customer_id() or o.rider_id = current_rider_id() or is_staff())));

-- ---------------------------------------------------------------------------
-- Fees, recomputed from what the order actually is now
-- ---------------------------------------------------------------------------

/**
 * Re-price an order from its current shape: how many stores it touches and
 * where they are.
 *
 * The store fee is charged per stop beyond the first, the convenience fee once
 * per stop, and the delivery fee is re-quoted from the pickup pins now on the
 * order. Only called when the shape actually changes — an untouched order keeps
 * the numbers it was quoted.
 */
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
         convenience_fee = round(v_stores * v_conv, 2),
         delivery_fee    = case
           when o.delivery_lat is not null and o.delivery_lng is not null
             then quote_delivery_fee(p_order_id, o.delivery_lat, o.delivery_lng)
           else delivery_fee end
   where id = p_order_id;

  perform recalc_order_commission(p_order_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- The customer asks for the extra stop
-- ---------------------------------------------------------------------------

/**
 * Request a new store on an order in progress, with the items to buy there.
 *
 * Nothing is charged and nothing is added until the rider accepts — they may be
 * halfway across town, and a stop they cannot make should not appear on the
 * bill. The one exception is an order nobody has taken yet: there is no rider
 * to ask, so it simply becomes part of the order.
 *
 * `p_items` is [{"menu_item_id": uuid, "qty": int}, …].
 */
create or replace function customer_add_order_store(
  p_order_id uuid,
  p_store_id uuid,
  p_items jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cust    uuid := current_customer_id();
  o         orders%rowtype;
  v_stores  int;
  v_store   stores%rowtype;
  v_addon   uuid;
  v_goods   numeric := 0;
  v_lines   int := 0;
  it        jsonb;
  m         menu_items%rowtype;
  v_qty     int;
  s         app_settings%rowtype;
begin
  if v_cust is null then raise exception 'not a customer'; end if;

  select * into o from orders
   where id = p_order_id and customer_id = v_cust and service_type = 'food';
  if not found then raise exception 'That is not your food order.'; end if;

  if o.status not in ('pending', 'accepted', 'preparing') then
    raise exception 'Your rider has already collected this order, so no more stops can be added. Message them in the chat if it''s urgent.'
      using errcode = 'check_violation';
  end if;

  select * into v_store from stores where id = p_store_id;
  if not found then raise exception 'That store is not available.'; end if;
  if v_store.is_available is not true then
    raise exception '% is closed right now.', v_store.name;
  end if;

  if exists (select 1 from order_stores os where os.order_id = p_order_id and os.store_id = p_store_id) then
    raise exception 'That store is already on this order — just add the items to it.';
  end if;

  select count(*)::int into v_stores from order_stores os where os.order_id = p_order_id;
  -- Three stops is as much as one trip carries; a fourth is a second delivery.
  if v_stores >= 3 then
    raise exception 'An order can cover at most 3 stores. Please place a separate order for this one.'
      using errcode = 'check_violation';
  end if;

  if p_items is null or jsonb_array_length(p_items) = 0 then
    raise exception 'Please choose at least one item from that store.';
  end if;

  insert into order_addons (order_id, store_id, description, store_name, lat, lng, est_amount, status)
  values (p_order_id, p_store_id, '', v_store.name, v_store.lat, v_store.lng, 0, 'pending')
  returning id into v_addon;

  for it in select * from jsonb_array_elements(p_items) loop
    select * into m from menu_items where id = (it ->> 'menu_item_id')::uuid;
    if not found or m.store_id <> p_store_id then
      raise exception 'One of those items is not on that store''s menu.';
    end if;
    if m.is_available is not true then
      raise exception '% is not available right now.', m.name;
    end if;
    v_qty := greatest(1, coalesce((it ->> 'qty')::int, 1));
    insert into order_addon_items (addon_id, menu_item_id, name, qty, unit_price)
    values (v_addon, m.id, m.name, v_qty, m.price);
    v_goods := v_goods + v_qty * m.price;
    v_lines := v_lines + 1;
  end loop;

  update order_addons
     set est_amount  = v_goods,
         description = format('%s item%s from %s', v_lines, case when v_lines = 1 then '' else 's' end, v_store.name)
   where id = v_addon;

  -- Nobody has taken this order yet, so there is nobody to ask.
  if o.rider_id is null then
    perform apply_order_addon(v_addon);
    return jsonb_build_object('applied', true, 'addon_id', v_addon);
  end if;

  select * into s from app_settings limit 1;
  perform post_order_system_message(p_order_id, 'customer',
    format('➕ Could you also stop at %s for %s item%s? Happy to pay the extra %s stop fee.',
           v_store.name, v_lines, case when v_lines = 1 then '' else 's' end,
           to_char(coalesce(s.per_store_fee, 0)
                   + coalesce(s.convenience_fee_food, s.convenience_fee, 0), 'FM₱999G999D00')));

  return jsonb_build_object('applied', false, 'addon_id', v_addon);
end;
$$;

revoke all on function customer_add_order_store(uuid, uuid, jsonb) from public;
grant execute on function customer_add_order_store(uuid, uuid, jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- Turning an accepted request into a real stop
-- ---------------------------------------------------------------------------

/** Put an accepted extra stop onto the order: the store, its items, the fees. */
create or replace function apply_order_addon(p_addon_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  a order_addons%rowtype;
begin
  select * into a from order_addons where id = p_addon_id;
  if a.store_id is null then return; end if;

  insert into order_stores (order_id, store_id)
  values (a.order_id, a.store_id)
  on conflict do nothing;

  insert into order_items (order_id, store_id, menu_item_id, name, qty, unit_price, status)
  select a.order_id, a.store_id, i.menu_item_id, i.name, i.qty, i.unit_price, 'ok'
    from order_addon_items i
   where i.addon_id = p_addon_id;

  perform recalc_order_goods(a.order_id);
  perform recalc_order_fees(a.order_id);

  update order_addons set status = 'accepted', responded_at = now() where id = p_addon_id;
end;
$$;

/**
 * The rider answers an extra-stop request.
 *
 * A request carrying a store is applied whole — store, items and re-priced fees
 * — while the older free-text kind keeps its own incremental store fee, so
 * pabili errands behave exactly as they did.
 */
create or replace function rider_respond_addon(p_addon_id uuid, p_accept boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rider uuid := current_rider_id();
  a       order_addons%rowtype;
  v_fee   numeric;
  o_fee   numeric;
  o_conv  numeric;
begin
  if v_rider is null then raise exception 'not a rider'; end if;

  select a2.* into a
    from order_addons a2
    join orders o on o.id = a2.order_id
   where a2.id = p_addon_id and a2.status = 'pending' and o.rider_id = v_rider;
  if not found then
    raise exception 'That request is no longer waiting for an answer.';
  end if;

  if not p_accept then
    update order_addons set status = 'declined', responded_at = now() where id = p_addon_id;
    perform post_order_system_message(a.order_id, 'rider',
      'Sorry, I can''t make that extra stop on this trip.');
    return;
  end if;

  if a.store_id is not null then
    select delivery_fee, convenience_fee into o_fee, o_conv from orders where id = a.order_id;
    perform apply_order_addon(p_addon_id);
    perform post_order_system_message(a.order_id, 'rider',
      format('✅ %s added to the trip. Your fees go from %s to %s — that covers the extra stop and the longer route.',
             a.store_name,
             to_char(o_fee + o_conv, 'FM₱999G999D00'),
             to_char((select delivery_fee + convenience_fee + store_fee_total from orders where id = a.order_id),
                     'FM₱999G999D00')));
    return;
  end if;

  -- The original free-text errand: one extra store fee, nothing re-quoted.
  select coalesce(per_store_fee, 0) into v_fee from app_settings limit 1;

  update order_addons
     set status = 'accepted', responded_at = now(), store_fee = v_fee
   where id = p_addon_id;

  update orders o set
    store_fee_total  = o.store_fee_total + v_fee,
    estimated_amount = coalesce(o.estimated_amount, 0) + a.est_amount,
    budget_cap       = coalesce(o.budget_cap, 0) + a.est_amount,
    item_description = coalesce(o.item_description, '') || ' + ' || a.description
  where o.id = a.order_id;

  perform recalc_order_commission(a.order_id);
  perform post_order_system_message(a.order_id, 'rider',
    format('✅ Added to your order. There''s a %s fee for the extra stop.',
           to_char(v_fee, 'FM₱999G999D00')));
end;
$$;

revoke all on function rider_respond_addon(uuid, boolean) from public;
grant execute on function rider_respond_addon(uuid, boolean) to authenticated;
