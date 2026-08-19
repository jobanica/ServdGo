-- ServdGo — the terms a city is held to, and the clock it runs on.
--
-- The config-history trigger from 0094 names these columns, so it is attached
-- here rather than there: the function body resolves them at runtime, so it
-- compiles without them but would fail on the first change.

alter table territories
  add column if not exists franchise_fee_monthly numeric(12, 2) not null default 0,
  add column if not exists grace_days integer not null default 7,
  -- Business-hours logic has to be a city's own. 'Asia/Manila' is hardcoded in
  -- thirteen places today, which is right for one country and wrong the moment
  -- it is not; new work reads this instead.
  add column if not exists timezone text not null default 'Asia/Manila',
  add constraint territories_grace_days_sane check (grace_days between 0 and 90),
  add constraint territories_franchise_fee_positive check (franchise_fee_monthly >= 0);

comment on column territories.franchise_fee_monthly is
  'Fixed monthly fee on top of the royalty share. 0 = royalty only.';
comment on column territories.grace_days is
  'Days past an overdue royalty settlement before the city is suspended automatically.';
comment on column territories.timezone is
  'IANA zone for this city''s business hours. Money still stores UTC and settles on Manila days.';

create trigger territories_config_history
  after update on territories
  for each row execute function record_territory_config_change();
