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
import {
  generatePassword, keyUsage, territoryForPoint, refreshMerchantTerritory,
  listTerritories, type KeyUsage, type Territory,
} from '@servdgo/supabase';
import { supabase, isSupabaseConfigured, functionsBaseUrl } from './lib/supabase.ts';
import { Card, Muted, ErrorNote, Th, Td } from './ui.tsx';
import { MapPicker, type MapValue } from './MapPicker.tsx';

const inp = 'w-full rounded-lg border border-black/10 bg-white px-3 py-2 text-sm outline-none focus:border-brand-orange focus:ring-2 focus:ring-brand-orange/30';

/** A URL-safe handle from the restaurant's name, so nobody has to invent one. */
const slugify = (name: string) =>
  name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);

/**
 * The secret we sign callbacks with.
 *
 * Generated here, not by the restaurant: it is shared, and the side that has to
 * be sure it is random should be the side that makes it.
 */
const newSigningSecret = () => `whsec_${generatePassword(32)}`;

/** The street address at a pin, from OpenStreetMap. Null when it cannot say. */
async function addressAt(lat: number, lng: number): Promise<string | null> {
  try {
    const res = await fetch(
      `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}`,
      { headers: { 'Accept-Language': 'en' } });
    const hit = await res.json() as { display_name?: string };
    return hit.display_name ?? null;
  } catch { return null; }
}

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
  const [whUrl, setWhUrl] = useState('');
  const [note, setNote] = useState<string | null>(null);
  const [whSecret, setWhSecret] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState({
    name: '', slug: '', pickupAddress: '', pickupLat: '', pickupLng: '',
    contactName: '', contactNumber: '', webhookUrl: '', webhookSecret: '',
  });
  const [allKeys, setAllKeys] = useState<KeyUsage[]>([]);
  const [cities, setCities] = useState<Territory[]>([]);
  // Which city the pin currently falls in — the answer the operator needs
  // *before* saving, since it is what decides whether a key can ever be minted.
  const [pinCity, setPinCity] = useState<string | null | undefined>(undefined);
  const [slugTouched, setSlugTouched] = useState(false);
  const [fillingAddress, setFillingAddress] = useState(false);

  // The map's value and the two number fields are the same thing seen twice.
  const pin: MapValue | null =
    draft.pickupLat && draft.pickupLng
      && Number.isFinite(Number(draft.pickupLat)) && Number.isFinite(Number(draft.pickupLng))
      ? { lat: Number(draft.pickupLat), lng: Number(draft.pickupLng) }
      : null;

  const load = useCallback(async () => {
    if (!supabase || !isSupabaseConfigured) return;
    try {
      const [ms, ks, ts] = await Promise.all([
        listMerchants(supabase), keyUsage(supabase), listTerritories(supabase),
      ]);
      setRows(ms); setAllKeys(ks); setCities(ts);
    } catch (e) { setError(errMessage(e)); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const openMerchant = useCallback(async (id: string) => {
    setSelected(id); setFreshKey(null); setError(null);
    // The secret is write-only — we hold a hash of nothing here, so the field
    // starts empty and blank means "keep what is already set".
    setWhSecret('');
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

  // Ask the database which city the pin lands in. Doing it here rather than
  // comparing circles in the browser means the answer is the same one that will
  // be used when the row is written.
  useEffect(() => {
    if (!supabase || !pin) { setPinCity(undefined); return; }
    let alive = true;
    const t = setTimeout(() => {
      void territoryForPoint(supabase!, pin.lat, pin.lng)
        .then((id) => { if (alive) setPinCity(id); })
        .catch(() => { if (alive) setPinCity(undefined); });
    }, 350);
    return () => { alive = false; clearTimeout(t); };
  }, [pin?.lat, pin?.lng]);

  /**
   * Mint a key for a restaurant and leave it on screen.
   *
   * Deliberately not routed through run(): that reloads and reopens the
   * restaurant afterwards, which clears freshKey — and a key that is shown once
   * and then wiped by a refresh is a key nobody got.
   */
  async function mintFor(id: string) {
    if (!supabase) return;
    setBusy(true); setError(null);
    try {
      setSelected(id);
      const key = await createMerchantKey(supabase, id, 'Servd');
      const [k, d, all] = await Promise.all([
        listMerchantKeys(supabase, id),
        listWebhookDeliveries(supabase, id, 20),
        keyUsage(supabase),
      ]);
      setKeys(k); setDeliveries(d); setAllKeys(all); setFreshKey(key);
    } catch (e) { setError(errMessage(e)); }
    finally { setBusy(false); }
  }

  const activeKeys = (merchantId: string) =>
    allKeys.filter((k) => k.merchant_id === merchantId && !k.revoked_at).length;

  const current = rows.find((r) => r.id === selected) ?? null;

  // The URL is readable, so the field shows what is set; the secret is not.
  useEffect(() => { setWhUrl(current?.webhook_url ?? ''); }, [current?.id]);

  return (
    <div className="space-y-5">
      {error && <ErrorNote msg={error} />}
      {note && <p className="rounded-xl bg-brand-orange/10 px-3 py-2 text-sm text-brand-orange">{note}</p>}

      <Card title="Partner restaurants" action={
        <button onClick={() => setAdding((a) => !a)}
          className="rounded-lg bg-brand-orange px-3 py-1.5 text-xs font-semibold text-white hover:opacity-90">
          {adding ? 'Cancel' : 'Add a restaurant'}
        </button>
      }>
        {adding && (
          <div className="mb-4 space-y-3 rounded-xl bg-black/[0.02] p-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Name">
                <input className={inp} value={draft.name}
                  onChange={(e) => setDraft({
                    ...draft,
                    name: e.target.value,
                    // The slug follows the name until somebody edits it themselves.
                    slug: slugTouched ? draft.slug : slugify(e.target.value),
                  })} />
              </Field>
              <Field label="Slug">
                <input className={inp} value={draft.slug} placeholder="lutong-bahay"
                  onChange={(e) => { setSlugTouched(true); setDraft({ ...draft, slug: e.target.value }); }} />
              </Field>
            </div>

            <Field label="Where the rider collects">
              <MapPicker value={pin} onChange={(v) => {
                setDraft((d) => ({ ...d, pickupLat: String(v.lat), pickupLng: String(v.lng) }));
              }} height={260} />
              {pin && pinCity && (
                <p className="mt-2 rounded-lg bg-brand-orange/10 px-3 py-2 text-xs text-brand-orange">
                  This pin is in <b>{cities.find((c) => c.id === pinCity)?.name ?? 'a city you run'}</b> —
                  its riders will see the job.
                </p>
              )}
              {pin && pinCity === null && (
                <p className="mt-2 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">
                  This pin is not inside any live city with a boundary drawn. The restaurant can be
                  added, but it cannot be given an API key until a city covers it — the franchisor
                  draws boundaries under <b>Territories → the city → Territory</b>.
                </p>
              )}
            </Field>

            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Pickup address">
                <div className="flex gap-2">
                  <input className={inp} value={draft.pickupAddress}
                    onChange={(e) => setDraft({ ...draft, pickupAddress: e.target.value })} />
                  <button type="button" disabled={!pin || fillingAddress}
                    onClick={() => void (async () => {
                      if (!pin) return;
                      setFillingAddress(true);
                      const found = await addressAt(pin.lat, pin.lng);
                      if (found) setDraft((d) => ({ ...d, pickupAddress: found }));
                      setFillingAddress(false);
                    })()}
                    className="shrink-0 rounded-lg px-3 py-2 text-xs font-semibold ring-1 ring-black/10 hover:bg-black/5 disabled:opacity-40">
                    {fillingAddress ? '…' : 'From pin'}
                  </button>
                </div>
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
            </div>

            <div className="rounded-xl bg-white p-3 ring-1 ring-black/5">
              <p className="text-sm font-semibold">Callbacks — optional, and theirs to provide</p>
              <p className="mt-1 text-xs text-black/55">
                The <b>URL</b> is an endpoint on the restaurant's own system; ask them for it. Leave
                it blank and they poll us for status instead — nothing breaks. The <b>secret</b> is
                ours to generate: we sign every callback with it so they can tell a real one from
                anything else that finds the URL. Generate it here and send it with their API key.
              </p>
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <Field label="Webhook URL">
                  <input className={inp} value={draft.webhookUrl} placeholder="https://their-system.example/hooks/servdgo"
                    onChange={(e) => setDraft({ ...draft, webhookUrl: e.target.value })} />
                </Field>
                <Field label="Signing secret">
                  <div className="flex gap-2">
                    <input className={`${inp} font-mono`} value={draft.webhookSecret}
                      onChange={(e) => setDraft({ ...draft, webhookSecret: e.target.value })} />
                    <button type="button" onClick={() => setDraft({ ...draft, webhookSecret: newSigningSecret() })}
                      className="shrink-0 rounded-lg px-3 py-2 text-xs font-semibold ring-1 ring-black/10 hover:bg-black/5">
                      Generate
                    </button>
                  </div>
                </Field>
              </div>
            </div>

            <button disabled={busy || !draft.name || !draft.slug || !pin}
              onClick={() => void (async () => {
                if (!supabase) return;
                setBusy(true); setError(null);
                try {
                  const id = await createMerchant(supabase, {
                    name: draft.name, slug: draft.slug,
                    pickupLat: Number(draft.pickupLat), pickupLng: Number(draft.pickupLng),
                    pickupAddress: draft.pickupAddress,
                    contactName: draft.contactName, contactNumber: draft.contactNumber,
                    webhookUrl: draft.webhookUrl, webhookSecret: draft.webhookSecret,
                  });
                  setAdding(false); setSlugTouched(false);
                  setDraft({ name: '', slug: '', pickupAddress: '', pickupLat: '', pickupLng: '',
                    contactName: '', contactNumber: '', webhookUrl: '', webhookSecret: '' });
                  await load();
                  // Straight onto the key panel: a restaurant without a key
                  // cannot call anything, so this is not a separate errand.
                  await openMerchant(id);
                } catch (e) { setError(errMessage(e)); }
                finally { setBusy(false); }
              })()}
              className="rounded-xl bg-brand-orange px-4 py-2 text-sm font-bold text-white hover:opacity-90 disabled:opacity-50">
              Add restaurant
            </button>
            <Muted>
              {pin
                ? "The pickup pin decides which city's riders see the job, so it has to sit inside a territory you run."
                : 'Drop the pin first — it is what routes the job to a city, so a restaurant cannot be added without one.'}
            </Muted>
          </div>
        )}

        {rows.length === 0 ? (
          <Muted>
            No partner restaurants yet. Add one — its API key is minted afterwards, on the
            restaurant itself, because a key belongs to a restaurant rather than to the city.
          </Muted>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm">
              <thead><tr><Th>Restaurant</Th><Th>Pickup</Th><Th>API key</Th><Th>Callbacks</Th><Th>Status</Th><Th>{''}</Th></tr></thead>
              <tbody>
                {rows.map((m) => (
                  <tr key={m.id} className="border-t border-black/5">
                    <Td>
                      <span className="font-semibold">{m.name}</span>
                      <span className="block text-xs text-black/40">{m.slug}</span>
                    </Td>
                    <Td>{m.pickup_address ?? <span className="text-black/40">not pinned</span>}</Td>
                    <Td>
                      {activeKeys(m.id) > 0 ? <span className="text-xs">{activeKeys(m.id)} active</span>
                        : m.territory_id ? (
                          <button disabled={busy} onClick={() => void mintFor(m.id)}
                            className="rounded-lg bg-brand-orange px-2.5 py-1 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-50">
                            Mint a key
                          </button>
                        ) : (
                          <div>
                            <span className="block text-xs text-red-700">in no city</span>
                            <button disabled={busy}
                              onClick={() => void run(() => refreshMerchantTerritory(supabase!, m.id))}
                              className="mt-1 rounded-lg px-2 py-0.5 text-[11px] font-semibold ring-1 ring-black/10 hover:bg-black/5 disabled:opacity-50">
                              Re-check the pin
                            </button>
                          </div>
                        )}
                    </Td>
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
              <button disabled={busy} onClick={() => void mintFor(current.id)}
                className="rounded-xl bg-brand-orange px-4 py-2 text-sm font-bold text-white hover:opacity-90 disabled:opacity-50">
                {keys.some((k) => !k.revoked_at) ? 'Mint another key' : 'Mint a key'}
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

          <Card title="What the restaurant needs from us">
            <p className="text-sm text-black/60">
              Three values go into their side. Two are secrets you send once; the third is simply
              where our API lives, and it is the same for every restaurant.
            </p>

            <div className="mt-3 divide-y divide-black/5">
              <CopyRow label="API base URL" value={functionsBaseUrl}
                missing="Set VITE_SUPABASE_URL to show this."
                hint="No trailing slash. Their client appends /merchant-quote, /merchant-book and the rest." />
              <CopyRow label="API key" value={freshKey}
                missing={keys.some((k) => !k.revoked_at)
                  ? 'Already issued, and never shown again. Mint another above if it was lost.'
                  : 'Mint one above — it appears here once, at that moment.'}
                hint="Sent as X-API-Key, or Authorization: Bearer. One key per restaurant." />
              <CopyRow label="Signing secret" value={whSecret.trim() || null}
                missing="Write-only once saved. Generate a new one below if it was lost."
                hint="Only shown while it is in the field below — we keep no readable copy." />
              <CopyRow label="Provider name" value="servdgo"
                hint="If they run Servd, typing this in their delivery settings selects the ServdGo adapter." />
            </div>

            {functionsBaseUrl && (
              <button type="button"
                onClick={() => {
                  const lines = [
                    `ServdGo delivery API — ${current.name}`,
                    `Provider name: servdgo`,
                    `API base URL: ${functionsBaseUrl}`,
                    freshKey ? `API key: ${freshKey}` : 'API key: (sent separately)',
                    whSecret.trim()
                      ? `Webhook signing secret: ${whSecret.trim()}`
                      : 'Webhook signing secret: (sent separately)',
                    '',
                    'Endpoints: POST /merchant-quote, POST /merchant-book,',
                    'GET /merchant-order?reference=…, POST /merchant-cancel',
                    'Callbacks are signed: X-ServdGo-Signature: t=<unix>,v1=<hex>',
                    'v1 = HMAC-SHA256(secret, `${t}.${raw body}`) — reject anything over 5 minutes old.',
                  ];
                  void navigator.clipboard.writeText(lines.join('\n')).catch(() => {});
                  setNote('Copied — paste it into the message you send them.');
                }}
                className="mt-3 rounded-xl bg-brand-orange px-4 py-2 text-sm font-bold text-white hover:opacity-90">
                Copy the whole hand-over
              </button>
            )}
            <Muted>
              The base URL is not a setting — it is where this deployment's endpoints are. Nobody
              should have to ask for it.
            </Muted>
          </Card>

          <Card title="Where callbacks go">
            <p className="text-sm text-black/60">
              When an order changes hands — accepted, picked up, delivered — we POST it to the
              restaurant's own endpoint. That URL comes <b>from them</b>; ask their developer for
              it. Leave it blank and they poll us instead, which is a perfectly good way to run.
            </p>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <Field label="Webhook URL">
                <input className={inp} value={whUrl} placeholder="https://their-system.example/hooks/servdgo"
                  onChange={(e) => setWhUrl(e.target.value)} />
              </Field>
              <Field label="Signing secret">
                <div className="flex gap-2">
                  <input className={`${inp} font-mono`} value={whSecret}
                    placeholder="leave blank to keep the current one"
                    onChange={(e) => setWhSecret(e.target.value)} />
                  <button type="button" onClick={() => setWhSecret(newSigningSecret())}
                    className="shrink-0 rounded-lg px-3 py-2 text-xs font-semibold ring-1 ring-black/10 hover:bg-black/5">
                    Generate
                  </button>
                </div>
              </Field>
            </div>
            <button disabled={busy}
              onClick={() => void run(() =>
                setMerchantWebhook(supabase!, current.id, whUrl.trim() || null, whSecret.trim() || null))}
              className="mt-3 rounded-xl bg-brand-orange px-4 py-2 text-sm font-bold text-white hover:opacity-90 disabled:opacity-50">
              Save
            </button>

            <div className="mt-4 rounded-xl bg-black/[0.02] p-3">
              <p className="text-sm font-semibold">What to send their developer</p>
              <p className="mt-1 text-xs text-black/55">
                Their API key (minted above, shown once), this signing secret, and how to check it.
                Every callback carries a header signed with the secret:
              </p>
              <pre className="mt-2 overflow-x-auto rounded-lg bg-white p-3 text-xs ring-1 ring-black/5">
{`X-ServdGo-Signature: t=<unix seconds>,v1=<hex>

v1 = HMAC-SHA256(secret, "\${t}.\${raw request body}")`}
              </pre>
              <p className="mt-2 text-xs text-black/55">
                They recompute it and compare. The timestamp is inside the signed string, so a
                captured callback cannot be replayed later — tell them to reject anything more than
                a few minutes old. A failure is retried with backoff and eventually parked, not
                lost — anything that got that far is on HQ's Callbacks screen and can be replayed
                by hand.
              </p>
            </div>
          </Card>
        </>
      )}
    </div>
  );
}

/**
 * One value the restaurant has to be given, with the button that puts it on the
 * clipboard. Copying is the whole point — these are long strings that get typed
 * into somebody else's settings screen, and a typo is a support ticket.
 */
function CopyRow({ label, value, hint, missing }: {
  label: string; value: string | null; hint?: string; missing?: string;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="py-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="w-40 shrink-0 text-xs font-semibold uppercase tracking-wide text-black/40">
          {label}
        </span>
        {value ? (
          <>
            <code className="min-w-0 flex-1 break-all rounded-lg bg-white px-2 py-1 text-xs ring-1 ring-black/5">
              {value}
            </code>
            <button type="button"
              onClick={() => {
                void navigator.clipboard.writeText(value).catch(() => {});
                setCopied(true);
                setTimeout(() => setCopied(false), 2000);
              }}
              className="shrink-0 rounded-lg px-2 py-1 text-xs font-semibold ring-1 ring-black/10 hover:bg-black/5">
              {copied ? 'Copied' : 'Copy'}
            </button>
          </>
        ) : (
          <span className="flex-1 text-xs text-black/45">{missing}</span>
        )}
      </div>
      {hint && <p className="mt-1 pl-0 text-xs text-black/45 sm:pl-[10.5rem]">{hint}</p>}
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
