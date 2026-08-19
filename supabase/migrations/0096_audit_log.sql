-- ServdGo — an append-only record of who did what.
--
-- Append-only is enforced by grants rather than by convention: nobody, including
-- the franchisor, has UPDATE or DELETE on this table. A log that can be edited
-- by the person it incriminates is not a log.
--
-- Writes go through log_action(), which is SECURITY DEFINER, so callers never
-- need INSERT on the table either — which means they cannot forge an actor.

create table audit_log (
  id            bigint generated always as identity primary key,
  actor_user_id uuid references profiles (id),
  actor_role    text,
  territory_id  uuid references territories (id),
  action        text not null,
  entity        text,
  entity_id     text,
  diff          jsonb,
  created_at    timestamptz not null default now()
);

create index audit_log_created_idx   on audit_log (created_at desc);
create index audit_log_territory_idx on audit_log (territory_id, created_at desc);
create index audit_log_actor_idx     on audit_log (actor_user_id, created_at desc);
create index audit_log_action_idx    on audit_log (action, created_at desc);

comment on table audit_log is
  'Append-only. UPDATE and DELETE are revoked from every role, including the franchisor.';

create or replace function log_action(
  p_action    text,
  p_entity    text default null,
  p_entity_id text default null,
  p_territory uuid default null,
  p_diff      jsonb default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into audit_log (actor_user_id, actor_role, territory_id, action, entity, entity_id, diff)
  values (
    auth.uid(),
    coalesce((select role::text from profiles where id = auth.uid()), current_user),
    coalesce(p_territory, current_territory_id()),
    p_action, p_entity, p_entity_id, p_diff);
end;
$$;
revoke all on function log_action(text, text, text, uuid, jsonb) from public;
grant execute on function log_action(text, text, text, uuid, jsonb) to authenticated, service_role;

-- Status changes are the ones worth having without anyone remembering to call
-- the logger.
create or replace function log_territory_status_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status is distinct from old.status then
    perform log_action(
      'territory.status_changed', 'territory', new.id::text, new.id,
      jsonb_build_object('from', old.status::text, 'to', new.status::text, 'name', new.name));
  end if;
  return null;
end;
$$;

create trigger territories_log_status
  after update on territories
  for each row execute function log_territory_status_change();

grant select on audit_log to authenticated;
grant insert on audit_log to service_role;
revoke update, delete on audit_log from anon, authenticated, service_role;
alter table audit_log enable row level security;

-- The franchisor reads everything; staff read their own city's entries.
create policy audit_log_read on audit_log
  for select using (is_franchisor() or (is_staff() and territory_id = current_territory_id()));
