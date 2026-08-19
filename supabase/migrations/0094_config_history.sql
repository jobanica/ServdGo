-- ServdGo — what the terms used to be, and who changed them.
--
-- Rev-share is the thing an operator and the franchisor will eventually
-- disagree about. Keeping the before and after of every change, with a name
-- against it, is cheaper than reconstructing it from memory later.

create table territory_config_history (
  id           uuid primary key default gen_random_uuid(),
  territory_id uuid not null references territories (id) on delete cascade,
  field        text not null,
  old_value    text,
  new_value    text,
  changed_by   uuid references profiles (id),
  changed_at   timestamptz not null default now()
);

create index territory_config_history_idx
  on territory_config_history (territory_id, changed_at desc);

comment on table territory_config_history is
  'Append-only record of rev-share and fee changes. Written by trigger, not by the caller.';

create or replace function record_territory_config_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  f       text;
  old_v   text;
  new_v   text;
begin
  foreach f in array array[
    'commission_rate', 'markup_operator_share', 'franchise_fee_monthly',
    'grace_days', 'per_store_fee', 'default_delivery_fee'
  ] loop
    execute format('select ($1).%I::text, ($2).%I::text', f, f)
      into old_v, new_v using old, new;
    if old_v is distinct from new_v then
      insert into territory_config_history (territory_id, field, old_value, new_value, changed_by)
      values (new.id, f, old_v, new_v, auth.uid());
    end if;
  end loop;
  return null;
end;
$$;

grant select on territory_config_history to authenticated;
grant all on territory_config_history to service_role;
alter table territory_config_history enable row level security;

create policy config_history_read on territory_config_history
  for select using (staff_sees(territory_id));
