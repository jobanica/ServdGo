-- Easy Buy Delivery — per-service on/off switches.
--
-- Lets the operator disable a whole service (Food / Pabili / Padala) without
-- closing the platform. Customers see disabled services greyed out. Independent
-- of is_open (system-wide) and each store's own is_available toggle.

alter table app_settings
  add column if not exists service_food   boolean not null default true,
  add column if not exists service_pabili boolean not null default true,
  add column if not exists service_padala boolean not null default true;
