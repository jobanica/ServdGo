-- History of riders turning work down.
--
-- Two things were invisible to the operator. A pass in the pool was written to
-- the rider's own phone and nowhere else, so nobody could tell a rider who
-- takes what comes from one who skips everything but the big-ticket runs. And
-- a transfer only ever overwrote transferred_from_* on the order itself — the
-- second transfer erased the first, and the rider who let go was recorded by
-- name, not by id.
--
-- One row per event, kept whatever happens to the order afterwards.
create table if not exists rider_request_events (
  id         uuid primary key default gen_random_uuid(),
  rider_id   uuid not null references riders (id) on delete cascade,
  order_id   uuid not null references orders (id) on delete cascade,
  kind       text not null check (kind in ('declined', 'transferred')),
  reason     text,
  /** Transfers only: the goods were already bought when they let go. */
  had_goods  boolean not null default false,
  created_at timestamptz not null default now(),
  -- Passing on the same request twice is one decline, not two.
  unique (rider_id, order_id, kind)
);

create index if not exists rider_request_events_rider_idx
  on rider_request_events (rider_id, created_at desc);
create index if not exists rider_request_events_recent_idx
  on rider_request_events (created_at desc);

alter table rider_request_events enable row level security;

-- Riders see their own history (the pool uses it to keep passes stuck across
-- devices); staff see everyone's. Writes go through the RPCs below only.
drop policy if exists rider_request_events_self_read on rider_request_events;
create policy rider_request_events_self_read on rider_request_events
  for select using (rider_id = current_rider_id());

drop policy if exists rider_request_events_admin_read on rider_request_events;
create policy rider_request_events_admin_read on rider_request_events
  for select using (is_admin());

grant select on rider_request_events to authenticated;

-- ---------------------------------------------------------------------------
-- A rider passes on a pool request.
-- ---------------------------------------------------------------------------
create or replace function rider_decline_order(p_order_id uuid, p_reason text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rider uuid := current_rider_id();
begin
  if v_rider is null then
    raise exception 'Only a rider can decline a request.';
  end if;
  -- Only pool requests can be passed on; walking away from a delivery you
  -- already accepted is a transfer, which goes through release_order.
  if not exists (select 1 from orders where id = p_order_id and rider_id is null and status = 'pending') then
    return;
  end if;
  insert into rider_request_events (rider_id, order_id, kind, reason)
  values (v_rider, p_order_id, 'declined', nullif(btrim(p_reason), ''))
  on conflict (rider_id, order_id, kind) do nothing;
end;
$$;

revoke all on function rider_decline_order(uuid, text) from public;
grant execute on function rider_decline_order(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- Record the transfer too. Same behaviour as before, plus one history row.
-- ---------------------------------------------------------------------------
create or replace function release_order(p_order_id uuid, p_reason text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rider   uuid := current_rider_id();
  v_name    text;
  v_contact text;
  v_status  order_status;
begin
  select name, mobile_number into v_name, v_contact from riders where id = v_rider;

  select status into v_status from orders
    where id = p_order_id and rider_id = v_rider and status not in ('delivered', 'cancelled');
  if not found then
    raise exception 'You can only release an active order you are handling.';
  end if;

  update orders set
    rider_id  = null,
    status    = 'pending',
    is_transfer              = true,
    transferred_at           = now(),
    transfer_reason          = nullif(btrim(p_reason), ''),
    transfer_had_goods       = (v_status in ('picked_up', 'on_the_way')),
    transferred_from_name    = v_name,
    transferred_from_contact = v_contact
  where id = p_order_id;

  insert into order_status_events (order_id, status) values (p_order_id, 'pending');

  insert into rider_request_events (rider_id, order_id, kind, reason, had_goods)
  values (v_rider, p_order_id, 'transferred', nullif(btrim(p_reason), ''),
          v_status in ('picked_up', 'on_the_way'))
  on conflict (rider_id, order_id, kind) do update
    set reason = excluded.reason, had_goods = excluded.had_goods, created_at = now();
end;
$$;

revoke all on function release_order(uuid, text) from public;
grant execute on function release_order(uuid, text) to authenticated;

-- Backfill the transfers already on record. Only the most recent one per order
-- survived on the order row, and only by name — match it back to a rider where
-- the name is unambiguous.
with unique_names as (
  -- No min(uuid) in Postgres; the group has exactly one row anyway.
  select name, (array_agg(id))[1] as rider_id from riders group by name having count(*) = 1
)
insert into rider_request_events (rider_id, order_id, kind, reason, had_goods, created_at)
select u.rider_id, o.id, 'transferred', o.transfer_reason, o.transfer_had_goods,
       coalesce(o.transferred_at, o.created_at)
from orders o
join unique_names u on u.name = o.transferred_from_name
where o.transferred_from_name is not null
on conflict (rider_id, order_id, kind) do nothing;
