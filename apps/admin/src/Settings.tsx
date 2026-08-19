import { useEffect, useState } from 'react';
import { getAppSettings, updateAppSettings, uploadSettlementQr, getPlatformStatus,
  type AppSettings, type PlatformStatus } from '@ebd/supabase';
import { commission, distanceDeliveryFee,
  errMessage,
} from '@ebd/shared';
import { supabase } from './lib/supabase.ts';
import { Card, Muted, peso } from './ui.tsx';

const SAMPLE: AppSettings = {
  is_open: true, closed_message: null, schedule: null, default_delivery_fee: 50, per_store_fee: 25,
  convenience_fee: 0, convenience_fee_food: 0, convenience_fee_pabili: 0, convenience_fee_padala: 0,
  commission_rate: 0.15, markup_operator_share: 1, delivery_fee_model: 'flat',
  settlement_cutoff: '00:00', sms_notify_stores: false,
  delivery_base_fare: 50, delivery_base_km: 2, delivery_per_km: 10,
  service_food: true, service_pabili: true, service_padala: true,
  max_active_orders_per_rider: 0,
  settlement_gcash_number: null, settlement_gcash_name: null, settlement_qr_url: null,
  service_center_lat: null, service_center_lng: null, service_radius_km: 0,
};

const inp = 'w-full rounded-lg border border-black/10 bg-white px-3 py-2 text-sm outline-none focus:border-brand-green focus:ring-2 focus:ring-brand-green/30';

