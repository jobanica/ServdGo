-- "Send to someone else" orders: a separate recipient, and a way for the
-- sender to pay the assigned rider by GCash (recipient pays nothing).

alter table orders
  add column if not exists recipient_name    text,
  add column if not exists recipient_contact text;

-- Expose the assigned rider's GCash/Maya payout details to the order's own
-- customer (sender) so they can send payment. SECURITY DEFINER — returns data
-- only for an order the caller placed, and only once a rider is assigned.
create or replace function order_pay_to_rider(p_order_id uuid)
returns table(rider_name text, payout_number text, amount numeric)
language sql
stable
security definer
set search_path = public
as $$
  select r.name,
         r.payout_number,
         (o.goods_cost + o.delivery_fee + o.store_fee_total + o.convenience_fee) as amount
  from orders o
  join riders r on r.id = o.rider_id
  where o.id = p_order_id
    and o.customer_id = current_customer_id()
    and o.rider_id is not null;
$$;

revoke all on function order_pay_to_rider(uuid) from public;
grant execute on function order_pay_to_rider(uuid) to authenticated;
