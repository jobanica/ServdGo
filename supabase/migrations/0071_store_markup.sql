-- Price mark-up: a peso margin on top of what a store actually charges.
--
-- The operator lists an item above its shelf price and keeps the spread. The
-- customer sees one price and pays it; the rider hands the shelf price over the
-- counter and collects the marked-up price at the door, so the difference is in
-- their pocket at the end of the run — which is exactly why it has to land in
-- their payables alongside the commission.
--
-- Two switches, because a blanket mark-up is rarely right: one per store, one
-- per item. An item is marked up only when both are on, and may name its own
-- amount instead of the store's.
--
-- The split is the admin's: markup_operator_share is the fraction the operator
-- keeps. The rest stays with the rider and is never billed to them.

-- ---------------------------------------------------------------------------
-- Where the mark-up is configured
-- ---------------------------------------------------------------------------
alter table stores
  add column if not exists markup_enabled boolean not null default false,
  add column if not exists markup_amount  numeric(10, 2) not null default 0
    check (markup_amount >= 0);

comment on column stores.markup_amount is
  'Pesos added per unit to every marked-up item in this store.';

alter table menu_items
  -- On by default: switching a store on should mark up its menu, not nothing.
  add column if not exists markup_enabled boolean not null default true,
  -- Null means "whatever the store says"; a number overrides it for this item.
  add column if not exists markup_amount numeric(10, 2)
    check (markup_amount is null or markup_amount >= 0);

alter table app_settings
  add column if not exists markup_operator_share numeric(4, 3) not null default 1.000
    check (markup_operator_share >= 0 and markup_operator_share <= 1);

comment on column app_settings.markup_operator_share is
  'Fraction of each mark-up the operator keeps. 1.0 = all of it; 0.7 leaves the rider 30%.';

-- What the customer paid above the shelf price, per unit, frozen at order time
-- so later changes to the menu never rewrite an old bill.
alter table order_items
  add column if not exists markup_amount numeric(10, 2) not null default 0;

alter table orders
  add column if not exists markup_total numeric(12, 2) not null default 0;

comment on column orders.markup_total is
  'Mark-up collected on this order. The operator share of it is a rider payable.';

-- ---------------------------------------------------------------------------
-- The rule, in one place
-- ---------------------------------------------------------------------------

/**
 * Pesos of mark-up on one unit of a menu item — 0 unless both switches are on.
 *
 * The item's own amount wins when it names one; otherwise the store's applies.
 */
create or replace function effective_markup(p_menu_item_id uuid)
returns numeric
language sql
stable
security definer
set search_path = public
as $$
  select case
    when m.id is null then 0
    when not s.markup_enabled then 0
    when not m.markup_enabled then 0
    else greatest(0, coalesce(m.markup_amount, s.markup_amount, 0))
  end
  from menu_items m
  join stores s on s.id = m.store_id
  where m.id = p_menu_item_id;
$$;

grant execute on function effective_markup(uuid) to anon, authenticated;

-- Stamp the mark-up as the line is created. The client sends the price the
-- customer agreed to; what the operator is owed out of it is decided here, so a
-- tampered-with cart cannot quietly zero the margin.
create or replace function stamp_item_markup()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare v_markup numeric;
begin
  if new.menu_item_id is null then return new; end if;
  v_markup := effective_markup(new.menu_item_id);
  -- Never claim more mark-up than the line is worth: if the menu moved between
  -- the customer opening it and checking out, the older, lower price wins.
  new.markup_amount := least(coalesce(v_markup, 0), greatest(0, new.unit_price));
  return new;
end;
$$;

drop trigger if exists trg_stamp_item_markup on order_items;
create trigger trg_stamp_item_markup
  before insert on order_items
  for each row execute function stamp_item_markup();

-- ---------------------------------------------------------------------------
-- Totals
-- ---------------------------------------------------------------------------

-- Goods and mark-up move together: both are sums over the live line items.
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
            where i.order_id = o.id and i.status = 'ok'), 0),
         markup_total = coalesce((
           select sum(i.qty * i.markup_amount)
             from order_items i
            where i.order_id = o.id and i.status = 'ok'), 0)
   where o.id = p_order_id
     and o.service_type = 'food';
$$;

-- ---------------------------------------------------------------------------
-- The payable
-- ---------------------------------------------------------------------------

-- One ledger row per order per kind, so a mark-up sits beside its commission
-- instead of being folded into it and distorting every commission figure.
alter table commission_ledger
  add column if not exists kind text not null default 'commission'
    check (kind in ('commission', 'markup'));

