-- Let the sender pay the rider and upload proof for their own order.

alter table orders
  add column if not exists payment_receipt_url text,
  add column if not exists payment_reference   text;

-- Pay-to details for the order's own customer, with an operator-GCash fallback
-- when the assigned rider has no payout number on file.
drop function if exists order_pay_to_rider(uuid);
create function order_pay_to_rider(p_order_id uuid)
returns table(rider_name text, payout_number text, amount numeric, is_operator boolean)
language sql
stable
security definer
set search_path = public
as $$
  select
    case when nullif(btrim(r.payout_number), '') is not null then r.name
         else coalesce(s.settlement_gcash_name, r.name) end as rider_name,
    coalesce(nullif(btrim(r.payout_number), ''), s.settlement_gcash_number) as payout_number,
    (o.goods_cost + o.delivery_fee + o.store_fee_total + o.convenience_fee) as amount,
    (nullif(btrim(r.payout_number), '') is null) as is_operator
  from orders o
  join riders r on r.id = o.rider_id
  cross join lateral (select settlement_gcash_number, settlement_gcash_name from app_settings limit 1) s
  where o.id = p_order_id
    and o.customer_id = current_customer_id()
    and o.rider_id is not null;
$$;
revoke all on function order_pay_to_rider(uuid) from public;
grant execute on function order_pay_to_rider(uuid) to authenticated;

-- The customer records proof of payment (receipt + reference) on their own order.
create or replace function set_order_payment_proof(p_order_id uuid, p_receipt_url text, p_reference text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update orders set
    payment_receipt_url = coalesce(nullif(btrim(p_receipt_url), ''), payment_receipt_url),
    payment_reference   = coalesce(nullif(btrim(p_reference), ''), payment_reference)
  where id = p_order_id and customer_id = current_customer_id();
  if not found then
    raise exception 'order not found';
  end if;
end;
$$;
revoke all on function set_order_payment_proof(uuid, text, text) from public;
grant execute on function set_order_payment_proof(uuid, text, text) to authenticated;

-- Customers upload payment receipts into store-assets/payment-receipts/.
drop policy if exists payment_receipt_insert on storage.objects;
create policy payment_receipt_insert on storage.objects
  for insert to authenticated
  with check (bucket_id = 'store-assets' and (storage.foldername(name))[1] = 'payment-receipts');
drop policy if exists payment_receipt_update on storage.objects;
create policy payment_receipt_update on storage.objects
  for update to authenticated
  using (bucket_id = 'store-assets' and (storage.foldername(name))[1] = 'payment-receipts')
  with check (bucket_id = 'store-assets' and (storage.foldername(name))[1] = 'payment-receipts');
