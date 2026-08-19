-- Pabili: the goods have to be part of what the customer pays.
--
-- goods_cost only gets filled in once the rider saves the receipt total, so
-- until then every customer-facing total showed just the delivery + convenience
-- fee. Fall back to the estimate the customer already agreed to, and keep the
-- rider's photo of the store receipt so the amount is auditable.

alter table orders
  add column if not exists goods_receipt_url text;

-- The goods figure to charge for an order: the rider's receipt total once it
-- exists, otherwise the customer's own estimate for a pabili run.
create or replace function order_goods_amount(o orders)
returns numeric
language sql
immutable
as $$
  select case
    when o.service_type = 'pabili'
      then coalesce(nullif(o.goods_cost, 0), o.actual_amount, o.estimated_amount, 0)
    else coalesce(o.goods_cost, 0)
  end;
$$;

drop function if exists order_pay_to_rider(uuid);
create function order_pay_to_rider(p_order_id uuid)
returns table(
  rider_name text,
  payout_number text,
  amount numeric,
  goods_amount numeric,
  goods_is_final boolean,
  goods_receipt_url text,
  delivery_fee numeric,
  store_fee_total numeric,
  convenience_fee numeric,
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
         (order_goods_amount(o) + o.delivery_fee + o.store_fee_total + o.convenience_fee) as amount,
         order_goods_amount(o) as goods_amount,
         -- Pabili stays provisional until the rider records the real receipt.
         (o.service_type <> 'pabili' or o.actual_amount is not null) as goods_is_final,
         o.goods_receipt_url,
         o.delivery_fee,
         o.store_fee_total,
         o.convenience_fee,
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

-- Riders upload the store receipt photo under pabili-receipts/ in the public
-- store-assets bucket (same pattern as settlement and payment receipts).
drop policy if exists pabili_receipt_insert on storage.objects;
create policy pabili_receipt_insert on storage.objects
  for insert to authenticated
  with check (bucket_id = 'store-assets' and (storage.foldername(name))[1] = 'pabili-receipts');

drop policy if exists pabili_receipt_update on storage.objects;
create policy pabili_receipt_update on storage.objects
  for update to authenticated
  using (bucket_id = 'store-assets' and (storage.foldername(name))[1] = 'pabili-receipts')
  with check (bucket_id = 'store-assets' and (storage.foldername(name))[1] = 'pabili-receipts');
