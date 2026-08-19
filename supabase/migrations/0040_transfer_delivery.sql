-- Transfer deliveries: when a rider releases an active delivery it returns to
-- the pool flagged as a transfer, so other riders see it in a separate,
-- prioritised window (the items may already be bought/picked up, so these need
-- to be taken first and handed over).
--
-- The previous rider's name/contact is denormalised onto the order at release
-- time: pool riders can't read other riders' rows under RLS, and the new rider
-- needs to coordinate the hand-over.

alter table orders
  add column if not exists is_transfer            boolean not null default false,
  add column if not exists transferred_at         timestamptz,
  add column if not exists transfer_reason        text,
  add column if not exists transfer_had_goods     boolean not null default false,
  add column if not exists transferred_from_name    text,
  add column if not exists transferred_from_contact text;

create index if not exists orders_transfer_pool_idx
  on orders (is_transfer, created_at) where status = 'pending' and rider_id is null;

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
end;
$$;

revoke all on function release_order(uuid, text) from public;
grant execute on function release_order(uuid, text) to authenticated;

-- Clear the transfer flag once a new rider takes it, so the prioritised window
-- only ever lists deliveries still waiting for a taker.
create or replace function clear_transfer_on_claim()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.rider_id is not null and old.rider_id is null and new.is_transfer then
    new.is_transfer := false;
  end if;
  return new;
end;
$$;

drop trigger if exists orders_clear_transfer on orders;
create trigger orders_clear_transfer
  before update on orders
  for each row execute function clear_transfer_on_claim();

-- Drop the pre-transfer single-arg overload so every release records transfer
-- metadata (and PostgREST can't resolve to the old behaviour).
drop function if exists release_order(uuid);
