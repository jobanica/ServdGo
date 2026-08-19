-- ServdGo — a city cannot go live until it is actually ready.
--
-- approve_territory() already refused a city with no operator, no boundary or no
-- payout details. Those are the things the database can check for itself. The
-- rest of readiness is human — an agreement signed, a fee received, a test run
-- done — and lived in somebody's head.
--
-- The checklist makes all of it one list, and the gate is on the status change
-- rather than on the approve function, so it holds however the transition is
-- made: the console, a script, or the SQL editor.

create table territory_onboarding_checklist (
  id           uuid primary key default gen_random_uuid(),
  territory_id uuid not null references territories (id) on delete cascade,
  item_key     text not null,
  label        text not null,
  sort_order   int  not null default 0,
  -- Some items the database can vouch for itself; those say so rather than
  -- asking somebody to tick a box it could have checked.
  auto         boolean not null default false,
  done         boolean not null default false,
  done_by      uuid references profiles (id),
  done_at      timestamptz,
  created_at   timestamptz not null default now(),
  unique (territory_id, item_key)
);

create index territory_checklist_idx on territory_onboarding_checklist (territory_id);

comment on table territory_onboarding_checklist is
  'What has to be true before a city trades. Gate enforced on the status change, not on one function.';

-- The default list, in the order it is worked through.
create or replace function seed_territory_checklist(p_territory uuid)
returns void
language sql
security definer
set search_path = public
as $$
  insert into territory_onboarding_checklist (territory_id, item_key, label, sort_order, auto)
  values
    (p_territory, 'agreement_signed',       'Franchise agreement signed',            1, false),
    (p_territory, 'franchise_fee_paid',     'Franchise fee received',                2, false),
    (p_territory, 'boundary_drawn',         'Territory boundary drawn',              3, true),
    (p_territory, 'riders_verified_min3',   'At least 3 riders approved',            4, true),
    (p_territory, 'payout_details_set',     'Rider settlement payout details set',   5, true),
    (p_territory, 'test_delivery_completed','Test delivery completed end to end',    6, false)
  on conflict (territory_id, item_key) do nothing;
$$;

create or replace function seed_checklist_on_new_territory()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform seed_territory_checklist(new.id);
  return null;
end;
$$;

create trigger territories_seed_checklist
  after insert on territories
  for each row execute function seed_checklist_on_new_territory();

-- Every territory that already exists gets the list too.
do $$
declare t record;
begin
  for t in select id from territories loop
    perform seed_territory_checklist(t.id);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- The items the database can answer for itself, refreshed on demand.
-- ---------------------------------------------------------------------------
create or replace function refresh_territory_checklist(p_territory uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare t territories;
begin
  select * into t from territories where id = p_territory;
  if t.id is null then
    return;
  end if;

  update territory_onboarding_checklist c
     set done = v.ok,
         done_at = case when v.ok and not c.done then now()
                        when not v.ok then null else c.done_at end
    from (values
      ('boundary_drawn',
       t.service_center_lat is not null and t.service_center_lng is not null and t.service_radius_km > 0),
      ('riders_verified_min3',
       (select count(*) from riders r
         where r.territory_id = t.id and r.application_status = 'approved'
           and not r.is_suspended) >= 3),
      ('payout_details_set',
       nullif(btrim(coalesce(t.settlement_gcash_number, '')), '') is not null
       and nullif(btrim(coalesce(t.settlement_gcash_name, '')), '') is not null)
    ) as v(item_key, ok)
   where c.territory_id = p_territory
     and c.item_key = v.item_key
     and c.auto
     and c.done is distinct from v.ok;
end;
$$;
revoke all on function refresh_territory_checklist(uuid) from public;
grant execute on function refresh_territory_checklist(uuid) to authenticated;

create or replace function can_go_live(p_territory uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  return not exists (
    select 1 from territory_onboarding_checklist
     where territory_id = p_territory and not done
  );
end;
$$;
revoke all on function can_go_live(uuid) from public;
grant execute on function can_go_live(uuid) to authenticated;

/** What is still outstanding, for an error message somebody can act on. */
create or replace function territory_outstanding_items(p_territory uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select string_agg(label, ', ' order by sort_order)
    from territory_onboarding_checklist
   where territory_id = p_territory and not done;
$$;
revoke all on function territory_outstanding_items(uuid) from public;
grant execute on function territory_outstanding_items(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- The gate itself. On the status change, so no path around it.
-- ---------------------------------------------------------------------------
create or replace function guard_go_live()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status::text = 'live' and old.status::text is distinct from 'live' then
    perform refresh_territory_checklist(new.id);
    if not can_go_live(new.id) then
      raise exception '% cannot go live yet — still outstanding: %',
        new.name, coalesce(territory_outstanding_items(new.id), 'unknown')
        using errcode = 'check_violation';
    end if;
  end if;
  return new;
end;
$$;

create trigger territories_guard_go_live
  before update on territories
  for each row execute function guard_go_live();

-- approve_territory() now moves a city to `approved`, not straight to trading.
-- Opening it is the separate, gated step.
create or replace function approve_territory(p_territory uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare t territories;
begin
  if not is_franchisor() then
    raise exception 'Only the franchisor can approve a territory'
      using errcode = 'insufficient_privilege';
  end if;

  select * into t from territories where id = p_territory;
  if t.id is null then
    raise exception 'No such territory' using errcode = 'no_data_found';
  end if;
  if t.operator_profile_id is null then
    raise exception 'Appoint an operator before approving %', t.name
      using errcode = 'check_violation';
  end if;

  update territories set status = 'approved' where id = p_territory;
  perform refresh_territory_checklist(p_territory);
end;
$$;

/** Open an approved city for business. Refused unless the checklist is clear. */
create or replace function go_live(p_territory uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not is_franchisor() then
    raise exception 'Only the franchisor can open a territory'
      using errcode = 'insufficient_privilege';
  end if;
  perform refresh_territory_checklist(p_territory);
  update territories set status = 'live' where id = p_territory;
end;
$$;
revoke all on function go_live(uuid) from public;
grant execute on function go_live(uuid) to authenticated;

/** Ticking a human item. Auto items are the database's to answer. */
create or replace function set_checklist_item(p_territory uuid, p_item text, p_done boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not (is_franchisor() or (is_staff() and p_territory = current_territory_id())) then
    raise exception 'That is not your territory' using errcode = 'insufficient_privilege';
  end if;
  if exists (select 1 from territory_onboarding_checklist
              where territory_id = p_territory and item_key = p_item and auto) then
    raise exception 'That item is checked automatically and cannot be ticked by hand'
      using errcode = 'check_violation';
  end if;

  update territory_onboarding_checklist
     set done = p_done,
         done_by = case when p_done then auth.uid() else null end,
         done_at = case when p_done then now() else null end
   where territory_id = p_territory and item_key = p_item;
end;
$$;
revoke all on function set_checklist_item(uuid, text, boolean) from public;
grant execute on function set_checklist_item(uuid, text, boolean) to authenticated;

grant select on territory_onboarding_checklist to authenticated;
grant all on territory_onboarding_checklist to service_role;
alter table territory_onboarding_checklist enable row level security;

create policy checklist_read on territory_onboarding_checklist
  for select using (staff_sees(territory_id));
create policy checklist_franchisor_write on territory_onboarding_checklist
  for all using (is_franchisor()) with check (is_franchisor());
