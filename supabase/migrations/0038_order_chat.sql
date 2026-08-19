-- In-app chat between the customer and the assigned rider for an order.

create table order_messages (
  id             uuid primary key default gen_random_uuid(),
  order_id       uuid not null references orders (id) on delete cascade,
  sender_profile uuid not null references profiles (id),
  sender_role    text not null check (sender_role in ('customer', 'rider')),
  body           text not null check (btrim(body) <> ''),
  created_at     timestamptz not null default now()
);
create index on order_messages (order_id, created_at);

grant all on order_messages to authenticated, service_role;
alter table order_messages enable row level security;

-- Only the order's customer, its assigned rider, or staff may read the thread.
create policy order_messages_read on order_messages
  for select using (
    is_staff()
    or exists (
      select 1 from orders o
      where o.id = order_id
        and (o.customer_id = current_customer_id() or o.rider_id = current_rider_id())
    )
  );

-- A participant may post as themselves.
create policy order_messages_insert on order_messages
  for insert with check (
    sender_profile = auth.uid()
    and exists (
      select 1 from orders o
      where o.id = order_id
        and (o.customer_id = current_customer_id() or o.rider_id = current_rider_id())
    )
  );

-- Live delivery of new messages (postgres_changes respects the RLS above).
alter publication supabase_realtime add table order_messages;
