-- ServdGo — every row that belongs to a city says which city.
--
-- Without this nothing can be routed, priced, secured or reported per city, and
-- the commission ledger has no way of saying which operator is owed — which is
-- the whole basis of the royalty. Existing rows are backfilled to the seeded
-- first territory, so a single-city database is complete after this runs.

alter table orders            add column if not exists territory_id uuid references territories (id);
alter table riders            add column if not exists territory_id uuid references territories (id);
alter table stores            add column if not exists territory_id uuid references territories (id);
alter table commission_ledger add column if not exists territory_id uuid references territories (id);
alter table settlements       add column if not exists territory_id uuid references territories (id);
alter table service_areas     add column if not exists territory_id uuid references territories (id);

comment on column orders.territory_id is
  'The city this delivery belongs to, decided by its pickup (decision 4).';
comment on column commission_ledger.territory_id is
  'Which operator this commission is owed to. The royalty is computed from it.';

-- Backfill: one city today, so everything belongs to it.
do $$
declare v_first uuid;
begin
  select id into v_first from territories order by created_at limit 1;
  if v_first is null then
    return;
  end if;
  update orders            set territory_id = v_first where territory_id is null;
  update riders            set territory_id = v_first where territory_id is null;
  update stores            set territory_id = v_first where territory_id is null;
  update commission_ledger set territory_id = v_first where territory_id is null;
  update settlements       set territory_id = v_first where territory_id is null;
  update service_areas     set territory_id = v_first where territory_id is null;
  update profiles          set territory_id = v_first
    where territory_id is null and role::text in ('admin', 'manager', 'dispatcher', 'support');
end $$;

-- Reporting and the pool query both filter by city first, so index it there.
create index if not exists orders_territory_status_idx  on orders (territory_id, status);
create index if not exists riders_territory_idx         on riders (territory_id);
create index if not exists stores_territory_idx         on stores (territory_id);
create index if not exists commission_ledger_terr_idx   on commission_ledger (territory_id, business_day);
create index if not exists settlements_territory_idx    on settlements (territory_id, business_day);
create index if not exists service_areas_territory_idx  on service_areas (territory_id);
