-- ServdGo — what the merchant integrations are actually doing.
--
-- "Is the restaurant connected?" is answered by three facts: when a key was
-- last used, how much it is being used, and whether the callbacks we owe them
-- are getting through. The first already exists; this migration adds the other
-- two and the replay button for when they do not.

-- ---------------------------------------------------------------------------
-- A daily count per key. A row per call would be a log; this is a counter, so
-- thirty days of it is thirty rows per key.
-- ---------------------------------------------------------------------------
create table merchant_api_key_usage (
  key_id uuid   not null references merchant_api_keys (id) on delete cascade,
  day    date   not null,
  calls  bigint not null default 0,
  primary key (key_id, day)
);
create index merchant_api_key_usage_day on merchant_api_key_usage (day desc);

comment on table merchant_api_key_usage is
  'One row per key per day, counting API calls. Written by verify_merchant_key.';

-- Counting has to happen where the key is verified, which is the one place
-- every call goes through.
create or replace function verify_merchant_key(p_key text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_merchant uuid;
  v_key      uuid;
begin
  if p_key is null or btrim(p_key) = '' then
    return null;
  end if;

  update merchant_api_keys k
     set last_used_at = now()
    from merchants m
   where k.key_hash = encode(sha256(convert_to(p_key, 'utf8')), 'hex')
     and k.revoked_at is null
     and m.id = k.merchant_id
     and m.is_active
  returning k.merchant_id, k.id into v_merchant, v_key;

  if v_key is not null then
    insert into merchant_api_key_usage (key_id, day, calls)
    values (v_key, (now() at time zone 'Asia/Manila')::date, 1)
    on conflict (key_id, day) do update set calls = merchant_api_key_usage.calls + 1;
  end if;

  return v_merchant;
end;
$$;
revoke all on function verify_merchant_key(text) from public;
grant execute on function verify_merchant_key(text) to service_role;

alter table merchant_api_key_usage enable row level security;
create policy merchant_api_key_usage_read on merchant_api_key_usage
  for select using (staff_sees_merchant(
    (select merchant_id from merchant_api_keys where id = key_id)));
grant select on merchant_api_key_usage to authenticated;
grant all on merchant_api_key_usage to service_role;

/** Keys with their traffic over a window — the console's key list. */
create or replace function merchant_key_usage(p_merchant uuid default null, p_days int default 30)
returns table (
  key_id       uuid,
  merchant_id  uuid,
  merchant_name text,
  label        text,
  prefix       text,
  created_at   timestamptz,
  last_used_at timestamptz,
  revoked_at   timestamptz,
  calls        bigint
)
language sql
stable
security invoker
set search_path = public
as $$
  select k.id, k.merchant_id, m.name, k.label, k.prefix, k.created_at,
         k.last_used_at, k.revoked_at,
         coalesce((select sum(u.calls) from merchant_api_key_usage u
                    where u.key_id = k.id
                      and u.day > (now() at time zone 'Asia/Manila')::date - greatest(p_days, 1)), 0)
    from merchant_api_keys k
    join merchants m on m.id = k.merchant_id
   where p_merchant is null or k.merchant_id = p_merchant
   order by k.revoked_at nulls first, k.created_at desc;
$$;
revoke all on function merchant_key_usage(uuid, int) from public;
grant execute on function merchant_key_usage(uuid, int) to authenticated;

-- ---------------------------------------------------------------------------
-- Connection health, one row per restaurant.
-- ---------------------------------------------------------------------------
create or replace function merchant_health(p_days int default 30)
returns table (
  merchant_id     uuid,
  merchant_name   text,
  territory_id    uuid,
  territory_name  text,
  is_active       boolean,
  webhook_url     text,
  active_keys     bigint,
  last_call_at    timestamptz,
  calls           bigint,
  orders_placed   bigint,
  webhooks_pending bigint,
  webhooks_failed bigint,
  last_delivery_at timestamptz,
  last_error      text
)
language sql
stable
security invoker
set search_path = public
as $$
  with window_start as (
    select (now() at time zone 'Asia/Manila')::date - greatest(p_days, 1) as from_day
  )
  select m.id, m.name, m.territory_id, t.name, m.is_active, m.webhook_url,
         (select count(*) from merchant_api_keys k
           where k.merchant_id = m.id and k.revoked_at is null),
         (select max(k.last_used_at) from merchant_api_keys k where k.merchant_id = m.id),
         coalesce((select sum(u.calls) from merchant_api_key_usage u
                     join merchant_api_keys k on k.id = u.key_id
                    where k.merchant_id = m.id and u.day > (select from_day from window_start)), 0),
         (select count(*) from orders o
           where o.merchant_id = m.id and o.created_at > now() - make_interval(days => greatest(p_days, 1))),
         (select count(*) from merchant_webhook_deliveries d
           where d.merchant_id = m.id and d.status = 'pending'),
         (select count(*) from merchant_webhook_deliveries d
           where d.merchant_id = m.id and d.status = 'failed'),
         (select max(d.delivered_at) from merchant_webhook_deliveries d where d.merchant_id = m.id),
         (select d.last_error from merchant_webhook_deliveries d
           where d.merchant_id = m.id and d.last_error is not null
           order by d.created_at desc limit 1)
    from merchants m
    left join territories t on t.id = m.territory_id
   order by m.name;
$$;
revoke all on function merchant_health(int) from public;
grant execute on function merchant_health(int) to authenticated;

-- ---------------------------------------------------------------------------
-- Replay. A callback that failed eight times is not lost, it is parked — this
-- puts it back at the front of the queue.
-- ---------------------------------------------------------------------------
create or replace function replay_merchant_webhook(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_merchant uuid;
  v_order    uuid;
begin
  select merchant_id, order_id into v_merchant, v_order
    from merchant_webhook_deliveries where id = p_id;
  if v_merchant is null then
    raise exception 'No such callback' using errcode = 'no_data_found';
  end if;
  if not staff_sees_merchant(v_merchant) then
    raise exception 'not authorised' using errcode = 'insufficient_privilege';
  end if;

  update merchant_webhook_deliveries
     set status = 'pending', attempts = 0, next_attempt_at = now(),
         last_error = null, delivered_at = null
   where id = p_id;

  perform log_action('merchant.webhook_replayed', 'merchant_webhook', p_id::text,
                     (select territory_id from merchants where id = v_merchant),
                     jsonb_build_object('merchant_id', v_merchant, 'order_id', v_order));
end;
$$;
revoke all on function replay_merchant_webhook(uuid) from public;
grant execute on function replay_merchant_webhook(uuid) to authenticated;

/** Replay every callback a restaurant has given up on. */
create or replace function replay_failed_webhooks(p_merchant uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare n integer;
begin
  if not staff_sees_merchant(p_merchant) then
    raise exception 'not authorised' using errcode = 'insufficient_privilege';
  end if;
  update merchant_webhook_deliveries
     set status = 'pending', attempts = 0, next_attempt_at = now(), last_error = null
   where merchant_id = p_merchant and status = 'failed';
  get diagnostics n = row_count;
  if n > 0 then
    perform log_action('merchant.webhooks_replayed', 'merchant', p_merchant::text,
                       (select territory_id from merchants where id = p_merchant),
                       jsonb_build_object('count', n));
  end if;
  return n;
end;
$$;
revoke all on function replay_failed_webhooks(uuid) from public;
grant execute on function replay_failed_webhooks(uuid) to authenticated;

select hq_attach_readonly_guards();
