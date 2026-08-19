-- ServdGo — a way back out: status changes posted to Servd.
--
-- Written as an outbox rather than a direct call. A trigger cannot make an HTTP
-- request without pg_net, and even with it a failed POST inside a transaction
-- either rolls the order back or is lost. Queueing the event and letting a
-- worker drain it means a restaurant that is down for ten minutes gets its
-- callbacks when it returns, and an order is never held up by somebody else's
-- outage.

create table merchant_webhook_deliveries (
  id              uuid primary key default gen_random_uuid(),
  merchant_id     uuid not null references merchants (id) on delete cascade,
  order_id        uuid not null references orders (id) on delete cascade,
  event           text not null,
  payload         jsonb not null,
  status          text not null default 'pending'
                    check (status in ('pending', 'delivered', 'failed')),
  attempts        int not null default 0,
  last_error      text,
  next_attempt_at timestamptz not null default now(),
  delivered_at    timestamptz,
  created_at      timestamptz not null default now()
);

create index merchant_webhooks_due_idx
  on merchant_webhook_deliveries (next_attempt_at)
  where status = 'pending';
create index merchant_webhooks_order_idx on merchant_webhook_deliveries (order_id);

comment on table merchant_webhook_deliveries is
  'Outbox of callbacks owed to a partner platform. Drained by the merchant-webhooks function.';

-- How many times to try before giving up, and how long to wait between.
alter table platform_settings
  add column if not exists webhook_max_attempts int not null default 8;

/**
 * Queue a callback. Only for orders that came in over the API, and only when
 * the restaurant gave a URL to call.
 */
create or replace function enqueue_merchant_webhook()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_url   text;
  v_event text;
begin
  if new.merchant_id is null then
    return null;
  end if;

  select webhook_url into v_url from merchants where id = new.merchant_id;
  if nullif(btrim(coalesce(v_url, '')), '') is null then
    return null;   -- they poll instead
  end if;

  if tg_op = 'INSERT' then
    v_event := 'order.created';
  elsif new.status is distinct from old.status then
    v_event := 'order.' || new.status;
  elsif new.rider_id is distinct from old.rider_id and new.rider_id is not null then
    v_event := 'order.rider_assigned';
  else
    return null;
  end if;

  insert into merchant_webhook_deliveries (merchant_id, order_id, event, payload)
  values (new.merchant_id, new.id, v_event,
          merchant_order_view(new.id) || jsonb_build_object('event', v_event));
  return null;
end;
$$;

create trigger orders_merchant_webhook
  after insert or update on orders
  for each row execute function enqueue_merchant_webhook();

/**
 * Take the next batch of due callbacks, marking the attempt as it goes so two
 * workers cannot both send the same one.
 *
 * Returns the restaurant's URL and signing secret alongside each payload; it is
 * granted to the service role only, and the worker is the only thing that runs
 * on it.
 */
create or replace function claim_merchant_webhooks(p_limit int default 20)
returns table (
  id          uuid,
  url         text,
  secret      text,
  event       text,
  payload     jsonb,
  attempts    int
)
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  with due as (
    select d.id
      from merchant_webhook_deliveries d
     where d.status = 'pending' and d.next_attempt_at <= now()
     order by d.next_attempt_at
     limit greatest(1, least(p_limit, 100))
     for update skip locked
  )
  update merchant_webhook_deliveries d
     set attempts = d.attempts + 1,
         -- Held off for a minute while in flight, so a worker that dies without
         -- reporting back does not have its work picked up twice in a second.
         next_attempt_at = now() + interval '1 minute'
    from due, merchants m
   where d.id = due.id and m.id = d.merchant_id
  returning d.id, m.webhook_url, m.webhook_secret, d.event, d.payload, d.attempts;
end;
$$;
revoke all on function claim_merchant_webhooks(int) from public;
grant execute on function claim_merchant_webhooks(int) to service_role;

/**
 * Report what happened. A failure backs off exponentially and gives up once the
 * platform's attempt limit is reached — at which point it stays on the table as
 * a record that Servd never heard about that order.
 */
create or replace function complete_merchant_webhook(
  p_id uuid, p_ok boolean, p_error text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_attempts int;
  v_max      int;
begin
  if p_ok then
    update merchant_webhook_deliveries
       set status = 'delivered', delivered_at = now(), last_error = null
     where id = p_id;
    return;
  end if;

  select attempts into v_attempts from merchant_webhook_deliveries where id = p_id;
  select webhook_max_attempts into v_max from platform_settings where id = true;

  if v_attempts >= coalesce(v_max, 8) then
    update merchant_webhook_deliveries
       set status = 'failed', last_error = left(coalesce(p_error, 'gave up'), 500)
     where id = p_id;
  else
    update merchant_webhook_deliveries
       set next_attempt_at = now() + (interval '1 minute' * power(2, least(v_attempts, 8))),
           last_error = left(coalesce(p_error, 'no response'), 500)
     where id = p_id;
  end if;
end;
$$;
revoke all on function complete_merchant_webhook(uuid, boolean, text) from public;
grant execute on function complete_merchant_webhook(uuid, boolean, text) to service_role;

-- ---------------------------------------------------------------------------
-- Access. Staff can see what was sent to their own restaurants — "did they get
-- told?" is the first question when a partner says an order went missing.
-- ---------------------------------------------------------------------------
grant select on merchant_webhook_deliveries to authenticated;
grant all on merchant_webhook_deliveries to service_role;
alter table merchant_webhook_deliveries enable row level security;

create policy merchant_webhooks_staff_read on merchant_webhook_deliveries
  for select using (staff_sees_merchant(merchant_id));
