-- "While you're out, can you also grab something from the other store?"
--
-- That conversation was happening in the chat and nowhere else: the rider did
-- the extra stop for free, the customer's total never moved, and the operator
-- earned no commission on the added work. Make it a real request the rider can
-- accept, priced the same way an extra store always has been.
--
-- Commission is (delivery_fee + added_stores * per_store_fee) * rate, so an
-- accepted add-on raises store_fee_total by one per-store fee and the
-- commission follows. The existing delivered-trigger books it at settlement.

create table if not exists order_addons (
  id           uuid primary key default gen_random_uuid(),
  order_id     uuid not null references orders (id) on delete cascade,
  description  text not null,
  store_name   text,
  lat          numeric,
  lng          numeric,
  est_amount   numeric not null default 0,
  status       text not null default 'pending'
                 check (status in ('pending', 'accepted', 'declined', 'cancelled')),
  store_fee    numeric not null default 0,
  created_at   timestamptz not null default now(),
  responded_at timestamptz
);
create index if not exists order_addons_order_idx on order_addons (order_id, status);

alter table order_addons enable row level security;

drop policy if exists order_addons_customer on order_addons;
create policy order_addons_customer on order_addons
  for select to authenticated
  using (exists (select 1 from orders o
                  where o.id = order_addons.order_id
                    and o.customer_id = current_customer_id()));

drop policy if exists order_addons_rider on order_addons;
create policy order_addons_rider on order_addons
  for select to authenticated
  using (exists (select 1 from orders o
                  where o.id = order_addons.order_id
                    and o.rider_id = current_rider_id()));

drop policy if exists order_addons_staff on order_addons;
create policy order_addons_staff on order_addons
  for all to authenticated using (is_staff()) with check (is_staff());

/* Recompute the operator's cut after the billable stops change. Mirrors
   commission() in @ebd/shared so both sides agree. */
create or replace function recalc_order_commission(p_order_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare v_rate numeric;
begin
  select coalesce(commission_rate, 0.15) into v_rate from app_settings limit 1;
  update orders o
     set commission_amount = round((o.delivery_fee + o.store_fee_total) * v_rate, 2)
   where o.id = p_order_id;
end;
$$;

-- The customer asks for an extra stop on an order already in progress.
create or replace function customer_request_addon(
  p_order_id uuid, p_description text, p_store_name text default null,
  p_lat numeric default null, p_lng numeric default null, p_est numeric default 0
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cust uuid := current_customer_id();
  v_ok   boolean;
  v_id   uuid;
begin
  if v_cust is null then raise exception 'not a customer'; end if;
  if btrim(coalesce(p_description, '')) = '' then
    raise exception 'Tell your rider what to buy.';
  end if;

  select true into v_ok from orders o
   where o.id = p_order_id and o.customer_id = v_cust
     and o.rider_id is not null
     and o.status not in ('delivered', 'cancelled');
  if v_ok is not true then
    raise exception 'You can only add to your own order while it is still on the way.';
  end if;

  if exists (select 1 from order_addons a
              where a.order_id = p_order_id and a.status = 'pending') then
    raise exception 'Your rider still has to answer your last request.';
  end if;

  insert into order_addons (order_id, description, store_name, lat, lng, est_amount)
  values (p_order_id, btrim(p_description), nullif(btrim(coalesce(p_store_name, '')), ''),
          p_lat, p_lng, greatest(coalesce(p_est, 0), 0))
  returning id into v_id;

  perform post_order_system_message(p_order_id, 'customer',
    format('➕ Can you also buy: %s%s', btrim(p_description),
           case when nullif(btrim(coalesce(p_store_name, '')), '') is null
                then '' else ' (at ' || btrim(p_store_name) || ')' end));
  return v_id;
end;
$$;

/* The rider decides — they are the one making the extra trip. Accepting bills
   the added stop and lifts the spending cap so the goods stay within budget. */
create or replace function rider_respond_addon(p_addon_id uuid, p_accept boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rider uuid := current_rider_id();
  v_order uuid;
  v_desc  text;
  v_est   numeric;
  v_fee   numeric;
begin
  if v_rider is null then raise exception 'not a rider'; end if;

  select a.order_id, a.description, a.est_amount
    into v_order, v_desc, v_est
    from order_addons a
    join orders o on o.id = a.order_id
   where a.id = p_addon_id and a.status = 'pending' and o.rider_id = v_rider;
  if v_order is null then
    raise exception 'That request is no longer waiting for an answer.';
  end if;

  if not p_accept then
    update order_addons set status = 'declined', responded_at = now() where id = p_addon_id;
    perform post_order_system_message(v_order, 'rider',
      'Sorry, I can''t make that extra stop on this trip.');
    return;
  end if;

  select coalesce(per_store_fee, 0) into v_fee from app_settings limit 1;

  update order_addons
     set status = 'accepted', responded_at = now(), store_fee = v_fee
   where id = p_addon_id;

  update orders o set
    store_fee_total  = o.store_fee_total + v_fee,
    -- Keep the budget honest: the rider still can't overspend without asking.
    estimated_amount = coalesce(o.estimated_amount, 0) + v_est,
    budget_cap       = coalesce(o.budget_cap, 0) + v_est,
    item_description = coalesce(o.item_description, '') || ' + ' || v_desc
  where o.id = v_order;

  perform recalc_order_commission(v_order);
  perform post_order_system_message(v_order, 'rider',
    format('✅ Added to your order. There''s a %s fee for the extra stop.',
           to_char(v_fee, 'FM₱999G999D00')));
end;
$$;

-- The customer changes their mind before the rider answers.
create or replace function customer_cancel_addon(p_addon_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare v_cust uuid := current_customer_id();
begin
  if v_cust is null then raise exception 'not a customer'; end if;
  update order_addons a set status = 'cancelled', responded_at = now()
   where a.id = p_addon_id and a.status = 'pending'
     and exists (select 1 from orders o
                  where o.id = a.order_id and o.customer_id = v_cust);
  if not found then raise exception 'That request can no longer be cancelled.'; end if;
end;
$$;

revoke all on function recalc_order_commission(uuid) from public;
revoke all on function customer_request_addon(uuid, text, text, numeric, numeric, numeric) from public;
revoke all on function rider_respond_addon(uuid, boolean) from public;
revoke all on function customer_cancel_addon(uuid) from public;
grant execute on function customer_request_addon(uuid, text, text, numeric, numeric, numeric) to authenticated;
grant execute on function rider_respond_addon(uuid, boolean) to authenticated;
grant execute on function customer_cancel_addon(uuid) to authenticated;
