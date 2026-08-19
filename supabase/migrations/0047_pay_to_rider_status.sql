-- Surface the payment state back to the customer.
--
-- The pay-your-rider panel kept the uploaded receipt in local component state
-- only, so a page reload made it look like nothing was ever sent. Return the
-- stored proof plus the rider's confirmation so the customer can see where
-- their payment stands.

drop function if exists order_pay_to_rider(uuid);
create function order_pay_to_rider(p_order_id uuid)
returns table(
  rider_name text,
  payout_number text,
  amount numeric,
  payment_status text,
  payment_receipt_url text,
  payment_reference text,
  payment_confirmed_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select r.name,
         r.payout_number,
         (o.goods_cost + o.delivery_fee + o.store_fee_total + o.convenience_fee) as amount,
         o.payment_status,
         o.payment_receipt_url,
         o.payment_reference,
         o.payment_confirmed_at
  from orders o
  join riders r on r.id = o.rider_id
  where o.id = p_order_id
    and o.customer_id = current_customer_id()
    and o.rider_id is not null;
$$;
revoke all on function order_pay_to_rider(uuid) from public;
grant execute on function order_pay_to_rider(uuid) to authenticated;
