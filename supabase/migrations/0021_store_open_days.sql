-- Which weekdays a store is open (0=Sunday … 6=Saturday). NULL means every day
-- (backward-compatible with existing rows). Combined with opens_at/closes_at,
-- this lets a store be closed on specific days, e.g. Sundays.
alter table stores
  add column if not exists open_days smallint[];
