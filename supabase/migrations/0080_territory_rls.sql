-- ServdGo — an operator reads their own city and nothing else.
--
-- Until now every staff predicate was is_staff() or is_admin() with no notion of
-- where. Under a franchise that means a Cebu operator reading Davao's orders,
-- riders, customers and ledger. This migration puts a territory on each of those
-- predicates and leaves customer and rider ownership rules exactly as they were.
--
-- The franchisor is the one role that sees across cities, and is_franchisor() is
-- checked first in every helper so their access never depends on carrying a
-- territory of their own.

-- ---------------------------------------------------------------------------
-- Helpers. Each answers "may the caller act on a row in this city?", by the
-- city itself or by walking to whatever parent carries it.
-- ---------------------------------------------------------------------------
create or replace function admin_sees(p_territory uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select is_franchisor()
      or (is_admin() and (p_territory is null or p_territory = current_territory_id()));
$$;

create or replace function staff_sees_order(p_order uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select staff_sees((select o.territory_id from orders o where o.id = p_order));
$$;

create or replace function admin_sees_order(p_order uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select admin_sees((select o.territory_id from orders o where o.id = p_order));
$$;

create or replace function staff_sees_store(p_store uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select staff_sees((select s.territory_id from stores s where s.id = p_store));
$$;

create or replace function admin_sees_store(p_store uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select admin_sees((select s.territory_id from stores s where s.id = p_store));
$$;

create or replace function staff_sees_menu_item(p_item uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select staff_sees((select s.territory_id from menu_items m
                       join stores s on s.id = m.store_id where m.id = p_item));
$$;

create or replace function staff_sees_rider(p_rider uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select staff_sees((select r.territory_id from riders r where r.id = p_rider));
$$;

create or replace function admin_sees_rider(p_rider uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select admin_sees((select r.territory_id from riders r where r.id = p_rider));
$$;

-- A rider's own city, for the pool query. Read from the rider row rather than
-- the profile, so a rider record is the single source of where they work.
create or replace function current_rider_territory_id()
returns uuid language sql stable security definer set search_path = public as $$
  select r.territory_id from riders r where r.id = current_rider_id();
$$;

do $$
declare fn text;
begin
  foreach fn in array array[
    'admin_sees(uuid)', 'staff_sees_order(uuid)', 'admin_sees_order(uuid)',
    'staff_sees_store(uuid)', 'admin_sees_store(uuid)', 'staff_sees_menu_item(uuid)',
    'staff_sees_rider(uuid)', 'admin_sees_rider(uuid)', 'current_rider_territory_id()'
  ] loop
    execute format('revoke all on function %s from public', fn);
    execute format('grant execute on function %s to anon, authenticated', fn);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Orders. The pool is the sharpest edge: a rider must not see, or be able to
-- claim, work in another operator's city.
-- ---------------------------------------------------------------------------
drop policy if exists orders_admin_all on orders;
create policy orders_admin_all on orders
  for all using (admin_sees(territory_id)) with check (admin_sees(territory_id));

drop policy if exists orders_staff_all on orders;
create policy orders_staff_all on orders
  for all using (staff_sees(territory_id)) with check (staff_sees(territory_id));

drop policy if exists orders_rider_read on orders;
create policy orders_rider_read on orders
  for select using (
    current_rider_id() is not null
    and (
      rider_id = current_rider_id()               -- their own work, always
      or (rider_id is null and status = 'pending'
          and territory_id is not distinct from current_rider_territory_id())
    )
  );

drop policy if exists orders_rider_claim on orders;
create policy orders_rider_claim on orders
  for update using (
    rider_id is null
    and status = 'pending'
    and current_rider_id() is not null
    and territory_id is not distinct from current_rider_territory_id()
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
-- Riders, stores, ledger, settlements, service areas.
-- ---------------------------------------------------------------------------
drop policy if exists riders_admin_write on riders;
create policy riders_admin_write on riders
  for all using (admin_sees(territory_id)) with check (admin_sees(territory_id));

drop policy if exists riders_staff_write on riders;
create policy riders_staff_write on riders
  for all using (staff_sees(territory_id)) with check (staff_sees(territory_id));

drop policy if exists riders_self_read on riders;
create policy riders_self_read on riders
  for select using (profile_id = auth.uid() or admin_sees(territory_id));

drop policy if exists stores_admin_write on stores;
create policy stores_admin_write on stores
  for all using (admin_sees(territory_id)) with check (admin_sees(territory_id));

drop policy if exists stores_staff_write on stores;
create policy stores_staff_write on stores
  for all using (staff_sees(territory_id)) with check (staff_sees(territory_id));

-- Browsing stays open: a customer is not bound to a city, and ordering outside
-- one is already refused by the radius guard in 0079.
drop policy if exists stores_public_read on stores;
create policy stores_public_read on stores
  for select using (is_available or admin_sees(territory_id));

drop policy if exists commission_ledger_admin_write on commission_ledger;
create policy commission_ledger_admin_write on commission_ledger
  for all using (admin_sees(territory_id)) with check (admin_sees(territory_id));

drop policy if exists commission_ledger_staff_write on commission_ledger;
create policy commission_ledger_staff_write on commission_ledger
  for all using (staff_sees(territory_id)) with check (staff_sees(territory_id));

drop policy if exists commission_ledger_rider_read on commission_ledger;
create policy commission_ledger_rider_read on commission_ledger
  for select using (rider_id = current_rider_id() or admin_sees(territory_id));

drop policy if exists settlements_admin_write on settlements;
create policy settlements_admin_write on settlements
  for all using (admin_sees(territory_id)) with check (admin_sees(territory_id));

drop policy if exists settlements_staff_write on settlements;
create policy settlements_staff_write on settlements
  for all using (staff_sees(territory_id)) with check (staff_sees(territory_id));

drop policy if exists settlements_rider_read on settlements;
create policy settlements_rider_read on settlements
  for select using (rider_id = current_rider_id() or admin_sees(territory_id));

drop policy if exists settlements_rider_create on settlements;
create policy settlements_rider_create on settlements
  for insert with check (rider_id = current_rider_id() or admin_sees(territory_id));

drop policy if exists service_areas_public_read on service_areas;
create policy service_areas_public_read on service_areas
  for select using (is_active or staff_sees(territory_id));

drop policy if exists service_areas_staff_write on service_areas;
create policy service_areas_staff_write on service_areas
  for all using (staff_sees(territory_id)) with check (staff_sees(territory_id));

-- ---------------------------------------------------------------------------
-- Everything hanging off an order, a store or a rider inherits their city.
-- ---------------------------------------------------------------------------
drop policy if exists order_items_admin_write on order_items;
create policy order_items_admin_write on order_items
  for all using (admin_sees_order(order_id)) with check (admin_sees_order(order_id));

drop policy if exists order_items_staff_write on order_items;
create policy order_items_staff_write on order_items
  for all using (staff_sees_order(order_id)) with check (staff_sees_order(order_id));

drop policy if exists order_stores_admin_write on order_stores;
create policy order_stores_admin_write on order_stores
  for all using (admin_sees_order(order_id)) with check (admin_sees_order(order_id));

drop policy if exists order_stores_staff_write on order_stores;
create policy order_stores_staff_write on order_stores
  for all using (staff_sees_order(order_id)) with check (staff_sees_order(order_id));

drop policy if exists order_addons_staff on order_addons;
create policy order_addons_staff on order_addons
  for all using (staff_sees_order(order_id)) with check (staff_sees_order(order_id));

drop policy if exists order_addon_items_party on order_addon_items;
create policy order_addon_items_party on order_addon_items
  for select using (exists (
    select 1 from order_addons a join orders o on o.id = a.order_id
    where a.id = order_addon_items.addon_id
      and (o.customer_id = current_customer_id()
           or o.rider_id = current_rider_id()
           or staff_sees(o.territory_id))
  ));

drop policy if exists payments_admin_write on payments;
create policy payments_admin_write on payments
  for all using (admin_sees_order(order_id)) with check (admin_sees_order(order_id));

drop policy if exists payments_staff_write on payments;
create policy payments_staff_write on payments
  for all using (staff_sees_order(order_id)) with check (staff_sees_order(order_id));

drop policy if exists order_status_events_staff_write on order_status_events;
create policy order_status_events_staff_write on order_status_events
  for all using (staff_sees_order(order_id)) with check (staff_sees_order(order_id));

drop policy if exists order_status_events_insert on order_status_events;
create policy order_status_events_insert on order_status_events
  for insert with check (
    admin_sees_order(order_id)
    or exists (select 1 from orders o where o.id = order_status_events.order_id
                 and o.rider_id = current_rider_id())
  );

drop policy if exists order_messages_read on order_messages;
create policy order_messages_read on order_messages
  for select using (
    staff_sees_order(order_id)
    or exists (select 1 from orders o where o.id = order_messages.order_id
                 and (o.customer_id = current_customer_id() or o.rider_id = current_rider_id()))
  );

drop policy if exists order_pin_corrections_read on order_pin_corrections;
create policy order_pin_corrections_read on order_pin_corrections
  for select using (rider_id = current_rider_id() or admin_sees_order(order_id));

drop policy if exists rider_request_events_admin_read on rider_request_events;
create policy rider_request_events_admin_read on rider_request_events
  for select using (admin_sees_rider(rider_id));

drop policy if exists rider_locations_read on rider_locations;
create policy rider_locations_read on rider_locations
  for select using (
    admin_sees_rider(rider_id)
    or rider_id = current_rider_id()
    or exists (select 1 from orders o where o.id = rider_locations.order_id
                 and o.customer_id = current_customer_id())
  );

drop policy if exists rider_push_tokens_self on rider_push_tokens;
create policy rider_push_tokens_self on rider_push_tokens
  for all using (rider_id = current_rider_id() or admin_sees_rider(rider_id))
  with check (rider_id = current_rider_id() or admin_sees_rider(rider_id));

drop policy if exists rider_push_tokens_staff_read on rider_push_tokens;
create policy rider_push_tokens_staff_read on rider_push_tokens
  for select using (staff_sees_rider(rider_id));

drop policy if exists menu_categories_admin_write on menu_categories;
create policy menu_categories_admin_write on menu_categories
  for all using (admin_sees_store(store_id)) with check (admin_sees_store(store_id));

drop policy if exists menu_categories_staff_write on menu_categories;
create policy menu_categories_staff_write on menu_categories
  for all using (staff_sees_store(store_id)) with check (staff_sees_store(store_id));

drop policy if exists menu_items_admin_write on menu_items;
create policy menu_items_admin_write on menu_items
  for all using (admin_sees_store(store_id)) with check (admin_sees_store(store_id));

drop policy if exists menu_items_staff_write on menu_items;
create policy menu_items_staff_write on menu_items
  for all using (staff_sees_store(store_id)) with check (staff_sees_store(store_id));

drop policy if exists option_groups_staff_write on menu_item_option_groups;
create policy option_groups_staff_write on menu_item_option_groups
  for all using (staff_sees_menu_item(menu_item_id))
  with check (staff_sees_menu_item(menu_item_id));

drop policy if exists menu_item_options_admin_write on menu_item_options;
create policy menu_item_options_admin_write on menu_item_options
  for all using (staff_sees_menu_item(menu_item_id))
  with check (staff_sees_menu_item(menu_item_id));

drop policy if exists menu_item_options_staff_write on menu_item_options;
create policy menu_item_options_staff_write on menu_item_options
  for all using (staff_sees_menu_item(menu_item_id))
  with check (staff_sees_menu_item(menu_item_id));

drop policy if exists menu_price_proposals_read on menu_price_proposals;
create policy menu_price_proposals_read on menu_price_proposals
  for select using (last_rider_id = current_rider_id() or staff_sees_store(store_id));

drop policy if exists menu_price_proposals_staff_write on menu_price_proposals;
create policy menu_price_proposals_staff_write on menu_price_proposals
  for all using (staff_sees_store(store_id)) with check (staff_sees_store(store_id));

-- ---------------------------------------------------------------------------
-- People. Staff read the profiles of their own city; the franchisor reads all.
-- A customer is not a member of any city, so their profile stays readable to
-- staff — otherwise nobody could work an order placed by a visitor.
-- ---------------------------------------------------------------------------
drop policy if exists profiles_admin_all on profiles;
create policy profiles_admin_all on profiles
  for all using (admin_sees(territory_id)) with check (admin_sees(territory_id));

drop policy if exists profiles_staff_read on profiles;
create policy profiles_staff_read on profiles
  for select using (
    staff_sees(territory_id)
    or (is_staff() and role::text = 'customer')
  );

drop policy if exists profiles_self_read on profiles;
create policy profiles_self_read on profiles
  for select using (id = auth.uid() or admin_sees(territory_id)
                    or (is_admin() and role::text = 'customer'));

drop policy if exists app_installs_staff_read on app_installs;
create policy app_installs_staff_read on app_installs
  for select using (is_staff());
