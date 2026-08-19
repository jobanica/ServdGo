-- Easy Buy Delivery — prevent role self-escalation.
--
-- profiles_self_update (0005) lets a user edit their own profile row, which
-- would include `role`. This trigger blocks any role change unless the caller
-- is the service role (server-side provisioning) or an admin. It runs with the
-- caller's privileges (NOT security definer) so current_user reflects the API
-- role PostgREST switched to (anon / authenticated / service_role).

create or replace function guard_profile_role()
returns trigger
language plpgsql
as $$
begin
  if new.role is distinct from old.role
     and current_user <> 'service_role'
     and not is_admin() then
    raise exception 'only an admin may change a role';
  end if;
  return new;
end;
$$;

drop trigger if exists profiles_role_guard on profiles;
create trigger profiles_role_guard
  before update on profiles
  for each row execute function guard_profile_role();
