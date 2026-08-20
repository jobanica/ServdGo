-- ServdGo — "revoke all from public" was not revoking anything.
--
-- Found while checking the grants on the Xendit key reader, which is supposed
-- to be the one door out of Vault and was standing open to every signed-in
-- user. It had the same two lines every other function in this schema has:
--
--     revoke all on function xendit_credentials() from public;
--     grant execute on function xendit_credentials() to service_role;
--
-- The revoke does nothing. Supabase ships a default privilege that grants
-- EXECUTE on new functions to anon and authenticated *explicitly*, and revoking
-- from PUBLIC does not touch an explicit grant. So every function this schema
-- believed was service-role-only was callable by anyone holding the anon key —
-- which is a public value, shipped in the apps.
--
-- What that actually allowed, worst first:
--
--   xendit_credentials()             read the live payment secret key
--   wallet_topup_mark_paid()         credit any rider's wallet, any amount
--   merchant_book() / _cancel()      book and cancel as any partner restaurant
--   merchant_order_view()            read any partner's orders
--   verify_merchant_key()            test API keys offline, without rate limit
--
-- None of it needs a bug to exploit; it needs the anon key and the function
-- name. So this revokes explicitly, from the named roles, and then refuses to
-- finish if any of it is still reachable — the check is the point, because the
-- lesson of this migration is that a revoke you did not verify is a wish.

create or replace function lock_to_service_role(p_signature text)
returns void
language plpgsql
as $$
begin
  execute format('revoke all on function %s from public, anon, authenticated', p_signature);
  execute format('grant execute on function %s to service_role', p_signature);
exception
  when undefined_function then
    raise notice 'lock_to_service_role: no such function %, skipping', p_signature;
end;
$$;
comment on function lock_to_service_role(text) is
  'Revoke EXECUTE from anon and authenticated by name. Revoking from PUBLIC does not remove Supabase''s default explicit grants.';

do $$
declare
  f text;
  -- Everything a browser must never be able to call, whatever key it holds.
  fns text[] := array[
    -- The payment account, and the Vault it lives in.
    'xendit_credentials()',
    'vault_read(text)',
    'vault_put(text, text, text)',
    'vault_forget(text)',
    -- Money into a rider's wallet. Only the paid callback may do this.
    'wallet_topup_reference()',
    'wallet_topup_attach_provider(text, text, text, text, timestamptz)',
    'wallet_topup_mark_paid(text, text, numeric, jsonb)',
    'wallet_topup_close(text, text, jsonb)',
    -- The partner API. Each of these takes the merchant id as an argument,
    -- so reaching them at all is reaching them as anybody.
    'verify_merchant_key(text)',
    'merchant_quote(uuid, double precision, double precision)',
    'merchant_book(uuid, text, double precision, double precision, text, text, text, text, text)',
    'merchant_cancel(uuid, text, text)',
    'merchant_order_status(uuid, text)',
    'merchant_order_view(uuid)',
    'claim_merchant_webhooks(int)',
    'complete_merchant_webhook(uuid, boolean, text)',
    'drain_merchant_webhooks()',
    -- Scheduled work. Nobody calls these by hand.
    'run_monthly_invoicing(date)',
    'sweep_overdue_territories()',
    'raise_alert(text, text, text, text, uuid, alert_severity, text, text)'
  ];
begin
  foreach f in array fns loop
    perform lock_to_service_role(f);
  end loop;
end $$;

-- The internal one 0119 added: hq_cancel_order() calls it as its definer, so
-- nothing outside needs it.
do $$ begin
  perform lock_to_service_role('wallet_refund_order(uuid, text)');
exception when others then null; end $$;

-- ---------------------------------------------------------------------------
-- And now prove it, because the whole reason this migration exists is that
-- nobody checked last time.
-- ---------------------------------------------------------------------------
do $$
declare
  v_leaks text;
begin
  select string_agg(format('%s(%s) → %s', p.proname,
                           pg_get_function_identity_arguments(p.oid), g.grantee), ', ')
    into v_leaks
    from pg_proc p
    cross join lateral aclexplode(p.proacl) x
    cross join lateral (select pg_get_userbyid(x.grantee) as grantee) g
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and x.privilege_type = 'EXECUTE'
     and g.grantee in ('anon', 'authenticated')
     and p.proname in (
       'xendit_credentials', 'vault_read', 'vault_put', 'vault_forget',
       'wallet_topup_reference', 'wallet_topup_attach_provider',
       'wallet_topup_mark_paid', 'wallet_topup_close',
       'verify_merchant_key', 'merchant_quote', 'merchant_book', 'merchant_cancel',
       'merchant_order_status', 'merchant_order_view', 'claim_merchant_webhooks',
       'complete_merchant_webhook', 'drain_merchant_webhooks',
       'run_monthly_invoicing', 'sweep_overdue_territories', 'raise_alert',
       'wallet_refund_order');

  if v_leaks is not null then
    raise exception 'These are still reachable from a browser: %', v_leaks;
  end if;
  raise notice 'service-role-only functions are service-role-only';
end $$;
