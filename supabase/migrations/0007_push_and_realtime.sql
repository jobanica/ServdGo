-- Easy Buy Delivery — push tokens + realtime on the order queue.

-- Device push tokens per rider (FCM/APNs). One rider may have several devices.
create table rider_push_tokens (
  id         uuid primary key default gen_random_uuid(),
  rider_id   uuid not null references riders (id) on delete cascade,
  token      text not null,
  platform   text not null default 'android',
  updated_at timestamptz not null default now(),
  unique (rider_id, token)
);
create index on rider_push_tokens (rider_id);

grant all on rider_push_tokens to anon, authenticated, service_role;

alter table rider_push_tokens enable row level security;

-- A rider manages only their own device tokens; admin can read all.
create policy rider_push_tokens_self on rider_push_tokens
  for all using (rider_id = current_rider_id() or is_admin())
  with check (rider_id = current_rider_id() or is_admin());

-- Broadcast order-queue changes over Realtime so riders see incoming orders
-- live (postgres_changes on INSERT). Broadcast channels used for live tracking
-- don't need this; postgres_changes does.
alter publication supabase_realtime add table orders;
