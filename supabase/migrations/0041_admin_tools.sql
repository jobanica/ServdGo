-- Admin tools: per-service convenience fees, rider suspend/delete, menu copy
-- between branches, and manual order cancellation.

-- ---------------------------------------------------------------------------
-- 1. Separate convenience fee per service (backfilled from the single fee).
-- ---------------------------------------------------------------------------
alter table app_settings
  add column if not exists convenience_fee_food   numeric(10, 2),
  add column if not exists convenience_fee_pabili numeric(10, 2),
  add column if not exists convenience_fee_padala numeric(10, 2);

update app_settings set
  convenience_fee_food   = coalesce(convenience_fee_food,   convenience_fee),
  convenience_fee_pabili = coalesce(convenience_fee_pabili, convenience_fee),
  convenience_fee_padala = coalesce(convenience_fee_padala, 0);

alter table app_settings
  alter column convenience_fee_food   set default 0,
  alter column convenience_fee_pabili set default 0,
  alter column convenience_fee_padala set default 0;

-- ---------------------------------------------------------------------------
-- 2. Rider account suspension.
-- ---------------------------------------------------------------------------
alter table riders
  add column if not exists is_suspended     boolean not null default false,
  add column if not exists suspended_at     timestamptz,
  add column if not exists suspend_reason   text;

