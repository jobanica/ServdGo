/**
 * Settings that apply to the whole network, and the flags that let one city
 * differ from them.
 *
 * A flag has a platform default and an optional override per city. The override
 * row is the exception, so clearing it — rather than setting it to match — is
 * what puts a city back under the default. The table shows which is which.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  getPlatformSettings, savePlatformSettings, listFeatureFlags, listFlagOverrides,
  setFlagDefault, setFlagOverride, listTerritories,
  type PlatformSettings, type FeatureFlag, type FeatureFlagOverride, type Territory,
} from '@servdgo/supabase';
import { errMessage } from '@servdgo/shared';
import { supabase, isSupabaseConfigured } from '../lib/supabase.ts';
import { Card, Muted, ErrorNote, Toggle } from '../ui.tsx';
import { Xendit } from './Xendit.tsx';

const Field = ({ label, hint, children }:
  { label: string; hint?: string; children: React.ReactNode }) => (
  <label className="block">
    <span className="text-xs font-semibold uppercase tracking-wide text-black/40">{label}</span>
    {children}
    {hint && <span className="mt-1 block text-xs text-black/45">{hint}</span>}
  </label>
);

export function Platform() {
  const [settings, setSettings] = useState<PlatformSettings | null>(null);
  const [flags, setFlags] = useState<FeatureFlag[]>([]);
  const [overrides, setOverrides] = useState<FeatureFlagOverride[]>([]);
  const [cities, setCities] = useState<Territory[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!supabase || !isSupabaseConfigured) return;
    setError(null);
    try {
      const [s, f, o, t] = await Promise.all([
        getPlatformSettings(supabase), listFeatureFlags(supabase),
        listFlagOverrides(supabase), listTerritories(supabase),
      ]);
      setSettings(s); setFlags(f); setOverrides(o); setCities(t);
    } catch (e) { setError(errMessage(e)); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function run(fn: () => Promise<unknown>, done: string) {
    setBusy(true); setError(null); setNote(null);
    try { await fn(); await load(); setNote(done); }
    catch (e) { setError(errMessage(e)); }
    finally { setBusy(false); }
  }

  if (!isSupabaseConfigured) return <Muted>Connect Supabase to manage platform settings.</Muted>;
  if (!settings) return <Muted>Loading…</Muted>;

  const patch = (p: Partial<PlatformSettings>) => setSettings({ ...settings, ...p });
  const overrideFor = (key: string, city: string) =>
    overrides.find((o) => o.flag_key === key && o.territory_id === city);

  return (
    <div className="space-y-5">
      {error && <ErrorNote msg={error} />}
      {note && <p className="rounded-xl bg-brand-orange/10 px-3 py-2 text-sm text-brand-orange">{note}</p>}

      <Card title="Minimum app versions"
        action={<button disabled={busy}
          onClick={() => void run(() => savePlatformSettings(supabase!, {
            min_rider_app_version: settings.min_rider_app_version,
            min_customer_app_version: settings.min_customer_app_version,
            support_email: settings.support_email,
            support_mobile: settings.support_mobile,
            maintenance_message: settings.maintenance_message,
          }), 'Saved')}
          className="rounded-xl bg-brand-orange px-3 py-2 text-sm font-semibold text-white disabled:opacity-50">
          Save
        </button>}>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Rider app" hint="Older builds are held at an update screen before sign-in.">
            <input value={settings.min_rider_app_version}
              onChange={(e) => patch({ min_rider_app_version: e.target.value })}
              className="mt-1 w-full rounded-lg border border-black/10 px-3 py-2 text-sm" />
          </Field>
          <Field label="Customer app">
            <input value={settings.min_customer_app_version}
              onChange={(e) => patch({ min_customer_app_version: e.target.value })}
              className="mt-1 w-full rounded-lg border border-black/10 px-3 py-2 text-sm" />
          </Field>
          <Field label="Support email">
            <input value={settings.support_email ?? ''}
              onChange={(e) => patch({ support_email: e.target.value || null })}
              className="mt-1 w-full rounded-lg border border-black/10 px-3 py-2 text-sm" />
          </Field>
          <Field label="Support mobile">
            <input value={settings.support_mobile ?? ''}
              onChange={(e) => patch({ support_mobile: e.target.value || null })}
              className="mt-1 w-full rounded-lg border border-black/10 px-3 py-2 text-sm" />
          </Field>
          <div className="sm:col-span-2">
            <Field label="Maintenance message"
              hint="Shown in every app when set. Leave empty when nothing is wrong.">
              <textarea rows={2} value={settings.maintenance_message ?? ''}
                onChange={(e) => patch({ maintenance_message: e.target.value || null })}
                className="mt-1 w-full rounded-lg border border-black/10 px-3 py-2 text-sm" />
            </Field>
          </div>
        </div>
      </Card>

      <Card title="Commission band and royalty">
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Commission floor" hint="Operators cannot charge riders less.">
            <input type="number" step="0.01" value={settings.commission_rate_min}
              onChange={(e) => patch({ commission_rate_min: Number(e.target.value) })}
              className="mt-1 w-full rounded-lg border border-black/10 px-3 py-2 text-sm" />
          </Field>
          <Field label="Commission ceiling">
            <input type="number" step="0.01" value={settings.commission_rate_max}
              onChange={(e) => patch({ commission_rate_max: Number(e.target.value) })}
              className="mt-1 w-full rounded-lg border border-black/10 px-3 py-2 text-sm" />
          </Field>
          <Field label="Royalty rate" hint="Your share of what a city collects.">
            <input type="number" step="0.01" value={settings.royalty_rate}
              onChange={(e) => patch({ royalty_rate: Number(e.target.value) })}
              className="mt-1 w-full rounded-lg border border-black/10 px-3 py-2 text-sm" />
          </Field>
        </div>
        <button disabled={busy}
          onClick={() => void run(() => savePlatformSettings(supabase!, {
            commission_rate_min: settings.commission_rate_min,
            commission_rate_max: settings.commission_rate_max,
            royalty_rate: settings.royalty_rate,
          }), 'Saved')}
          className="mt-4 rounded-xl bg-brand-orange px-3 py-2 text-sm font-semibold text-white disabled:opacity-50">
          Save
        </button>
      </Card>

      <Card title="Rider wallets">
        <p className="mb-4 max-w-2xl text-sm text-black/55">
          With wallets on, a rider prepays and every delivery deducts its commission
          the moment it is booked — so nobody settles cash at the end of the day, and
          your royalty is collected before the city ever sees the money. What is left
          of each commission becomes a daily payout you owe that city, on the
          Operator payouts screen.
        </p>
        <p className="mb-4 max-w-2xl rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900 ring-1 ring-amber-200">
          Turning this on moves every rider onto prepay. A rider whose wallet is
          short at midnight cannot accept work the next day until they top up, so
          tell them before you switch it.
        </p>
        <div className="flex items-center gap-3">
          <Toggle on={settings.wallet_enabled}
            onChange={(on) => void run(() => savePlatformSettings(supabase!, { wallet_enabled: on })
              .then(() => { patch({ wallet_enabled: on }); }), on ? 'Wallets are on' : 'Wallets are off')} />
          <span className="text-sm font-semibold">
            {settings.wallet_enabled ? 'On — riders prepay' : 'Off — riders settle in cash'}
          </span>
        </div>
        <div className="mt-4 grid gap-4 sm:grid-cols-4">
          <Field label="Smallest top-up">
            <input type="number" step="1" value={settings.wallet_min_topup}
              onChange={(e) => patch({ wallet_min_topup: Number(e.target.value) })}
              className="mt-1 w-full rounded-lg border border-black/10 px-3 py-2 text-sm" />
          </Field>
          <Field label="Largest top-up">
            <input type="number" step="1" value={settings.wallet_max_topup}
              onChange={(e) => patch({ wallet_max_topup: Number(e.target.value) })}
              className="mt-1 w-full rounded-lg border border-black/10 px-3 py-2 text-sm" />
          </Field>
          <Field label="Warn below" hint="The rider app nudges them to top up.">
            <input type="number" step="1" value={settings.wallet_low_balance}
              onChange={(e) => patch({ wallet_low_balance: Number(e.target.value) })}
              className="mt-1 w-full rounded-lg border border-black/10 px-3 py-2 text-sm" />
          </Field>
          <Field label="Credit limit" hint="How far under they may go overnight. Zero is strict prepay.">
            <input type="number" step="1" value={settings.wallet_credit_limit}
              onChange={(e) => patch({ wallet_credit_limit: Number(e.target.value) })}
              className="mt-1 w-full rounded-lg border border-black/10 px-3 py-2 text-sm" />
          </Field>
        </div>
        <button disabled={busy}
          onClick={() => void run(() => savePlatformSettings(supabase!, {
            wallet_min_topup: settings.wallet_min_topup,
            wallet_max_topup: settings.wallet_max_topup,
            wallet_low_balance: settings.wallet_low_balance,
            wallet_credit_limit: settings.wallet_credit_limit,
          }), 'Saved')}
          className="mt-4 rounded-xl bg-brand-orange px-3 py-2 text-sm font-semibold text-white disabled:opacity-50">
          Save
        </button>
      </Card>

      <Xendit />

      <Card title="Feature flags">
        {flags.length === 0 ? <p className="text-sm text-black/50">No flags defined.</p> : (
          <div className="-mx-5 overflow-x-auto px-5">
            <table className="w-full min-w-[40rem] text-left text-sm">
              <thead className="border-b border-black/5 text-xs uppercase tracking-wide text-black/40">
                <tr>
                  <th className="py-2 pr-4 font-medium">Feature</th>
                  <th className="py-2 pr-4 font-medium">Default</th>
                  {cities.map((c) => (
                    <th key={c.id} className="py-2 pr-4 font-medium">{c.name}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-black/5">
                {flags.map((f) => (
                  <tr key={f.key} className="align-top">
                    <td className="py-3 pr-4">
                      <p className="font-semibold">{f.key}</p>
                      <p className="text-xs text-black/50">{f.description}</p>
                    </td>
                    <td className="py-3 pr-4">
                      <Toggle on={f.default_enabled} disabled={busy}
                        onChange={(v) => void run(() => setFlagDefault(supabase!, f.key, v),
                          `${f.key} default ${v ? 'on' : 'off'}`)} />
                    </td>
                    {cities.map((c) => {
                      const o = overrideFor(f.key, c.id);
                      const on = o ? o.enabled : f.default_enabled;
                      return (
                        <td key={c.id} className="py-3 pr-4">
                          <Toggle on={on} disabled={busy}
                            onChange={(v) => void run(
                              () => setFlagOverride(supabase!, f.key, c.id,
                                v === f.default_enabled ? null : v),
                              v === f.default_enabled
                                ? `${c.name} follows the default again`
                                : `${c.name} overridden`)} />
                          <p className="mt-1 text-[11px] text-black/40">
                            {o ? 'overridden' : 'default'}
                          </p>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="mt-3 text-xs text-black/45">
          Setting a city back to the platform default removes its override, so it follows any
          future change to that default.
        </p>
      </Card>
    </div>
  );
}
