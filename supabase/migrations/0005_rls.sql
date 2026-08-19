-- Easy Buy Delivery — Row Level Security
--
-- Roles resolve from profiles.role. Admin uses a helper predicate so policies
-- stay readable. Customers see their own orders; riders see the open pool plus
-- their own; admin sees everything.

-- Helper: is the current user an admin?
create or replace function is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from profiles where id = auth.uid() and role = 'admin'
  );
$$;

-- Helper: the rider row owned by the current user (if any).
create or replace function current_rider_id()
returns uuid language sql stable security definer set search_path = public as $$
  select id from riders where profile_id = auth.uid();
$$;

-- Helper: the customer row owned by the current user (if any).
create or replace function current_customer_id()
returns uuid language sql stable security definer set search_path = public as $$
  select id from customers where profile_id = auth.uid();
$$;

-- Enable RLS everywhere.
alter table profiles            enable row level security;
alter table stores              enable row level security;
alter table menu_categories     enable row level security;
alter table menu_items          enable row level security;
alter table menu_item_options   enable row level security;
alter table customers           enable row level security;
alter table customer_addresses  enable row level security;
alter table riders              enable row level security;
alter table app_settings        enable row level security;
alter table orders              enable row level security;
alter table order_stores        enable row level security;
alter table order_items         enable row level security;
alter table order_status_events enable row level security;
alter table payments            enable row level security;
alter table rider_locations     enable row level security;
alter table commission_ledger   enable row level security;
alter table settlements         enable row level security;

-- ---------------------------------------------------------------------------
-- Profiles: a user reads/updates their own; admin sees all.
-- ---------------------------------------------------------------------------
create policy profiles_self_read on profiles
  for select using (id = auth.uid() or is_admin());
create policy profiles_self_update on profiles
  for update using (id = auth.uid());
create policy profiles_admin_all on profiles
  for all using (is_admin()) with check (is_admin());

-- ---------------------------------------------------------------------------
-- Stores & menus: everyone can read available stores; admin writes.
-- ---------------------------------------------------------------------------
create policy stores_public_read on stores
  for select using (is_available or is_admin());
create policy stores_admin_write on stores
  for all using (is_admin()) with check (is_admin());

create policy menu_categories_public_read on menu_categories
  for select using (true);
create policy menu_categories_admin_write on menu_categories
  for all using (is_admin()) with check (is_admin());

create policy menu_items_public_read on menu_items
  for select using (true);
create policy menu_items_admin_write on menu_items
  for all using (is_admin()) with check (is_admin());

create policy menu_item_options_public_read on menu_item_options
  for select using (true);
create policy menu_item_options_admin_write on menu_item_options
  for all using (is_admin()) with check (is_admin());

-- ---------------------------------------------------------------------------
-- Customers: own their row; admin sees all.
-- ---------------------------------------------------------------------------
create policy customers_self on customers
  for all using (profile_id = auth.uid() or is_admin())
  with check (profile_id = auth.uid() or is_admin());

create policy customer_addresses_self on customer_addresses
  for all using (customer_id = current_customer_id() or is_admin())
  with check (customer_id = current_customer_id() or is_admin());

-- ---------------------------------------------------------------------------
-- Riders: read own row; apply (insert own); admin approves/updates.
-- ---------------------------------------------------------------------------
create policy riders_self_read on riders
  for select using (profile_id = auth.uid() or is_admin());
create policy riders_self_apply on riders
  for insert with check (profile_id = auth.uid());
create policy riders_admin_write on riders
  for all using (is_admin()) with check (is_admin());

-- ---------------------------------------------------------------------------
-- App settings: readable by all; admin writes.
-- ---------------------------------------------------------------------------
create policy app_settings_read on app_settings
  for select using (true);
create policy app_settings_admin_write on app_settings
  for all using (is_admin()) with check (is_admin());

-- ---------------------------------------------------------------------------
-- Orders: customer owns theirs; rider sees the open pool + their own; admin all.
-- ---------------------------------------------------------------------------
create policy orders_customer_read on orders
  for select using (customer_id = current_customer_id());
create policy orders_customer_create on orders
  for insert with check (customer_id = current_customer_id());

-- Riders read unassigned pending orders (the pool) and orders they own.
create policy orders_rider_read on orders
  for select using (
    current_rider_id() is not null
    and (rider_id = current_rider_id() or (rider_id is null and status = 'pending'))
  );
-- Riders update only their own orders (status, actual amount, etc.).
create policy orders_rider_update on orders
  for update using (rider_id = current_rider_id())
  with check (rider_id = current_rider_id());

create policy orders_admin_all on orders
  for all using (is_admin()) with check (is_admin());

-- ---------------------------------------------------------------------------
-- Order children: visible if the parent order is visible.
-- ---------------------------------------------------------------------------
create policy order_stores_read on order_stores
  for select using (
    exists (select 1 from orders o where o.id = order_id)  -- gated by orders RLS
  );
create policy order_stores_admin_write on order_stores
  for all using (is_admin()) with check (is_admin());

create policy order_items_read on order_items
  for select using (exists (select 1 from orders o where o.id = order_id));
create policy order_items_customer_write on order_items
  for insert with check (
    exists (select 1 from orders o
            where o.id = order_id and o.customer_id = current_customer_id())
  );
create policy order_items_admin_write on order_items
  for all using (is_admin()) with check (is_admin());

create policy order_status_events_read on order_status_events
  for select using (exists (select 1 from orders o where o.id = order_id));
create policy order_status_events_insert on order_status_events
  for insert with check (
    is_admin()
    or exists (select 1 from orders o
               where o.id = order_id and o.rider_id = current_rider_id())
  );

create policy payments_read on payments
  for select using (exists (select 1 from orders o where o.id = order_id));
create policy payments_admin_write on payments
  for all using (is_admin()) with check (is_admin());

-- ---------------------------------------------------------------------------
-- Rider locations: the assigned rider writes; parties to the order read.
-- ---------------------------------------------------------------------------
create policy rider_locations_write on rider_locations
  for insert with check (rider_id = current_rider_id());
create policy rider_locations_read on rider_locations
  for select using (
    is_admin()
    or rider_id = current_rider_id()
    or exists (select 1 from orders o
               where o.id = order_id and o.customer_id = current_customer_id())
  );

-- ---------------------------------------------------------------------------
-- Settlement: rider reads own ledger/settlements; admin manages.
-- ---------------------------------------------------------------------------
create policy commission_ledger_rider_read on commission_ledger
  for select using (rider_id = current_rider_id() or is_admin());
create policy commission_ledger_admin_write on commission_ledger
  for all using (is_admin()) with check (is_admin());

create policy settlements_rider_read on settlements
  for select using (rider_id = current_rider_id() or is_admin());
create policy settlements_rider_create on settlements
  for insert with check (rider_id = current_rider_id() or is_admin());
create policy settlements_admin_write on settlements
  for all using (is_admin()) with check (is_admin());
