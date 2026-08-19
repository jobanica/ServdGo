-- Sold-out items: the rider is at the store, something isn't available, and the
-- customer needs a say in what happens to their money.
--
-- Two moves, deliberately different:
--   * Marking an item sold out removes it from the bill immediately. The
--     customer only ever pays less, so it needs no approval and never leaves
--     the rider waiting at the counter.
--   * Offering a replacement is a *proposal*. Nobody gets charged for an item
--     they didn't choose, so it stays out of the total until the customer says
--     yes in the app.

alter table order_items
  add column if not exists status text not null default 'ok',
  add column if not exists replaces_item_id uuid references order_items (id) on delete set null;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'order_items_status_check') then
    alter table order_items add constraint order_items_status_check
      check (status in ('ok', 'sold_out', 'proposed', 'replaced', 'removed'));
  end if;
end $$;

create index if not exists order_items_order_status_idx on order_items (order_id, status);

/* Food totals follow the live line items. Pabili bills the rider's receipt
   total instead, so it is left alone. */
create or replace function recalc_order_goods(p_order_id uuid)
returns void
language sql
security definer
set search_path = public
as $$
  update orders o
     set goods_cost = coalesce((
           select sum(i.qty * i.unit_price)
             from order_items i
            where i.order_id = o.id and i.status = 'ok'), 0)
   where o.id = p_order_id
     and o.service_type = 'food';
$$;

/* Post into the existing order chat so the change lands in the thread the
   customer already watches (and trips the unread badge). */
create or replace function post_order_system_message(p_order_id uuid, p_role text, p_body text)
returns void
language sql
security definer
set search_path = public
as $$
  insert into order_messages (order_id, sender_profile, sender_role, body)
  values (p_order_id, auth.uid(), p_role, p_body);
$$;

-- The rider marks an item unavailable. It drops off the bill straight away.
create or replace function rider_mark_item_sold_out(p_item_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rider uuid := current_rider_id();
  v_order uuid;
  v_name  text;
begin
  if v_rider is null then raise exception 'not a rider'; end if;

  select i.order_id, i.name into v_order, v_name
    from order_items i
    join orders o on o.id = i.order_id
   where i.id = p_item_id and o.rider_id = v_rider and i.status in ('ok', 'proposed');
  if v_order is null then
    raise exception 'You can only change items on your own delivery.';
  end if;

  update order_items set status = 'sold_out' where id = p_item_id;
  perform recalc_order_goods(v_order);
  perform post_order_system_message(v_order, 'rider',
    format('⚠️ %s is sold out. I''ve taken it off your bill — tell me if you want something else instead.', v_name));
end;
$$;

-- The rider offers a replacement. It stays off the bill until the customer agrees.
create or replace function rider_propose_replacement(
  p_item_id uuid, p_name text, p_qty int, p_unit_price numeric
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rider uuid := current_rider_id();
  v_order uuid;
  v_store uuid;
  v_old   text;
  v_new   uuid;
begin
  if v_rider is null then raise exception 'not a rider'; end if;
  if btrim(coalesce(p_name, '')) = '' then raise exception 'Give the replacement a name.'; end if;
  if coalesce(p_qty, 0) < 1 then raise exception 'Quantity must be at least 1.'; end if;
  if coalesce(p_unit_price, -1) < 0 then raise exception 'Price must be zero or more.'; end if;

  select i.order_id, i.store_id, i.name into v_order, v_store, v_old
    from order_items i
    join orders o on o.id = i.order_id
   where i.id = p_item_id and o.rider_id = v_rider;
  if v_order is null then
    raise exception 'You can only change items on your own delivery.';
  end if;

  -- Drop any earlier offer for this item so there is only ever one to answer.
  update order_items set status = 'removed'
   where replaces_item_id = p_item_id and status = 'proposed';

  update order_items set status = 'sold_out' where id = p_item_id and status = 'ok';

  insert into order_items (order_id, store_id, name, qty, unit_price, status, replaces_item_id)
  values (v_order, v_store, btrim(p_name), p_qty, p_unit_price, 'proposed', p_item_id)
  returning id into v_new;

  perform recalc_order_goods(v_order);
  perform post_order_system_message(v_order, 'rider',
    format('🔁 %s is sold out. Can I get you %s×%s at %s instead? Tap Accept or Decline on your order.',
           v_old, p_qty, btrim(p_name), to_char(p_unit_price, 'FM₱999G999D00')));
  return v_new;
end;
$$;

-- The customer answers the offer. Only they can put it on their own bill.
create or replace function customer_respond_item_change(p_item_id uuid, p_accept boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cust  uuid := current_customer_id();
  v_order uuid;
  v_name  text;
  v_repl  uuid;
begin
  if v_cust is null then raise exception 'not a customer'; end if;

  select i.order_id, i.name, i.replaces_item_id into v_order, v_name, v_repl
    from order_items i
    join orders o on o.id = i.order_id
   where i.id = p_item_id and o.customer_id = v_cust and i.status = 'proposed';
  if v_order is null then
    raise exception 'That suggestion is no longer waiting for an answer.';
  end if;

  if p_accept then
    update order_items set status = 'ok' where id = p_item_id;
    update order_items set status = 'replaced' where id = v_repl;
  else
    update order_items set status = 'removed' where id = p_item_id;
  end if;

  perform recalc_order_goods(v_order);
  perform post_order_system_message(v_order, 'customer',
    case when p_accept
      then format('✅ Yes please — %s works for me.', v_name)
      else format('❌ No thanks, skip the %s. Just leave it off.', v_name) end);
end;
$$;

/* When the store has nothing left, the customer shouldn't be stuck paying a
   delivery fee for an empty bag — even though a rider is already assigned. */
create or replace function customer_cancel_empty_order(p_order_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cust uuid := current_customer_id();
  v_left int;
begin
  if v_cust is null then raise exception 'not a customer'; end if;

  select count(*) into v_left
    from order_items i
   where i.order_id = p_order_id and i.status in ('ok', 'proposed');

  if v_left > 0 then return false; end if;

  update orders set status = 'cancelled'
   where id = p_order_id
     and customer_id = v_cust
     and status not in ('delivered', 'cancelled');
  if not found then return false; end if;

  insert into order_status_events (order_id, status) values (p_order_id, 'cancelled');
  perform post_order_system_message(p_order_id, 'customer',
    'Everything I ordered is sold out, so I''ve cancelled this order. Sorry for the trouble!');
  return true;
end;
$$;

revoke all on function recalc_order_goods(uuid) from public;
revoke all on function post_order_system_message(uuid, text, text) from public;
revoke all on function rider_mark_item_sold_out(uuid) from public;
revoke all on function rider_propose_replacement(uuid, text, int, numeric) from public;
revoke all on function customer_respond_item_change(uuid, boolean) from public;
revoke all on function customer_cancel_empty_order(uuid) from public;
grant execute on function rider_mark_item_sold_out(uuid) to authenticated;
grant execute on function rider_propose_replacement(uuid, text, int, numeric) to authenticated;
grant execute on function customer_respond_item_change(uuid, boolean) to authenticated;
grant execute on function customer_cancel_empty_order(uuid) to authenticated;
