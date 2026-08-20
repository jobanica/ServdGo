-- ServdGo — the franchisor sets up Xendit from the console, not from a shell.
--
-- 0118 shipped the wallet with its Xendit keys in edge-function environment
-- variables, which is fine for one person with a terminal and useless for the
-- person who actually owns the payment account. Moving them into the console
-- means moving a live payment secret into the database, so where it goes
-- matters more than the screen that writes it.
--
-- It goes in Vault, the same place 0114 keeps the service-role key: encrypted
-- at rest, and unreadable through PostgREST no matter who is asking, because
-- the only way back out is a security-definer function granted to service_role
-- alone. What the console can read is a stub — the mode, the last four
-- characters, and when it was set — which is enough to answer "is the right key
-- in there?" and nothing else.
--
-- The environment variables still work and still win where they are set, so an
-- existing deployment does not change behaviour the moment this lands.

alter table platform_settings
  add column if not exists xendit_enabled          boolean not null default false,
  add column if not exists xendit_mode             text not null default 'test',
  add column if not exists xendit_key_hint         text,
  add column if not exists xendit_key_set_at       timestamptz,
  add column if not exists xendit_callback_set_at  timestamptz,
  add column if not exists xendit_success_url      text,
  add column if not exists xendit_invoice_duration int not null default 3600;

do $$ begin
  alter table platform_settings
    add constraint platform_settings_xendit_mode check (xendit_mode in ('test', 'live'));
exception when duplicate_object then null; end $$;

do $$ begin
  alter table platform_settings
    add constraint platform_settings_xendit_duration
    check (xendit_invoice_duration between 300 and 86400);
exception when duplicate_object then null; end $$;

comment on column platform_settings.xendit_key_hint is
  'The last four characters of the stored secret key. Enough to tell two keys apart, useless as a key.';
comment on column platform_settings.xendit_mode is
  'Which Xendit environment the stored key belongs to. Recorded rather than inferred, so a test key in production is visible.';

