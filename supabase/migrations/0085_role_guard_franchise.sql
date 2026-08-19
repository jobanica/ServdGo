-- ServdGo — an operator cannot promote themselves out of their city.
--
-- Two holes opened when the franchisor role and profiles.territory_id arrived.
--
-- The role guard from 0012 let any admin change any role it could reach, and a
-- city operator *is* an admin. That meant an operator could set their own role
-- to 'franchisor' and read every city's ledger. Granting or removing that role
-- is now the franchisor's alone.
--
-- The second is quieter. profiles_admin_all is written as admin_sees(territory_id),
-- and admin_sees(null) is true — a null territory is platform-wide and visible to
-- any staff. So an operator could blank their own territory_id, or a colleague's,
-- and step outside the scoping rather than across it. Moving anyone between
-- cities, or out of one, is the franchisor's too.

create or replace function guard_profile_role()
returns trigger
language plpgsql
as $$
begin
  -- Server-side provisioning and the franchisor are both unrestricted.
  if current_user = 'service_role' or is_franchisor() then
    return new;
  end if;

  if new.role::text = 'franchisor' or old.role::text = 'franchisor' then
    raise exception 'only the franchisor can grant or remove the franchisor role'
      using errcode = 'insufficient_privilege';
  end if;

  if new.role is distinct from old.role and not is_admin() then
    raise exception 'only an admin may change a role'
      using errcode = 'insufficient_privilege';
  end if;

  if new.territory_id is distinct from old.territory_id then
    raise exception 'only the franchisor can move somebody between territories'
      using errcode = 'insufficient_privilege';
  end if;

  return new;
end;
$$;

-- The guard only fires on UPDATE, so it says nothing about an INSERT that
-- arrives already claiming the role. Profiles are created by the auth trigger in
-- 0008 with role 'customer', and this closes the direct path.
create or replace function guard_profile_insert()
returns trigger
language plpgsql
as $$
begin
  if current_user = 'service_role' or is_franchisor() then
    return new;
  end if;
  if new.role::text = 'franchisor' then
    raise exception 'only the franchisor can grant the franchisor role'
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end;
$$;

drop trigger if exists profiles_insert_guard on profiles;
create trigger profiles_insert_guard
  before insert on profiles
  for each row execute function guard_profile_insert();

-- assign_territory_operator() and the franchisor RPCs run as security definer and
-- are gated on is_franchisor() inside, so they are unaffected — they are the
-- supported way to move somebody, which is the point.
