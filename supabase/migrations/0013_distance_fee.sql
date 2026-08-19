-- Easy Buy Delivery — distance-based delivery-fee rate.
--
-- When delivery_fee_model = 'per_km', the fee is computed from how far the
-- store's pinned location is from the customer's drop-off:
--
--   fee = base_fare + per_km × max(0, distance_km − base_km)
--
-- base_fare is the floor (covers everything within base_km). Charged on the
-- delivery fee only — goods and per-store add-ons are handled separately.

alter table app_settings
  add column if not exists delivery_base_fare numeric(10, 2) not null default 50,
  add column if not exists delivery_base_km   numeric(10, 2) not null default 2,
  add column if not exists delivery_per_km    numeric(10, 2) not null default 10;
