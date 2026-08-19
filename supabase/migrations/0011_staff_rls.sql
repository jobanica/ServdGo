-- Easy Buy Delivery — staff permission tier.
--
-- is_staff() = admin OR any staff role. Staff can run day-to-day operations
-- (stores, menus, riders, orders, settlements, push tokens). Sensitive things —
-- app_settings and changing anyone's role (profiles) — stay admin-only.
-- Compares role::text to avoid referencing enum labels added in 0010 in-txn.

create or replace function is_staff()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from profiles
    where id = auth.uid()
      and role::text in ('admin', 'manager', 'dispatcher', 'support')
  );
$$;

-- Operational tables: staff may read+write. (Admin ⊂ staff, so admin still works;
-- customer/rider policies added earlier remain for their own rows.)
create policy stores_staff_write on stores for all using (is_staff()) with check (is_staff());
create policy menu_categories_staff_write on menu_categories for all using (is_staff()) with check (is_staff());
create policy menu_items_staff_write on menu_items for all using (is_staff()) with check (is_staff());
create policy menu_item_options_staff_write on menu_item_options for all using (is_staff()) with check (is_staff());
create policy riders_staff_write on riders for all using (is_staff()) with check (is_staff());
create policy orders_staff_all on orders for all using (is_staff()) with check (is_staff());
create policy order_items_staff_write on order_items for all using (is_staff()) with check (is_staff());
create policy order_stores_staff_write on order_stores for all using (is_staff()) with check (is_staff());
create policy order_status_events_staff_write on order_status_events for all using (is_staff()) with check (is_staff());
create policy payments_staff_write on payments for all using (is_staff()) with check (is_staff());
create policy commission_ledger_staff_write on commission_ledger for all using (is_staff()) with check (is_staff());
create policy settlements_staff_write on settlements for all using (is_staff()) with check (is_staff());
create policy rider_push_tokens_staff_read on rider_push_tokens for select using (is_staff());

-- Staff may read all profiles (for the staff directory); only admin may write
-- roles (profiles_admin_all already covers that).
create policy profiles_staff_read on profiles for select using (is_staff());