export function Settings() {
  const [s, setS] = useState<AppSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [previewKm, setPreviewKm] = useState(5);
  const [qrBusy, setQrBusy] = useState(false);

  async function uploadQr(file: File) {
    if (!supabase) return;
    setQrBusy(true); setError(null);
    try { set('settlement_qr_url', await uploadSettlementQr(supabase, file)); }
    catch (e) { setError(errMessage(e)); }
    finally { setQrBusy(false); }
  }

  useEffect(() => {
    (async () => {
      if (!supabase) { setS(SAMPLE); return; }
      try { setS(await getAppSettings(supabase)); }
      catch (e) { setError(errMessage(e)); setS(SAMPLE); }
    })();
  }, []);

  if (!s) return <Muted>Loading…</Muted>;

  function set<K extends keyof AppSettings>(k: K, v: AppSettings[K]) {
    setS((cur) => cur ? { ...cur, [k]: v } : cur);
    setSaved(false);
  }

  async function save() {
    if (!supabase || !s) return;
    setSaving(true); setError(null);
    try {
      await updateAppSettings(supabase, s);
      setSaved(true);
    } catch (e) { setError(errMessage(e)); }
    finally { setSaving(false); }
  }

  // Live example: DF + 3 stores (2 added) at the current rate.
  const example = commission(
    { deliveryFee: s.default_delivery_fee, storeCount: 3 },
    { perStoreFee: s.per_store_fee, commissionRate: s.commission_rate, convenienceFee: s.convenience_fee },
  );

  return (
    <div className="max-w-3xl space-y-5">
      {/* Operating hours */}
      <Card title="Operating hours">
        <label className="flex items-center justify-between">
          <span>
            <span className="block text-sm font-medium">Platform is {s.is_open ? 'open' : 'closed'}</span>
            <span className="block text-xs text-black/50">
              Closing stops new orders immediately. Orders already placed are unaffected — riders
              keep accepting from the pool and delivering until the queue is empty.
            </span>
          </span>
          <Toggle on={s.is_open} onChange={(v) => set('is_open', v)} />
        </label>

        {!s.is_open && (
          <div className="mt-3 rounded-xl bg-brand-yellow/15 p-3">
            <QueueDrain />
            <label className="mt-3 block">
              <span className="block text-sm font-medium">What customers and riders see</span>
              <textarea rows={2} value={s.closed_message ?? ''}
                onChange={(e) => set('closed_message', e.target.value)}
                placeholder="Closed for the day — we reopen at 8am. Thank you!"
                className="mt-1 w-full rounded-lg border border-black/10 px-3 py-2 text-sm" />
              <span className="mt-1 block text-xs text-black/50">
                Leave blank for the default wording.
              </span>
            </label>
          </div>
        )}
      </Card>

      {/* Services */}
      <Card title="Services">
        <p className="mb-3 text-sm text-black/60">
          Turn a whole service on or off. When off, customers see it greyed out and can’t order it.
        </p>
        <div className="divide-y divide-black/5">
          <ServiceRow label="Food / Restaurants" desc="Browse stores and order food."
            on={s.service_food} onChange={(v) => set('service_food', v)} />
          <ServiceRow label="Pabili" desc="Buy-anything errand service."
            on={s.service_pabili} onChange={(v) => set('service_pabili', v)} />
          <ServiceRow label="Padala" desc="Point-to-point courier."
            on={s.service_padala} onChange={(v) => set('service_padala', v)} />
        </div>
      </Card>

      {/* Riders */}
      <Card title="Riders">
        <Field label="Max active orders per rider">
          <input type="number" min={0} step={1} className={`${inp} sm:max-w-[10rem]`}
            value={s.max_active_orders_per_rider}
            onChange={(e) => set('max_active_orders_per_rider', Math.max(0, Math.floor(Number(e.target.value) || 0)))} />
          <span className="mt-1 block text-xs text-black/50">
            The most orders a rider can hold at once before finishing a delivery.
            {' '}
            {s.max_active_orders_per_rider > 0
              ? <>Currently capped at <b>{s.max_active_orders_per_rider}</b>.</>
              : <>Set to <b>0</b> for no limit (unlimited).</>}
          </span>
        </Field>
      </Card>

      {/* Rider settlement destination */}
      <Card title="Rider settlement (GCash / Maya)">
        <p className="mb-3 text-sm text-black/60">
          Shown to riders when they settle their daily commission — they pay here and upload a receipt.
        </p>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="GCash / Maya number">
            <input className={inp} placeholder="0917 000 0000" value={s.settlement_gcash_number ?? ''}
              onChange={(e) => set('settlement_gcash_number', e.target.value || null)} />
          </Field>
          <Field label="Account name">
            <input className={inp} placeholder="Operator name" value={s.settlement_gcash_name ?? ''}
              onChange={(e) => set('settlement_gcash_name', e.target.value || null)} />
          </Field>
        </div>
        <div className="mt-4">
          <span className="mb-1 block text-sm font-medium text-black/70">QR code image</span>
          <div className="flex items-center gap-3">
            <span className="flex h-24 w-24 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-black/[0.04] ring-1 ring-black/10">
              {s.settlement_qr_url ? <img src={s.settlement_qr_url} alt="QR" className="h-full w-full object-contain" /> : <span className="text-2xl text-black/25">🏷️</span>}
            </span>
            <div className="space-y-1.5">
              <label className="inline-block cursor-pointer rounded-lg border border-black/10 px-3 py-1.5 text-xs font-semibold text-black/70 hover:bg-black/[0.03]">
                {qrBusy ? 'Uploading…' : s.settlement_qr_url ? 'Replace QR' : 'Upload QR'}
                <input type="file" accept="image/*" className="hidden" disabled={!supabase || qrBusy}
                  onChange={(e) => { const f = e.target.files?.[0]; if (f) void uploadQr(f); }} />
              </label>
              {s.settlement_qr_url && (
                <button onClick={() => set('settlement_qr_url', null)} className="block text-xs font-medium text-red-600">Remove QR</button>
              )}
              <p className="text-xs text-black/40">Save settings to apply.</p>
            </div>
          </div>
        </div>
      </Card>

      {/* Fees & commission */}
      <Card title="Fees & commission">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Delivery fee (₱)">
            <input type="number" min={0} className={inp} value={s.default_delivery_fee}
              onChange={(e) => set('default_delivery_fee', Number(e.target.value))} />
          </Field>
          <Field label="Delivery fee model">
            <select className={inp} value={s.delivery_fee_model}
              onChange={(e) => set('delivery_fee_model', e.target.value as AppSettings['delivery_fee_model'])}>
              <option value="flat">Flat</option>
              <option value="per_km">Per km</option>
              <option value="per_zone">Per zone</option>
            </select>
          </Field>
          <Field label="Per-store added fee (₱)">
            <input type="number" min={0} className={inp} value={s.per_store_fee}
              onChange={(e) => set('per_store_fee', Number(e.target.value))} />
          </Field>
          <Field label="Commission rate (%)">
            <input type="number" min={0} max={100} step={0.5} className={inp}
              value={Math.round(s.commission_rate * 1000) / 10}
              onChange={(e) => set('commission_rate', Number(e.target.value) / 100)} />
          </Field>
          <Field label="Convenience fee — Food (₱)">
            <input type="number" min={0} className={inp} value={s.convenience_fee_food}
              onChange={(e) => set('convenience_fee_food', Number(e.target.value))} />
          </Field>
          <Field label="Convenience fee — Pabili (₱)">
            <input type="number" min={0} className={inp} value={s.convenience_fee_pabili}
              onChange={(e) => set('convenience_fee_pabili', Number(e.target.value))} />
          </Field>
          <Field label="Convenience fee — Padala (₱)">
            <input type="number" min={0} className={inp} value={s.convenience_fee_padala}
              onChange={(e) => set('convenience_fee_padala', Number(e.target.value))} />
          </Field>
        </div>
        <p className="mt-2 text-xs text-black/40">
          Convenience fees are set per service and paid to the rider in full — no commission is taken on them.
        </p>

        {/* Mark-up is configured per store; only the split lives here. */}
        <div className="mt-4 rounded-xl bg-brand-purple/[0.04] p-3 ring-1 ring-brand-purple/20">
          <p className="text-sm font-semibold text-brand-purple">Price mark-up — your share</p>
          <p className="mt-0.5 text-xs text-black/50">
            The mark-up itself is set per store (and per item) under Stores &amp; menus. This is how much
            of it you keep: the rider collects the whole mark-up at the door and owes back this share
            with their commission. The remainder is theirs to keep.
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-3">
            <span className="w-40">
              <span className="mb-1 block text-xs font-medium text-black/60">Operator keeps (%)</span>
              <input type="number" min={0} max={100} step={5} className={inp}
                value={Math.round((s.markup_operator_share ?? 1) * 1000) / 10}
                onChange={(e) => set('markup_operator_share', Math.min(1, Math.max(0, Number(e.target.value) / 100)))} />
            </span>
            <span className="text-xs text-black/55">
              On a ₱20 mark-up you keep <b>{peso(20 * (s.markup_operator_share ?? 1))}</b>,
              the rider keeps {peso(20 * (1 - (s.markup_operator_share ?? 1)))}.
            </span>
          </div>
        </div>
        <p className="mt-4 rounded-lg bg-brand-green/10 px-3 py-2 text-sm text-green-800">
          Example: ₱{s.default_delivery_fee} delivery + {peso(s.per_store_fee)}×2 added stores →
          commission <span className="font-bold">{peso(example)}</span>
        </p>
      </Card>

      {/* Delivery-area guard */}
      <Card title="Delivery area (service radius)">
        <p className="mb-3 text-sm text-black/60">
          Orders whose drop-off pin falls outside this radius are rejected — even if the customer
          picked a serviceable barangay. Set the radius to <b>0</b> to turn the check off.
        </p>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Centre latitude">
            <input type="number" step="0.00001" className={inp} value={s.service_center_lat ?? ''}
              onChange={(e) => set('service_center_lat', e.target.value === '' ? null : Number(e.target.value))} />
          </Field>
          <Field label="Centre longitude">
            <input type="number" step="0.00001" className={inp} value={s.service_center_lng ?? ''}
              onChange={(e) => set('service_center_lng', e.target.value === '' ? null : Number(e.target.value))} />
          </Field>
          <Field label="Radius (km)">
            <input type="number" min={0} step={0.5} className={inp} value={s.service_radius_km}
              onChange={(e) => set('service_radius_km', Number(e.target.value))} />
          </Field>
        </div>
        <p className="mt-2 text-xs text-black/40">
          Tip: use the centre of your town. The radius should reach the farthest barangay you serve.
        </p>
      </Card>

      {/* Distance-based delivery fee */}
      <Card title="Distance-based delivery fee">
        <p className="mb-3 text-sm text-black/60">
          Used when <b>Delivery fee model</b> is set to <b>Per km</b>. The fee is measured from the
          store’s pinned location to the customer’s drop-off:
          <br />
          <span className="mt-1 inline-block rounded bg-black/[0.04] px-2 py-1 font-mono text-xs">
            fee = base fare + per-km × max(0, distance − base distance)
          </span>
        </p>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Base fare (₱)">
            <input type="number" min={0} className={inp} value={s.delivery_base_fare}
              onChange={(e) => set('delivery_base_fare', Number(e.target.value))} />
          </Field>
          <Field label="Base distance (km)">
            <input type="number" min={0} step={0.5} className={inp} value={s.delivery_base_km}
              onChange={(e) => set('delivery_base_km', Number(e.target.value))} />
          </Field>
          <Field label="Rate beyond base (₱/km)">
            <input type="number" min={0} step={0.5} className={inp} value={s.delivery_per_km}
              onChange={(e) => set('delivery_per_km', Number(e.target.value))} />
          </Field>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-3 rounded-lg bg-brand-purple/[0.06] px-3 py-2">
          <span className="text-sm text-black/60">Preview a</span>
          <input type="number" min={0} step={0.5} value={previewKm}
            onChange={(e) => setPreviewKm(Number(e.target.value))}
            className="w-20 rounded-lg border border-black/10 bg-white px-2 py-1 text-sm outline-none focus:border-brand-green" />
          <span className="text-sm text-black/60">km delivery →</span>
          <span className="text-sm font-bold text-brand-purple">
            {peso(distanceDeliveryFee(previewKm, {
              baseFare: s.delivery_base_fare, baseKm: s.delivery_base_km, perKm: s.delivery_per_km,
            }))}
          </span>
        </div>

        {s.delivery_fee_model !== 'per_km' && (
          <p className="mt-3 rounded-lg bg-brand-yellow/20 px-3 py-2 text-xs text-yellow-800">
            Heads up — the delivery fee model above is set to <b>{s.delivery_fee_model}</b>, so these
            rates aren’t applied yet. Switch it to <b>Per km</b> to charge by distance.
          </p>
        )}
      </Card>

      {/* Store SMS */}
      <Card title="Notifications">
        <label className="flex items-center justify-between">
          <span>
            <span className="block text-sm font-medium">Text stores their order items</span>
            <span className="block text-xs text-black/50">Optional — complements the rider call. Requires an SMS provider.</span>
          </span>
          <Toggle on={s.sms_notify_stores} onChange={(v) => set('sms_notify_stores', v)} />
        </label>
      </Card>

      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      <div className="flex items-center gap-3">
        <button onClick={save} disabled={saving || !supabase}
          className="rounded-lg bg-brand-green px-5 py-2.5 text-sm font-semibold text-white disabled:opacity-60">
          {saving ? 'Saving…' : 'Save settings'}
        </button>
        {saved && <span className="text-sm text-green-700">✓ Saved</span>}
        {!supabase && <span className="text-xs text-black/40">Connect Supabase to save.</span>}
      </div>
    </div>
  );
}

