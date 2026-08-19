-- Per-store daily opening hours. When both are set, the store auto-opens and
-- auto-closes on this schedule (evaluated in Philippine time by the apps). NULL
-- bounds mean no schedule — the store follows only its is_available toggle.
alter table stores
  add column if not exists opens_at  time,
  add column if not exists closes_at time;
