-- Pabili runs can touch more than one store.
--
-- A pabili store is whatever the customer names — a sari-sari store, a market
-- stall — not a registered merchant, so it has no row in `stores` and can't go
-- through order_stores. Keep the list on the order itself.
--
-- Money is unchanged in shape: each store past the first bills one per_store_fee
-- into store_fee_total, and commission is (delivery_fee + store_fee_total) * rate,
-- exactly as for a multi-restaurant food order.

alter table orders
  add column if not exists buy_stores jsonb not null default '[]'::jsonb;

comment on column orders.buy_stores is
  'Pabili: ad-hoc stores to visit, [{name, lat, lng}]. Extra stores bill per_store_fee.';
