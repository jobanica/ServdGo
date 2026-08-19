-- Rider online/offline availability toggle.
--
-- A rider marks themselves online to receive/accept orders and offline to stop.
-- Riders may not UPDATE their own row directly (riders_admin_write only) — that
-- guard keeps them from self-approving or self-unlocking. So expose a narrow
-- SECURITY DEFINER function that flips ONLY is_online on the caller's own row.
alter table riders add column if not exists is_online boolean not null default false;

create or replace function set_rider_online(p_online boolean)
returns boolean
language sql
security definer
set search_path = public
as $$
  update riders set is_online = p_online where profile_id = auth.uid()
  returning is_online;
$$;

revoke all on function set_rider_online(boolean) from public;
grant execute on function set_rider_online(boolean) to authenticated;