create or replace function admin_set_rider_suspended(
  p_rider_id uuid, p_suspended boolean, p_reason text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not is_staff() then
    raise exception 'not authorised';
  end if;
  update riders set
    is_suspended   = p_suspended,
    suspended_at   = case when p_suspended then now() else null end,
    suspend_reason = case when p_suspended then nullif(btrim(p_reason), '') else null end,
    is_online      = case when p_suspended then false else is_online end
  where id = p_rider_id;
  if not found then
    raise exception 'rider not found';
  end if;
end;
$$;
revoke all on function admin_set_rider_suspended(uuid, boolean, text) from public;
grant execute on function admin_set_rider_suspended(uuid, boolean, text) to authenticated;

-- A suspended rider cannot go online.
create or replace function set_rider_online(p_online boolean)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare v_online boolean;
begin
  if p_online then
    perform 1 from riders where profile_id = auth.uid() and is_suspended;
    if found then
      raise exception 'Your account is suspended. Contact the operator.';
    end if;
  end if;
  update riders set is_online = p_online where profile_id = auth.uid()
    returning is_online into v_online;
  return v_online;
end;
$$;
revoke all on function set_rider_online(boolean) from public;
grant execute on function set_rider_online(boolean) to authenticated;

-- ...and cannot claim orders from the pool.
drop policy if exists orders_rider_claim on orders;
create policy orders_rider_claim on orders
  for update
  using (
    rider_id is null
    and status = 'pending'
    and current_rider_id() is not null
    and exists (
      select 1 from riders r
      where r.id = current_rider_id()
        and r.application_status = 'approved'
        and r.is_suspended = false
    )
    and rider_overdue_balance(current_rider_id(), (now() at time zone 'Asia/Manila')::date) = 0
  )
  with check (rider_id = current_rider_id());

-- ---------------------------------------------------------------------------
-- 3. Delete a rider who is no longer connected.
--    orders.rider_id is ON DELETE NO ACTION and commission_ledger/settlements
--    cascade, so a hard delete would destroy delivery + financial history.
--    Only riders with no order/ledger history are deleted outright; others must
--    be suspended (archived) instead.
-- ---------------------------------------------------------------------------
create or replace function admin_delete_rider(p_rider_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_active  int;
  v_orders  int;
  v_ledger  int;
begin
  if not is_staff() then
    raise exception 'not authorised';
  end if;

  select count(*) into v_active from orders
    where rider_id = p_rider_id and status not in ('delivered', 'cancelled');
  if v_active > 0 then
    return jsonb_build_object('deleted', false, 'reason', 'active_orders',
      'message', 'This rider still has an active delivery. Reassign or finish it first.');
  end if;

  select count(*) into v_orders from orders where rider_id = p_rider_id;
  select count(*) into v_ledger from commission_ledger where rider_id = p_rider_id;
  if v_orders > 0 or v_ledger > 0 then
    return jsonb_build_object('deleted', false, 'reason', 'has_history',
      'message', 'This rider has delivery/commission history, which must be kept. Suspend the account instead.');
  end if;

  delete from riders where id = p_rider_id;
  return jsonb_build_object('deleted', true);
end;
$$;
revoke all on function admin_delete_rider(uuid) from public;
grant execute on function admin_delete_rider(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 4. Copy a store's whole menu to another branch.
--    Categories are matched/created by title; items are copied with their
--    option groups. `p_replace` wipes the target menu first.
-- ---------------------------------------------------------------------------
create or replace function copy_store_menu(
  p_from_store uuid, p_to_store uuid, p_replace boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cats  int := 0;
  v_items int := 0;
  v_opts  int := 0;
  r_cat   record;
  r_item  record;
  v_cat_id  uuid;
  v_item_id uuid;
begin
  if not is_staff() then
    raise exception 'not authorised';
  end if;
  if p_from_store = p_to_store then
    raise exception 'Source and target branch must be different.';
  end if;

  if p_replace then
    delete from menu_items where store_id = p_to_store;
    delete from menu_categories where store_id = p_to_store;
  end if;

  for r_cat in
    select * from menu_categories where store_id = p_from_store order by sort_order
  loop
    select id into v_cat_id from menu_categories
      where store_id = p_to_store and title = r_cat.title limit 1;
    if v_cat_id is null then
      insert into menu_categories (store_id, title, sort_order)
        values (p_to_store, r_cat.title, r_cat.sort_order)
        returning id into v_cat_id;
      v_cats := v_cats + 1;
    end if;

    for r_item in
      select * from menu_items where store_id = p_from_store and category_id = r_cat.id
    loop
      insert into menu_items (store_id, category_id, name, description, price, is_available, image_url)
        values (p_to_store, v_cat_id, r_item.name, r_item.description, r_item.price,
                r_item.is_available, r_item.image_url)
        returning id into v_item_id;
      v_items := v_items + 1;

      insert into menu_item_options (menu_item_id, group_name, option_name, price_delta, required)
        select v_item_id, group_name, option_name, price_delta, required
        from menu_item_options where menu_item_id = r_item.id;
      get diagnostics v_opts = row_count;
    end loop;

    v_cat_id := null;
  end loop;

  -- Items with no category.
  for r_item in
    select * from menu_items where store_id = p_from_store and category_id is null
  loop
    insert into menu_items (store_id, category_id, name, description, price, is_available, image_url)
      values (p_to_store, null, r_item.name, r_item.description, r_item.price,
              r_item.is_available, r_item.image_url)
      returning id into v_item_id;
    v_items := v_items + 1;
    insert into menu_item_options (menu_item_id, group_name, option_name, price_delta, required)
      select v_item_id, group_name, option_name, price_delta, required
      from menu_item_options where menu_item_id = r_item.id;
  end loop;

  return jsonb_build_object('categories', v_cats, 'items', v_items);
end;
$$;
revoke all on function copy_store_menu(uuid, uuid, boolean) from public;
grant execute on function copy_store_menu(uuid, uuid, boolean) to authenticated;

-- ---------------------------------------------------------------------------
-- 5. Manual order cancellation by an admin (any status except delivered).
-- ---------------------------------------------------------------------------
create or replace function admin_cancel_order(p_order_id uuid, p_reason text default null)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare n int;
begin
  if not is_staff() then
    raise exception 'not authorised';
  end if;
  update orders set
    status = 'cancelled',
    notes  = case when nullif(btrim(p_reason), '') is null then notes
                  else coalesce(notes || E'\n', '') || 'Cancelled by admin: ' || btrim(p_reason) end
  where id = p_order_id and status <> 'delivered';
  get diagnostics n = row_count;
  if n > 0 then
    insert into order_status_events (order_id, status) values (p_order_id, 'cancelled');
  end if;
  return n > 0;
end;
$$;
revoke all on function admin_cancel_order(uuid, text) from public;
grant execute on function admin_cancel_order(uuid, text) to authenticated;
