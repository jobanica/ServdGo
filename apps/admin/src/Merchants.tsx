/**
 * Partner restaurants — the operator's side of the Servd door.
 *
 * Onboarding one is three things: pin where the rider collects, mint a key, and
 * say where status changes should be posted. The pin is what routes the job, so
 * a restaurant outside every territory is refused a key rather than silently
 * booking into nowhere.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  listMerchants, createMerchant, setMerchantActive, setMerchantWebhook,
  listMerchantKeys, createMerchantKey, revokeMerchantKey, listWebhookDeliveries,
  type Merchant, type MerchantApiKey, type WebhookDelivery,
} from '@servdgo/supabase';
import { errMessage } from '@servdgo/shared';
import { supabase, isSupabaseConfigured } from './lib/supabase.ts';
import { Card, Muted, ErrorNote, Th, Td } from './ui.tsx';

const inp = 'w-full rounded-lg border border-black/10 bg-white px-3 py-2 text-sm outline-none focus:border-brand-orange focus:ring-2 focus:ring-brand-orange/30';

const SAMPLE: Merchant[] = [
  { id: '1', name: 'Lutong Bahay', slug: 'lutong-bahay', pickup_lat: 10.3157, pickup_lng: 123.8854,
    pickup_address: '123 Colon St', territory_id: 't', contact_name: 'Ana', contact_number: '09171112222',
    contact_email: null, webhook_url: 'https://servd.example/hooks/servdgo', is_active: true,
    created_at: new Date().toISOString() },
];

export function Merchants() {
  const [rows, setRows] = useState<Merchant[]>(isSupabaseConfigured ? [] : SAMPLE);
  const [selected, setSelected] = useState<string | null>(null);
  const [keys, setKeys] = useState<MerchantApiKey[]>([]);
  const [deliveries, setDeliveries] = useState<WebhookDelivery[]>([]);
  const [freshKey, setFreshKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState({
    name: '', slug: '', pickupAddress: '', pickupLat: '', pickupLng: '',
    contactName: '', contactNumber: '', webhookUrl: '', webhookSecret: '',
  });

  const load = useCallback(async () => {
    if (!supabase || !isSupabaseConfigured) return;
    try { setRows(await listMerchants(supabase)); }
    catch (e) { setError(errMessage(e)); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const openMerchant = useCallback(async (id: string) => {
    setSelected(id); setFreshKey(null); setError(null);
    if (!supabase || !isSupabaseConfigured) return;
    try {
      const [k, d] = await Promise.all([
        listMerchantKeys(supabase, id),
        listWebhookDeliveries(supabase, id, 20),
      ]);
      setKeys(k); setDeliveries(d);
    } catch (e) { setError(errMessage(e)); }
  }, []);

  async function run(fn: () => Promise<unknown>) {
    setBusy(true); setError(null);
    try { await fn(); await load(); if (selected) await openMerchant(selected); }
    catch (e) { setError(errMessage(e)); }
    finally { setBusy(false); }
  }

  const current = rows.find((r) => r.id === selected) ?? null;

  return (
    <div className="space-y-5">
      {error && <ErrorNote msg={error} />}

      <Card title="Partner restaurants" action={
        <button onClick={() => setAdding((a) => !a)}
          className="rounded-lg bg-brand-orange px-3 py-1.5 text-xs font-semibold text-white hover:opacity-90">
          {adding ? 'Cancel' : 'Add a restaurant'}
        </button>
      }>
        {adding && (
          <div className="mb-4 rounded-xl bg-black/[0.02] p-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Name">
                <input className={inp} value={draft.name}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
              </Field>
              <Field label="Slug">
                <input className={inp} value={draft.slug} placeholder="lutong-bahay"
                  onChange={(e) => setDraft({ ...draft, slug: e.target.value })} />
              </Field>
              <Field label="Pickup address">
                <input className={inp} value={draft.pickupAddress}
                  onChange={(e) => setDraft({ ...draft, pickupAddress: e.target.value })} />
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Pickup latitude">
                  <input className={inp} value={draft.pickupLat} inputMode="decimal"
                    onChange={(e) => setDraft({ ...draft, pickupLat: e.target.value })} />
                </Field>
                <Field label="Pickup longitude">
                  <input className={inp} value={draft.pickupLng} inputMode="decimal"
                    onChange={(e) => setDraft({ ...draft, pickupLng: e.target.value })} />
                </Field>
              </div>
              <Field label="Contact name">
                <input className={inp} value={draft.contactName}
                  onChange={(e) => setDraft({ ...draft, contactName: e.target.value })} />
              </Field>
              <Field label="Contact number">
                <input className={inp} value={draft.contactNumber}
                  onChange={(e) => setDraft({ ...draft, contactNumber: e.target.value })} />
              </Field>
              <Field label="Webhook URL (optional)">
                <input className={inp} value={draft.webhookUrl} placeholder="https://…"
                  onChange={(e) => setDraft({ ...draft, webhookUrl: e.target.value })} />
              </Field>
              <Field label="Webhook signing secret (optional)">
                <input className={inp} value={draft.webhookSecret}
                  onChange={(e) => setDraft({ ...draft, webhookSecret: e.target.value })} />
              </Field>
            </div>
            <button disabled={busy || !draft.name || !draft.slug}
              onClick={() => void run(async () => {
                await createMerchant(supabase!, {
                  name: draft.name, slug: draft.slug,
                  pickupLat: Number(draft.pickupLat), pickupLng: Number(draft.pickupLng),
                  pickupAddress: draft.pickupAddress,
                  contactName: draft.contactName, contactNumber: draft.contactNumber,
                  webhookUrl: draft.webhookUrl, webhookSecret: draft.webhookSecret,
                });
                setAdding(false);
                setDraft({ name: '', slug: '', pickupAddress: '', pickupLat: '', pickupLng: '',
                  contactName: '', contactNumber: '', webhookUrl: '', webhookSecret: '' });
              })}
              className="mt-3 rounded-xl bg-brand-orange px-4 py-2 text-sm font-bold text-white hover:opacity-90 disabled:opacity-50">
              Add restaurant
            </button>
            <Muted>
              The pickup pin decides which city's riders see the job, so it has to sit inside a
              territory you run.
            </Muted>
          </div>
        )}

        {rows.length === 0 ? <Muted>No partner restaurants yet.</Muted> : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm">
              <thead><tr><Th>Restaurant</Th><Th>Pickup</Th><Th>Callbacks</Th><Th>Status</Th><Th>{''}</Th></tr></thead>
              <tbody>
                {rows.map((m) => (
                  <tr key={m.id} className="border-t border-black/5">
                    <Td>
                      <span className="font-semibold">{m.name}</span>
                      <span className="block text-xs text-black/40">{m.slug}</span>
                    </Td>
                    <Td>{m.pickup_address ?? <span className="text-black/40">not pinned</span>}</Td>
                    <Td>{m.webhook_url
                      ? <span className="text-xs">{m.webhook_url}</span>
                      : <span className="text-xs text-black/40">polls instead</span>}</Td>
                    <Td>
                      <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase ${
                        m.is_active ? 'bg-brand-orange/15 text-brand-orange' : 'bg-black/5 text-black/50'}`}>
                        {m.is_active ? 'active' : 'off'}
                      </span>
                    </Td>
                    <Td>
                      <button onClick={() => void openMerchant(m.id)}
                        className="rounded-lg px-2.5 py-1 text-xs font-semibold ring-1 ring-black/10 hover:bg-black/5">
                        Manage
                      </button>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {current && (
        <>
          <Card title={`${current.name} — API keys`}>
            {freshKey && (
              <div className="mb-3 rounded-xl bg-brand-orange/10 p-3">
                <p className="text-sm font-semibold text-brand-orange">
                  Copy this now — it is never shown again.
                </p>
                <code className="mt-1 block break-all rounded-lg bg-white px-3 py-2 text-xs">{freshKey}</code>
              </div>
            )}
            {keys.length === 0 ? <Muted>No keys yet.</Muted> : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[560px] text-sm">
                  <thead><tr><Th>Key</Th><Th>Label</Th><Th>Last used</Th><Th>{''}</Th></tr></thead>
                  <tbody>
                    {keys.map((k) => (
                      <tr key={k.id} className="border-t border-black/5">
                        <Td><code className="text-xs">{k.prefix}…</code></Td>
                        <Td>{k.label ?? '—'}</Td>
                        <Td>{k.last_used_at ? new Date(k.last_used_at).toLocaleString() : 'never'}</Td>
                        <Td>
                          {k.revoked_at ? <span className="text-xs text-black/40">revoked</span> : (
                            <button disabled={busy}
                              onClick={() => void run(() => revokeMerchantKey(supabase!, k.id))}
                              className="rounded-lg px-2.5 py-1 text-xs font-semibold ring-1 ring-black/10 hover:bg-black/5 disabled:opacity-50">
                              Revoke
                            </button>
                          )}
                        </Td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <div className="mt-3 flex flex-wrap gap-2">
              <button disabled={busy}
                onClick={() => void run(async () => {
                  setFreshKey(await createMerchantKey(supabase!, current.id, 'Servd'));
                })}
                className="rounded-xl bg-brand-orange px-4 py-2 text-sm font-bold text-white hover:opacity-90 disabled:opacity-50">
                Mint a key
              </button>
              <button disabled={busy}
                onClick={() => void run(() => setMerchantActive(supabase!, current.id, !current.is_active))}
                className="rounded-xl px-4 py-2 text-sm font-semibold ring-1 ring-black/10 hover:bg-black/5 disabled:opacity-50">
                {current.is_active ? 'Deactivate restaurant' : 'Reactivate restaurant'}
              </button>
            </div>
            <Muted>
              One key per restaurant, not one shared key — a leak has to be revocable without
              taking every other restaurant offline with it. Only a hash is stored, so a key
              cannot be read back out.
            </Muted>
          </Card>

          <Card title="Recent callbacks">
            {deliveries.length === 0 ? (
              <Muted>Nothing sent yet. A restaurant with no webhook URL polls instead.</Muted>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[560px] text-sm">
                  <thead><tr><Th>Event</Th><Th>When</Th><Th>Tries</Th><Th>Status</Th><Th>Last error</Th></tr></thead>
                  <tbody>
                    {deliveries.map((d) => (
                      <tr key={d.id} className="border-t border-black/5">
                        <Td><code className="text-xs">{d.event}</code></Td>
                        <Td>{new Date(d.created_at).toLocaleString()}</Td>
                        <Td>{d.attempts}</Td>
                        <Td>
                          <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase ${
                            d.status === 'delivered' ? 'bg-brand-orange/15 text-brand-orange'
                              : d.status === 'failed' ? 'bg-brand-yellow/30 text-yellow-800'
                              : 'bg-black/5 text-black/50'}`}>
                            {d.status}
                          </span>
                        </Td>
                        <Td><span className="text-xs text-black/50">{d.last_error ?? '—'}</span></Td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          <Card title="Where callbacks go">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Webhook URL">
                <input className={inp} defaultValue={current.webhook_url ?? ''} id="wh-url" />
              </Field>
              <Field label="Signing secret">
                <input className={inp} placeholder="leave blank to keep" id="wh-secret" />
              </Field>
            </div>
            <button disabled={busy}
              onClick={() => void run(() => {
                const url = (document.getElementById('wh-url') as HTMLInputElement).value.trim();
                const secret = (document.getElementById('wh-secret') as HTMLInputElement).value.trim();
                return setMerchantWebhook(supabase!, current.id, url || null, secret || null);
              })}
              className="mt-3 rounded-xl bg-brand-orange px-4 py-2 text-sm font-bold text-white hover:opacity-90 disabled:opacity-50">
              Save
            </button>
            <Muted>
              Every callback is signed with this secret, so Servd can tell a real one from anything
              else that finds the URL. Leave the URL blank and they poll instead.
            </Muted>
          </Card>
        </>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium">{label}</span>
      {children}
    </label>
  );
}