do $$
begin
  if exists (select 1 from pg_constraint where conname = 'commission_ledger_order_id_key') then
    alter table commission_ledger drop constraint commission_ledger_order_id_key;
  end if;
end $$;

create unique index if not exists commission_ledger_order_kind_idx
  on commission_ledger (order_id, kind);

/**
 * Book what the rider owes once an order is delivered: the commission, and the
 * operator's share of any mark-up they collected.
 *
 * Only for money that passed through the rider's hands — an order paid online
 * never reaches them, so there is nothing to hand back.
 */
create or replace function record_commission_on_delivery()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_day   date := (now() at time zone 'Asia/Manila')::date;
  v_share numeric;
  v_owed  numeric;
begin
  if new.status = 'delivered'
     and old.status is distinct from 'delivered'
     and new.rider_id is not null
     and coalesce(new.payment_method, 'cod') in ('cod', 'rider_qr') then

    if coalesce(new.commission_amount, 0) > 0 then
      insert into commission_ledger (rider_id, order_id, amount, business_day, kind)
      values (new.rider_id, new.id, new.commission_amount, v_day, 'commission')
      on conflict (order_id, kind) do nothing;
    end if;

    if coalesce(new.markup_total, 0) > 0 then
      select coalesce(markup_operator_share, 1) into v_share from app_settings limit 1;
      v_owed := round(new.markup_total * coalesce(v_share, 1), 2);
      if v_owed > 0 then
        insert into commission_ledger (rider_id, order_id, amount, business_day, kind)
        values (new.rider_id, new.id, v_owed, v_day, 'markup')
        on conflict (order_id, kind) do nothing;
      end if;
    end if;
  end if;
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- Price corrections work on the shelf price, not the customer's
-- ---------------------------------------------------------------------------

/**
 * The rider corrects what the *store* charges. The mark-up rides on top of the
 * new figure rather than being erased by it — otherwise the first rider to
 * report a real shelf price would silently delete the operator's margin, and
 * the menu proposal would file that shelf price as if it were the listing.
 */
create or replace function rider_correct_item_price(p_item_id uuid, p_unit_price numeric)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rider  uuid := current_rider_id();
  v_order  uuid;
  v_name   text;
  v_qty    int;
  v_old    numeric;
  v_markup numeric;
  v_menu   uuid;
  v_store  uuid;
  v_menu_price numeric;
  v_new    numeric;
begin
  if v_rider is null then raise exception 'not a rider'; end if;
  if p_unit_price is null or p_unit_price < 0 then
    raise exception 'Price must be zero or more.';
  end if;

  select i.order_id, i.name, i.qty, i.unit_price, i.markup_amount, i.menu_item_id
    into v_order, v_name, v_qty, v_old, v_markup, v_menu
    from order_items i
    join orders o on o.id = i.order_id
   where i.id = p_item_id
     and o.rider_id = v_rider
     and o.status not in ('delivered', 'cancelled')
     and i.status in ('ok', 'proposed');
  if v_order is null then
    raise exception 'You can only change items on a delivery you are handling.';
  end if;

  v_markup := coalesce(v_markup, 0);
  v_new := p_unit_price + v_markup;
  if v_old = v_new then return; end if;

  update order_items set unit_price = v_new where id = p_item_id;
  perform recalc_order_goods(v_order);

  -- The customer is told what they now owe. Never "it costs X at the store" —
  -- with a mark-up on the line that figure is ours, not the shop's.
  perform post_order_system_message(v_order, 'rider',
    format('💲 The price of %s has changed. Your bill for it is %s instead of %s%s.',
           v_name,
           to_char(v_new, 'FM₱999G999D00'),
           to_char(v_old, 'FM₱999G999D00'),
           case when v_qty > 1 then format(' (%s × %s)', v_qty, to_char(v_new, 'FM₱999G999D00')) else '' end));

  if v_menu is null then return; end if;

  select m.store_id, m.price into v_store, v_menu_price
    from menu_items m where m.id = v_menu;
  if v_store is null or v_menu_price = p_unit_price then return; end if;

  insert into menu_price_proposals
    (menu_item_id, store_id, menu_price, actual_price, last_rider_id, last_order_id)
  values
    (v_menu, v_store, v_menu_price, p_unit_price, v_rider, v_order)
  on conflict (menu_item_id) where status = 'pending'
  do update set
    actual_price  = excluded.actual_price,
    reports       = menu_price_proposals.reports + 1,
    last_rider_id = excluded.last_rider_id,
    last_order_id = excluded.last_order_id,
    updated_at    = now();
end;
$$;

revoke all on function rider_correct_item_price(uuid, numeric) from public;
grant execute on function rider_correct_item_price(uuid, numeric) to authenticated;
