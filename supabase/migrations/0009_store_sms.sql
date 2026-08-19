-- Easy Buy Delivery — optional store SMS notification support.

-- Tag each food line with its store so the notifier can group items per store
-- without extra joins. Null for free-text Pabili lines.
alter table order_items add column store_id uuid references stores (id);
create index on order_items (store_id);

-- Admin toggle: text stores their items on a new order (complements the rider
-- call; off by default to preserve the no-merchant-onboarding model).
alter table app_settings add column sms_notify_stores boolean not null default false;
