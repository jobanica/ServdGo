-- "Pay online" collects at the door, like COD, until a gateway exists.
--
-- The old rule was: on an online order the delivery + store + convenience fees
-- (and the operator's commission inside them) reach the operator directly, so
-- the rider holds nothing and owes nothing. record_commission_on_delivery
-- therefore skipped these orders entirely.
--
-- That rule was written for a payment gateway that was never wired up. Choosing
-- "Pay online" only stamps payment_status = 'paid' on the order; no money moves.
-- All four online orders in this database have no reference and no receipt. The
-- rider collected the goods cost, handed over the food, and earned nothing for
-- the trip; the operator collected no commission. Nobody was paid.
--
-- Until PayMongo (or similar) is live, an online order is a COD order: the rider
-- collects the full total at the door and settles the commission like any other.

create or replace function record_commission_on_delivery()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_day   date := (now() at time zone 'Asia/Manila')::date;
  v_share numeric;
  v_owed  numeric;
begin
  -- Every payment method now leaves the operator's cut in the rider's hands.
  if new.status = 'delivered'
     and old.status is distinct from 'delivered'
     and new.rider_id is not null then

    if coalesce(new.commission_amount, 0) > 0 then
      insert into commission_ledger (rider_id, order_id, amount, business_day, kind)
      values (new.rider_id, new.id, new.commission_amount, v_day, 'commission')
      on conflict (order_id, kind) do nothing;
    end if;

    if coalesce(new.markup_total, 0) > 0 then
      select coalesce(markup_operator_share, 1) into v_share from app_settings limit 1;
      v_owed := round(new.markup_total * coalesce(v_share, 1), 2);
      if v_owed > 0 then
        insert into commission_ledger (rider_id, order_id, amount, business_day, kind)
        values (new.rider_id, new.id, v_owed, v_day, 'markup')
        on conflict (order_id, kind) do nothing;
      end if;
    end if;
  end if;
  return new;
end;
$$;

-- A ledger that can only ever charge cannot correct itself. An adjustment is
-- the operator's own entry — the one kind that may be negative, because the
-- only reason to write one is that the rider is owed, not charging.
alter table commission_ledger drop constraint if exists commission_ledger_kind_check;
alter table commission_ledger
  add constraint commission_ledger_kind_check
  check (kind in ('commission', 'markup', 'adjustment'));

alter table commission_ledger drop constraint if exists commission_ledger_amount_check;
alter table commission_ledger
  add constraint commission_ledger_amount_check
  check (amount >= 0 or kind = 'adjustment');

-- Make good on the deliveries already run under the old rule.
--
-- On each of these the rider collected the goods cost only, so the fees they
-- should have taken home — everything the customer owed beyond the goods, less
-- the commission on it — never reached them. The customer is long gone and the
-- money was never collected from anyone, so the operator absorbs it: a credit
-- against what the rider owes, dated to the day they did the work.
insert into commission_ledger (rider_id, order_id, amount, business_day, kind)
select
  o.rider_id,
  o.id,
  -round(o.delivery_fee + o.store_fee_total + o.convenience_fee - o.commission_amount, 2),
  (o.delivered_at at time zone 'Asia/Manila')::date,
  'adjustment'
from orders o
where o.payment_method = 'online'
  and o.status = 'delivered'
  and o.rider_id is not null
  and o.delivered_at is not null
  and (o.delivery_fee + o.store_fee_total + o.convenience_fee - o.commission_amount) > 0
  -- Only the orders the old trigger skipped; anything it booked was settled normally.
  and not exists (
    select 1 from commission_ledger cl
     where cl.order_id = o.id and cl.kind = 'commission'
  )
on conflict (order_id, kind) do nothing;