-- ---------------------------------------------------------------------------
-- Writing the secrets.
--
-- Deliberately one function for both: a secret key without its callback token
-- is a wallet that takes money and never hears that it arrived, and the two
-- being set at different times is how that happens. Either may be left alone by
-- passing null, so rotating one does not force retyping the other.
-- ---------------------------------------------------------------------------
create or replace function vault_put(p_name text, p_value text, p_description text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  if to_regnamespace('vault') is null then
    raise exception 'This database has no Vault, so there is nowhere safe to keep a payment key. Set XENDIT_SECRET_KEY as an edge-function secret instead.'
      using errcode = 'feature_not_supported';
  end if;

  execute 'select id from vault.secrets where name = $1' into v_id using p_name;
  if v_id is null then
    execute 'select vault.create_secret($1, $2, $3)' using p_value, p_name, p_description;
  else
    execute 'select vault.update_secret($1, $2)' using v_id, p_value;
  end if;
end;
$$;
revoke all on function vault_put(text, text, text) from public, anon, authenticated;

create or replace function vault_forget(p_name text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if to_regnamespace('vault') is null then
    return;
  end if;
  execute 'delete from vault.secrets where name = $1' using p_name;
end;
$$;
revoke all on function vault_forget(text) from public, anon, authenticated;

create or replace function vault_read(p_name text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_value text;
begin
  if to_regnamespace('vault') is null then
    return null;
  end if;
  execute 'select decrypted_secret from vault.decrypted_secrets where name = $1'
    into v_value using p_name;
  return v_value;
end;
$$;
revoke all on function vault_read(text) from public, anon, authenticated;

/**
 * Store the Xendit credentials. Franchisor only, and never readable back.
 *
 * The key is checked for shape rather than validity — only Xendit can say
 * whether a key works, and the console has a button for that — but a key pasted
 * with a stray space or half a copy is the overwhelmingly common failure and is
 * worth catching before it becomes a 401 nobody can explain.
 */
create or replace function set_xendit_credentials(
  p_secret_key     text default null,
  p_callback_token text default null,
  p_mode           text default null,
  p_enabled        boolean default null,
  p_success_url    text default null,
  p_invoice_duration int default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_key   text := nullif(btrim(coalesce(p_secret_key, '')), '');
  v_token text := nullif(btrim(coalesce(p_callback_token, '')), '');
  v_hint  text;
begin
  if not is_franchisor() then
    raise exception 'Only the franchisor can set up the payment account'
      using errcode = 'insufficient_privilege';
  end if;
  if p_mode is not null and p_mode not in ('test', 'live') then
    raise exception 'Mode is either test or live' using errcode = 'check_violation';
  end if;

  if v_key is not null then
    if v_key !~ '^xnd_' then
      raise exception 'A Xendit secret key starts with xnd_. Copy the whole key from Settings → API keys.'
        using errcode = 'check_violation';
    end if;
    if length(v_key) < 20 then
      raise exception 'That key looks truncated.' using errcode = 'check_violation';
    end if;
    perform vault_put('xendit_secret_key', v_key, 'ServdGo — Xendit API secret key');
    v_hint := right(v_key, 4);
  end if;

  if v_token is not null then
    perform vault_put('xendit_callback_token', v_token, 'ServdGo — Xendit webhook verification token');
  end if;

  update platform_settings set
    xendit_mode            = coalesce(p_mode, xendit_mode),
    xendit_enabled         = coalesce(p_enabled, xendit_enabled),
    xendit_success_url     = coalesce(nullif(btrim(coalesce(p_success_url, '')), ''), xendit_success_url),
    xendit_invoice_duration = coalesce(p_invoice_duration, xendit_invoice_duration),
    xendit_key_hint        = coalesce(v_hint, xendit_key_hint),
    xendit_key_set_at      = case when v_key is not null then now() else xendit_key_set_at end,
    xendit_callback_set_at = case when v_token is not null then now() else xendit_callback_set_at end
  where id = true;

  -- The secrets themselves are never written to the audit log; that it changed,
  -- and which key it now is, is the part worth keeping.
  perform log_action('platform.xendit.configured', 'platform_settings', 'true', null,
                     jsonb_build_object('key_changed', v_key is not null,
                                        'token_changed', v_token is not null,
                                        'mode', p_mode, 'enabled', p_enabled,
                                        'key_hint', v_hint));
  return xendit_status();
end;
$$;
revoke all on function set_xendit_credentials(text, text, text, boolean, text, int) from public;
grant execute on function set_xendit_credentials(text, text, text, boolean, text, int) to authenticated;

/** Forget them entirely — a disconnected account, not a disabled one. */
create or replace function clear_xendit_credentials()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  if not is_franchisor() then
    raise exception 'Only the franchisor can disconnect the payment account'
      using errcode = 'insufficient_privilege';
  end if;
  perform vault_forget('xendit_secret_key');
  perform vault_forget('xendit_callback_token');
  update platform_settings set
    xendit_enabled = false, xendit_key_hint = null,
    xendit_key_set_at = null, xendit_callback_set_at = null
  where id = true;
  perform log_action('platform.xendit.disconnected', 'platform_settings', 'true');
  return xendit_status();
end;
$$;
revoke all on function clear_xendit_credentials() from public;
grant execute on function clear_xendit_credentials() to authenticated;

/**
 * What the console may know: everything except the secrets.
 *
 * Both flags are answered from Vault rather than from the stamp columns, so a
 * secret deleted out from under the settings row reads as missing instead of as
 * configured.
 */
create or replace function xendit_status()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  s platform_settings;
begin
  if not (is_franchisor() or is_admin()) then
    raise exception 'Not yours to see' using errcode = 'insufficient_privilege';
  end if;
  select * into s from platform_settings where id = true;
  return jsonb_build_object(
    'enabled',         s.xendit_enabled,
    'mode',            s.xendit_mode,
    'keySet',          vault_read('xendit_secret_key') is not null,
    'keyHint',         s.xendit_key_hint,
    'keySetAt',        s.xendit_key_set_at,
    'callbackSet',     vault_read('xendit_callback_token') is not null,
    'callbackSetAt',   s.xendit_callback_set_at,
    'successUrl',      s.xendit_success_url,
    'invoiceDuration', s.xendit_invoice_duration,
    'walletEnabled',   s.wallet_enabled,
    'vaultAvailable',  to_regnamespace('vault') is not null);
end;
$$;
revoke all on function xendit_status() from public;
grant execute on function xendit_status() to authenticated;

/**
 * The secrets, for the two edge functions that need them and nobody else.
 *
 * service_role only. This is the one door out of Vault, and it is why the
 * console can write a payment key it can never read back.
 */
create or replace function xendit_credentials()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  s platform_settings;
begin
  select * into s from platform_settings where id = true;
  return jsonb_build_object(
    'secretKey',       vault_read('xendit_secret_key'),
    'callbackToken',   vault_read('xendit_callback_token'),
    'mode',            s.xendit_mode,
    'enabled',         s.xendit_enabled,
    'successUrl',      s.xendit_success_url,
    'invoiceDuration', s.xendit_invoice_duration);
end;
$$;
revoke all on function xendit_credentials() from public, anon, authenticated;
grant execute on function xendit_credentials() to service_role;

select hq_attach_readonly_guards();
