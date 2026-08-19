-- Three small gaps behind the rider app's queue, pool cards and earnings view.
--
-- 1. customer_name was only ever written by the food checkout, so pabili and
--    padala requests reached the pool as a bare phone number. Fill it from the
--    customer's saved name whenever the client didn't send one — riders can't
--    read the customers table (RLS), so it has to be denormalized here.
-- 2. Nothing recorded WHEN a delivery completed, so per-day earnings had to be
--    guessed from created_at. Stamp delivered_at on the transition.

-- ---------------------------------------------------------------------------
-- 1. Customer name on every order
-- ---------------------------------------------------------------------------
create or replace function fill_order_customer_name()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if nullif(btrim(coalesce(new.customer_name, '')), '') is null then
    select nullif(btrim(c.name), '')
      into new.customer_name
      from customers c
      where c.id = new.customer_id;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_order_customer_name on orders;
create trigger trg_order_customer_name
  before insert on orders
  for each row
  execute function fill_order_customer_name();

-- Existing orders (all the pabili/padala ones) get the same treatment.
update orders o
   set customer_name = nullif(btrim(c.name), '')
  from customers c
 where c.id = o.customer_id
   and nullif(btrim(coalesce(o.customer_name, '')), '') is null
   and nullif(btrim(coalesce(c.name, '')), '') is not null;

-- ---------------------------------------------------------------------------
-- 2. When the delivery actually completed
-- ---------------------------------------------------------------------------
alter table orders
  add column if not exists delivered_at timestamptz;

create or replace function stamp_delivered_at()
returns trigger
language plpgsql
as $$
begin
  if new.status = 'delivered'
     and old.status is distinct from 'delivered'
     and new.delivered_at is null then
    new.delivered_at := now();
  end if;
  return new;
end;
$$;

drop trigger if exists trg_stamp_delivered_at on orders;
create trigger trg_stamp_delivered_at
  before update on orders
  for each row
  execute function stamp_delivered_at();

-- Backfill: the commission ledger booked a row at delivery time, so its
-- created_at is the completion moment. Fall back to the delivered status event,
-- then to the order's own created_at (same-day service, so it's close enough).
update orders o
   set delivered_at = coalesce(
         (select cl.created_at from commission_ledger cl where cl.order_id = o.id),
         (select max(e.created_at) from order_status_events e
           where e.order_id = o.id and e.status = 'delivered'),
         o.created_at)
 where o.status = 'delivered'
   and o.delivered_at is null;

-- The rider earnings view filters own delivered orders by business day.
create index if not exists orders_rider_delivered_at_idx
  on orders (rider_id, delivered_at desc)
  where status = 'delivered';