function ServiceRow({ label, desc, on, onChange }:
  { label: string; desc: string; on: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-center justify-between py-3">
      <span>
        <span className="block text-sm font-medium">{label} <span className={`ml-1 text-xs font-normal ${on ? 'text-green-700' : 'text-black/40'}`}>{on ? 'On' : 'Off'}</span></span>
        <span className="block text-xs text-black/50">{desc}</span>
      </span>
      <Toggle on={on} onChange={onChange} />
    </label>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium text-black/70">{label}</span>
      {children}
    </label>
  );
}

function Toggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button onClick={() => onChange(!on)}
      className={`relative h-6 w-11 rounded-full transition ${on ? 'bg-brand-green' : 'bg-black/20'}`}>
      <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition ${on ? 'left-[22px]' : 'left-0.5'}`} />
    </button>
  );
}

/**
 * How much work is left before closing is really closed.
 *
 * The toggle stops new orders instantly, but the queue behind it still has to
 * drain — this is the operator's view of that, so they know when the last rider
 * can go home rather than guessing.
 */
function QueueDrain() {
  const [status, setStatus] = useState<PlatformStatus | null>(null);

  useEffect(() => {
    if (!supabase) return;
    const load = () => { void getPlatformStatus(supabase!).then(setStatus).catch(() => {}); };
    load();
    const t = setInterval(load, 30_000);
    return () => clearInterval(t);
  }, []);

  if (!status) return <p className="text-sm text-black/50">Checking the queue…</p>;
  if (status.outstanding === 0) {
    return (
      <p className="text-sm font-medium text-green-800">
        ✓ The queue is empty — nothing left to deliver.
      </p>
    );
  }
  return (
    <p className="text-sm text-yellow-900">
      <span className="font-bold">{status.outstanding} order{status.outstanding === 1 ? '' : 's'} still to finish</span>
      {status.unassigned > 0 && `, ${status.unassigned} of them not yet taken by a rider`}.
      Riders keep working these until they're done.
    </p>
  );
}
