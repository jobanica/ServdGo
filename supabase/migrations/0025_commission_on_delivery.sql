-- Record a rider's commission when an order is delivered.
--
-- The rider app only wrote commission_ledger in preview mode; in live mode
-- delivering an order just changed its status, so nothing was ever booked and
-- "Commission owed" stayed ₱0.00. Add an AFTER UPDATE trigger that inserts one
-- ledger row per delivered COD/rider_qr order (online is prepaid to the
-- operator, so it books nothing). Idempotent via the unique order_id.
create or replace function record_commission_on_delivery()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status = 'delivered'
     and old.status is distinct from 'delivered'
     and new.rider_id is not null
     and coalesce(new.payment_method, 'cod') in ('cod', 'rider_qr')
     and coalesce(new.commission_amount, 0) > 0 then
    insert into commission_ledger (rider_id, order_id, amount, business_day)
    values (new.rider_id, new.id, new.commission_amount, (now() at time zone 'Asia/Manila')::date)
    on conflict (order_id) do nothing;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_commission_on_delivery on orders;
create trigger trg_commission_on_delivery
  after update on orders
  for each row
  execute function record_commission_on_delivery();

-- Backfill orders already delivered before this trigger existed.
insert into commission_ledger (rider_id, order_id, amount, business_day)
select o.rider_id, o.id, o.commission_amount, (o.created_at at time zone 'Asia/Manila')::date
from orders o
where o.status = 'delivered'
  and o.rider_id is not null
  and coalesce(o.payment_method, 'cod') in ('cod', 'rider_qr')
  and coalesce(o.commission_amount, 0) > 0
  and not exists (select 1 from commission_ledger cl where cl.order_id = o.id)
on conflict (order_id) do nothing;
