-- ServdGo — there has to be a way to appoint the first franchisor.
--
-- 0085 closed a real hole: a city operator is an admin, and the role guard let
-- any admin change any role, so an operator could make themselves franchisor and
-- read every city's ledger. Granting that role became the franchisor's alone.
--
-- Which left nobody able to grant it the first time. The guard exempted only
-- `service_role`, and the Supabase SQL editor connects as `postgres` — so the
-- bootstrap in DEPLOYMENT.md failed, and failed quietly: the update matched the
-- row, the trigger raised, and on a client that swallows the error the role was
-- simply still 'customer'.
--
-- The fix exempts the privileged database roles rather than just service_role.
-- That is not a weakening. Anyone connecting as postgres or supabase_admin can
-- already `alter table profiles disable trigger` — the guard has never been a
-- boundary against them, and pretending otherwise only blocked the legitimate
-- path. The boundary that matters is the one against `authenticated`: an
-- operator signed into the admin console still cannot grant themselves the role.

create or replace function guard_profile_role()
returns trigger
language plpgsql
as $$
begin
  -- Server-side provisioning, the database owner, and the franchisor.
  if current_user in ('service_role', 'postgres', 'supabase_admin')
     or is_franchisor() then
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

create or replace function guard_profile_insert()
returns trigger
language plpgsql
as $$
begin
  if current_user in ('service_role', 'postgres', 'supabase_admin')
     or is_franchisor() then
    return new;
  end if;
  if new.role::text = 'franchisor' then
    raise exception 'only the franchisor can grant the franchisor role'
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end;
$$;
