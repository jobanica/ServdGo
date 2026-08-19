-- A rider's price correction feeds back into the menu — once an admin agrees.
--
-- Since 0059 a rider standing at the counter can fix a line item's price, so
-- the customer's bill matches the receipt. What it never fixed was the *menu*:
-- our copy of the store's price stayed stale, the next customer was quoted the
-- same wrong number, and the next rider corrected it all over again. The same
-- ₱10 error, every order, forever.
--
-- So the correction now also files a proposal against the menu item. The order
-- is still repriced immediately — the rider is at the till and the bill has to
-- be right — but changing what every future customer is quoted is an operator
-- decision, not a rider's. One approval, and the menu follows.

create table if not exists menu_price_proposals (
  id            uuid primary key default gen_random_uuid(),
  menu_item_id  uuid not null references menu_items (id) on delete cascade,
  store_id      uuid not null references stores (id) on delete cascade,
  -- What the menu said when the first rider reported it.
  menu_price    numeric(10, 2) not null,
  -- What the store is actually charging, per the most recent report.
  actual_price  numeric(10, 2) not null,
  -- How many separate corrections have landed on this item. Three riders
  -- saying the same thing is a repriced menu; one is possibly a typo.
  reports       int not null default 1,
  status        text not null default 'pending'
                  check (status in ('pending', 'approved', 'rejected')),
  last_rider_id uuid references riders (id) on delete set null,
  last_order_id uuid references orders (id) on delete set null,
  reviewed_by   uuid references profiles (id) on delete set null,
  reviewed_at   timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- At most one open proposal per menu item: a second report updates the first
-- rather than queueing another decision for the same price.
create unique index if not exists menu_price_proposals_open_idx
  on menu_price_proposals (menu_item_id) where status = 'pending';
create index if not exists menu_price_proposals_status_idx
  on menu_price_proposals (status, updated_at desc);

alter table menu_price_proposals enable row level security;

drop policy if exists menu_price_proposals_read on menu_price_proposals;
create policy menu_price_proposals_read on menu_price_proposals
  for select using (last_rider_id = current_rider_id() or is_staff());

drop policy if exists menu_price_proposals_staff_write on menu_price_proposals;
create policy menu_price_proposals_staff_write on menu_price_proposals
  for all using (is_staff()) with check (is_staff());

-- ---------------------------------------------------------------------------
-- Filing the proposal, from the correction the rider already makes
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
  v_menu  uuid;
  v_store uuid;
  v_menu_price numeric;
begin
  if v_rider is null then raise exception 'not a rider'; end if;
  if p_unit_price is null or p_unit_price < 0 then
    raise exception 'Price must be zero or more.';
  end if;

  select i.order_id, i.name, i.qty, i.unit_price, i.menu_item_id
    into v_order, v_name, v_qty, v_old, v_menu
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

  -- Free-text pabili lines and rider-proposed replacements have no menu item
  -- behind them, so there is nothing to keep in step.
  if v_menu is null then return; end if;

  select m.store_id, m.price into v_store, v_menu_price
    from menu_items m where m.id = v_menu;
  -- Already matches what the store charges — the stale price was only on this
  -- order (an old order, or a price someone already fixed).
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

-- ---------------------------------------------------------------------------
-- The operator's decision
-- ---------------------------------------------------------------------------

/**
 * Approve a reported price (writing it onto the menu) or turn it down.
 *
 * Approving is the only thing that changes what future customers are quoted,
 * which is why it is here behind is_staff() rather than in the rider's hands.
 */
create or replace function review_menu_price_proposal(p_id uuid, p_approve boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  p menu_price_proposals%rowtype;
begin
  if not is_staff() then raise exception 'not allowed'; end if;

  select * into p from menu_price_proposals where id = p_id and status = 'pending';
  if not found then
    raise exception 'That price report has already been dealt with.';
  end if;

  if p_approve then
    update menu_items set price = p.actual_price where id = p.menu_item_id;
  end if;

  update menu_price_proposals
     set status      = case when p_approve then 'approved' else 'rejected' end,
         reviewed_by = auth.uid(),
         reviewed_at = now(),
         updated_at  = now()
   where id = p_id;
end;
$$;

revoke all on function review_menu_price_proposal(uuid, boolean) from public;
grant execute on function review_menu_price_proposal(uuid, boolean) to authenticated;
