-- Install tracking + active/inactive user monitoring for the admin console.

create table if not exists app_installs (
  id         uuid primary key default gen_random_uuid(),
  app        text not null check (app in ('customer', 'rider')),
  platform   text not null default 'pwa',   -- pwa | android | ios | web
  device_id  text not null,                 -- stable per-device id, dedupes re-runs
  profile_id uuid references profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  unique (app, device_id)
);
create index if not exists app_installs_app_idx on app_installs (app, created_at);

grant select, insert on app_installs to anon, authenticated;
grant all on app_installs to service_role;
alter table app_installs enable row level security;

-- Anyone may register their own device install; only staff can read the list.
drop policy if exists app_installs_insert on app_installs;
create policy app_installs_insert on app_installs
  for insert to anon, authenticated with check (true);
drop policy if exists app_installs_staff_read on app_installs;
create policy app_installs_staff_read on app_installs
  for select using (is_staff());

/**
 * Adoption + engagement snapshot for the admin console.
 *
 * "Active" means the account actually used the service inside the window:
 * a customer placed an order, a rider was assigned one (or is online now).
 * Everyone else who signed up is counted inactive.
 */
create or replace function admin_user_activity(p_days int default 30)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_from timestamptz := now() - make_interval(days => greatest(p_days, 1));
  r jsonb;
begin
  if not is_staff() then
    raise exception 'not authorised';
  end if;

  select jsonb_build_object(
    'window_days', greatest(p_days, 1),

    'customers_total',    (select count(*) from customers),
    'customers_active',   (select count(distinct o.customer_id) from orders o
                             where o.created_at >= v_from and o.customer_id is not null),
    'customers_new',      (select count(*) from customers c where c.created_at >= v_from),

    'riders_total',       (select count(*) from riders where application_status = 'approved'),
    'riders_active',      (select count(*) from riders r
                             where r.application_status = 'approved'
                               and (r.is_online
                                    or exists (select 1 from orders o
                                               where o.rider_id = r.id and o.created_at >= v_from))),
    'riders_online',      (select count(*) from riders where is_online),
    'riders_suspended',   (select count(*) from riders where is_suspended),
    'riders_pending',     (select count(*) from riders where application_status = 'pending'),

    'installs_total',     (select count(*) from app_installs),
    'installs_customer',  (select count(*) from app_installs where app = 'customer'),
    'installs_rider',     (select count(*) from app_installs where app = 'rider'),
    'installs_new',       (select count(*) from app_installs where created_at >= v_from),

    'orders_in_window',   (select count(*) from orders where created_at >= v_from)
  ) into r;

  return r;
end;
$$;
revoke all on function admin_user_activity(int) from public;
grant execute on function admin_user_activity(int) to authenticated;
