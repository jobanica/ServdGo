-- Denormalized customer name on the order, so riders can see who they're
-- delivering to. The customers table isn't readable by riders (RLS), and it's
-- consistent with customer_contact already living on the order. Optional.
alter table orders
  add column if not exists customer_name text;
