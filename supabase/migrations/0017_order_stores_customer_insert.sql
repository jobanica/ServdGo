-- Let a customer attach the store links for their own order.
--
-- createFoodOrder() writes three tables: orders, order_items, and order_stores.
-- orders (orders_customer_create) and order_items (order_items_customer_write)
-- already allow the owning customer to insert, but order_stores only had admin
-- and staff write policies — so customer checkout failed on the order_stores
-- step under RLS. Mirror the order_items customer-write rule: a customer may
-- insert an order_stores row only for an order they own.
create policy order_stores_customer_write on order_stores
  for insert with check (
    exists (
      select 1 from orders o
      where o.id = order_id and o.customer_id = current_customer_id()
    )
  );
