-- Revert order_pay_to_rider to a rider-only lookup. The previous version joined
-- app_settings for an operator fallback, but that table isn't visible inside the
-- definer function's role (RLS), which nulled the whole result. The operator
-- fallback is handled client-side (the app can read app_settings directly).
drop function if exists order_pay_to_rider(uuid);
create function order_pay_to_rider(p_order_id uuid)
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
