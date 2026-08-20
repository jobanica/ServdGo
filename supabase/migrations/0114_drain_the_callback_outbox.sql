-- ServdGo — actually send the callbacks we queue.
--
-- Found the hard way: a real partner order went pending → accepted → picked up
-- → delivered, and the restaurant's system was told none of it. Five callbacks
-- sat in the outbox per order, `pending`, because nothing ever called the
-- worker that drains them. The queue was right, the trigger was right, the
-- signing was right — and every one of them was still sitting there.
--
-- The worker is an edge function (it needs HMAC and an outbound POST), so the
-- schedule has to reach out over HTTP. That needs two things this database did
-- not have: pg_net to make the request, and somewhere to keep the service-role
-- key that is not the job definition itself.
--
-- The key lives in Vault. cron.job.command is readable by anyone who can read
-- the catalog; vault.decrypted_secrets is not, and it is the pattern Supabase
-- documents for exactly this. It is still a secret in the database — the honest
-- framing is that anything able to read it could already act as service_role.

-- pg_net is provided by the platform and is absent from a plain Postgres, so
-- this skips rather than fails there — a migration that cannot be replayed on a
-- throwaway database stops the whole test suite running.
do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_net') then
    execute 'create extension if not exists pg_net with schema extensions';
  else
    raise notice 'pg_net is not available here — callbacks will not be drained on this database.';
  end if;
end $$;

/**
 * Nudge the callback worker.
 *
 * Deliberately fire-and-forget: pg_net queues the request and returns an id,
 * and the worker records its own outcome on merchant_webhook_deliveries. There
 * is nothing for this function to wait for, and a slow restaurant must not hold
 * a cron slot open.
 */
create or replace function drain_merchant_webhooks()
returns bigint
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_url    text;
  v_key    text;
  v_req_id bigint;
begin
  select decrypted_secret into v_key
    from vault.decrypted_secrets where name = 'service_role_key';
  select decrypted_secret into v_url
    from vault.decrypted_secrets where name = 'functions_base_url';

  if v_key is null or v_url is null then
    raise warning 'drain_merchant_webhooks: no service_role_key/functions_base_url in vault';
    return null;
  end if;

  -- Nothing due? Do not wake the function at all. Most minutes are quiet, and
  -- an idle invocation still costs.
  if not exists (
    select 1 from merchant_webhook_deliveries
     where status = 'pending' and next_attempt_at <= now()
  ) then
    return null;
  end if;

  -- Dynamic so the function can be created on a database without pg_net; it
  -- returns null there rather than failing to exist at all.
  if to_regproc('net.http_post') is null then
    raise warning 'drain_merchant_webhooks: pg_net is not installed here';
    return null;
  end if;

  execute
    'select net.http_post(url := $1, headers := $2, body := $3::jsonb)'
    into v_req_id
    using v_url || '/merchant-webhooks',
          jsonb_build_object('Authorization', 'Bearer ' || v_key,
                             'Content-Type',  'application/json'),
          '{}';

  return v_req_id;
end;
$$;
revoke all on function drain_merchant_webhooks() from public;
grant execute on function drain_merchant_webhooks() to service_role;

comment on function drain_merchant_webhooks() is
  'Wakes the merchant-webhooks worker when the outbox has something due. Scheduled every minute.';

-- ---------------------------------------------------------------------------
-- Every minute. A callback nobody sends is a restaurant that never learns its
-- order was delivered.
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    raise notice 'pg_cron is not available here — the callback drain is NOT scheduled.';
    return;
  end if;
  execute 'create extension if not exists pg_cron';

  begin
    perform cron.unschedule('servdgo-drain-webhooks');
  exception when others then null;
  end;

  perform cron.schedule('servdgo-drain-webhooks', '* * * * *',
                        'select public.drain_merchant_webhooks()');
end $$;
