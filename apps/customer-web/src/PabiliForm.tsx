import { useEffect, useMemo, useState } from 'react';
import { validateBudget, resolveDeliveryFee, DEFAULT_DISTANCE_FEE_CONFIG,
  DEFAULT_FEE_CONFIG, storeFeeTotal, MAX_STORES_PER_ORDER,
  type DeliveryFeeModel, type DistanceFeeConfig,
  errMessage,
} from '@ebd/shared';
import { buildPabiliOrderRow, createPabiliOrder, getAppSettings, pabiliItemsSummary,
  type PabiliRequestInput, type PabiliItemInput, type PabiliStoreInput } from '@ebd/supabase';
import { supabase, isSupabaseConfigured } from './lib/supabase.ts';
import { Field, Row, inputCls, peso, PaymentChoice, type PayChoice } from './ui.tsx';
import { LocationPicker, type LatLngValue } from './LocationPicker.tsx';
import { AreaPicker, kmBetween } from './AreaPicker.tsx';
import { useDefaultAddress, useAddressPrefill, DeliveryAddressField } from './DeliveryAddress.tsx';
import { AddressChooser, useSavedAddresses, useAreaBackfill } from './AddressChooser.tsx';
import type { AreaSelection } from '@ebd/supabase';
import { useAuth } from './auth/AuthContext.tsx';
import { useRiderAvailability, NoRidersNotice, NO_RIDERS_MESSAGE } from './RiderAvailability.tsx';

interface FormState {
  items: PabiliItemInput[];
  where: string;
  customerContact: string;
  notes: string;
  pay: PayChoice | null;
}

const initial: FormState = {
  items: [{ qty: 1, name: '', storeIndex: null }], where: '',
  customerContact: '', notes: '', pay: null,
};

export function PabiliForm() {
  const { ensureContact, name: savedName, mobile } = useAuth();
  const [custName, setCustName] = useState('');
  // Prefill from the saved profile so returning customers don't retype it.
  useEffect(() => { if (savedName && !custName) setCustName(savedName); }, [savedName]);  // eslint-disable-line react-hooks/exhaustive-deps
  // The number was never prefilled here, so customers retyped it every order.
  useEffect(() => { if (mobile && !form.customerContact) set('customerContact', mobile); }, [mobile]);  // eslint-disable-line react-hooks/exhaustive-deps
  const riders = useRiderAvailability('pabili');
  const [form, setForm] = useState<FormState>(initial);
  const [submitting, setSubmitting] = useState(false);
  const [createdId, setCreatedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Convenience fee is operator-set (from app settings); the customer can't edit it.
  const [convenienceFee, setConvenienceFee] = useState(0);
  const [buyAt, setBuyAt] = useState<LatLngValue | null>(null);   // where to buy
  const [dropoff, setDropoff] = useState<LatLngValue | null>(null); // deliver to
  const [area, setArea] = useState<AreaSelection | null>(null);
  const [addressText, setAddressText] = useState('');
  const [stores, setStores] = useState<PabiliStoreInput[]>([{ name: '' }]);
  // Operator's per-store fee; each store past the first bills one.
  const [perStoreFee, setPerStoreFee] = useState(DEFAULT_FEE_CONFIG.perStoreFee);
  const { address: savedAddress, loaded: addressLoaded } = useDefaultAddress();
  const saved = useSavedAddresses();
  // Which saved address this order goes to; null means "pinning manually".
  const [chosenAddressId, setChosenAddressId] = useState<string | null>(null);
  function chooseAddress(a: (typeof saved.addresses)[number]) {
    setChosenAddressId(a.id);
    if (a.lat != null && a.lng != null) setDropoff({ lat: a.lat, lng: a.lng });
    setAddressText(a.address);
    if (a.province && a.city && a.barangay) setArea({ province: a.province, city: a.city, barangay: a.barangay });
    // An address carries its own doorbell: who to ask for, and what to ring.
    if (a.contact_name?.trim()) setCustName(a.contact_name.trim());
    if (a.contact_phone?.trim()) set('customerContact', a.contact_phone.trim());
  }
  // Clearing the pin matters: "somewhere else" used to open on the address they
  // had just moved away from, and an order sent without touching the map went
  // to that old spot.
  function pinManually() {
    setChosenAddressId(null);
    setDropoff(null); setAddressText('');
  }
  // Default to the customer's default address as soon as it loads.
  useEffect(() => {
    if (!saved.loaded || chosenAddressId || saved.addresses.length === 0) return;
    chooseAddress(saved.addresses[0]!);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saved.loaded]);
  useAddressPrefill({
    address: savedAddress, loaded: addressLoaded, dropoff, text: addressText,
    setDropoff, setText: setAddressText, setArea,
  });
  useAreaBackfill({ addresses: saved.addresses, chosenId: chosenAddressId, area, reload: saved.reload });
  const [areaRequired, setAreaRequired] = useState(false);
  const [serviceArea, setServiceArea] = useState<{ lat: number; lng: number; radiusKm: number } | null>(null);
  // Delivery pricing comes from the operator's settings — recalculated from the
  // pinned distance under per-km pricing, never typed by the customer.
  const [feeCfg, setFeeCfg] = useState<{ model: DeliveryFeeModel; flatFee: number; distance: DistanceFeeConfig }>(
    { model: 'flat', flatFee: 50, distance: DEFAULT_DISTANCE_FEE_CONFIG });

  useEffect(() => {
    if (!supabase || !isSupabaseConfigured) return;
    getAppSettings(supabase).then((s) => {
      setConvenienceFee(s.convenience_fee_pabili ?? s.convenience_fee);
      setPerStoreFee(Number(s.per_store_fee ?? DEFAULT_FEE_CONFIG.perStoreFee));
      setFeeCfg({
        model: s.delivery_fee_model,
        flatFee: s.default_delivery_fee,
        distance: { baseFare: s.delivery_base_fare, baseKm: s.delivery_base_km, perKm: s.delivery_per_km },
      });
        if (s.service_center_lat != null && s.service_center_lng != null && Number(s.service_radius_km) > 0) {
          setServiceArea({ lat: s.service_center_lat, lng: s.service_center_lng, radiusKm: Number(s.service_radius_km) });
        }

    }).catch(() => {});
  }, []);

  const deliveryFee = useMemo(() => resolveDeliveryFee({
    model: feeCfg.model, flatFee: feeCfg.flatFee, distanceConfig: feeCfg.distance,
    storeLocations: [buyAt], dropoff,
  }), [feeCfg, buyAt, dropoff]);
  // Per-km pricing needs both pins to measure the leg.
  const needsPinsForFee = feeCfg.model === 'per_km' && (!buyAt || !dropoff);
  // A bare "—" left customers who had picked their saved address wondering why
  // the fee never appeared: the missing pin is the *store's*, not theirs.
  const feeBlocker = !needsPinsForFee ? null
    : !buyAt ? '📍 Pin where to buy'
    : '📍 Pin the drop-off';
  // The half-width field beside it has room for three words, not four.
  const feeBlockerShort = !needsPinsForFee ? null : !buyAt ? 'Pin the store' : 'Pin the drop-off';
  const namedStores = stores.filter((st) => st.name.trim() !== '');
  const storeCount = Math.max(1, namedStores.length);
  const storeFee = storeFeeTotal(storeCount, { ...DEFAULT_FEE_CONFIG, perStoreFee });
  // Fees are all we can quote up front. Nobody knows what the goods cost until
  // the rider is at the counter, and a made-up estimate only ever misleads.
  const feesTotal = deliveryFee + storeFee + convenienceFee;
  const hasItems = form.items.some((i) => i.name.trim() !== '');

  function setStore(i: number, patch: Partial<PabiliStoreInput>) {
    setStores((ss) => ss.map((st, j) => (j === i ? { ...st, ...patch } : st)));
  }
  function addStore() { setStores((ss) => (ss.length >= MAX_STORES_PER_ORDER ? ss : [...ss, { name: '' }])); }
  function removeStore(i: number) {
    setStores((ss) => (ss.length === 1 ? [{ name: '' }] : ss.filter((_, j) => j !== i)));
  }

  function set<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }
  function setItem(i: number, patch: Partial<PabiliItemInput>) {
    setForm((f) => ({ ...f, items: f.items.map((it, j) => (j === i ? { ...it, ...patch } : it)) }));
  }
  function addItem() {
    setForm((f) => ({ ...f, items: [...f.items, { qty: 1, name: '', storeIndex: null }] }));
  }
  function removeItem(i: number) {
    setForm((f) => ({
      ...f,
      items: f.items.length === 1 ? [{ qty: 1, name: '', storeIndex: null }] : f.items.filter((_, j) => j !== i),
    }));
  }

  function toInput(customerId: string): PabiliRequestInput {
    return {
      customerId,
      customerContact: form.customerContact,
      deliveryFee,
      convenienceFee,
      itemsDescription: pabiliItemsSummary(form.items),
      // The picker indexes the rows on screen, blanks included; the order only
      // stores the named ones, so translate before sending.
      items: form.items.map((it) => ({
        ...it,
        storeIndex: it.storeIndex == null ? null
          : namedStores.indexOf(stores[it.storeIndex]!) === -1 ? null
          : namedStores.indexOf(stores[it.storeIndex]!),
      })),
      where: namedStores[0]?.name ?? form.where,
      stores: namedStores,
      areaProvince: area?.province,
      areaCity: area?.city,
      areaBarangay: area?.barangay,
      pickupLat: buyAt?.lat,
      pickupLng: buyAt?.lng,
      deliveryLat: dropoff?.lat,
      deliveryLng: dropoff?.lng,
      deliveryAddress: addressText,
      notes: form.notes,
      paymentMethod: form.pay ?? 'cod',
      paid: false,
    };
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (submitting) return; // guard against double taps
    setError(null);
    if (!hasItems) { setError('Please add at least one item to buy.'); return; }
    if (!addressText.trim()) { setError('Please give your complete delivery address.'); return; }
    if (!form.pay) { setError('Please choose a payment method.'); return; }
    if (!dropoff) { setError('Please pin where the order should be delivered.'); return; }
    if (needsPinsForFee) { setError('Please pin where to buy so we can compute the delivery fee.'); return; }
    if (areaRequired && !area) { setError('Please choose your delivery area (province, city, barangay).'); return; }
    // The barangay is self-declared, so check the pin itself against the
    // operator's service radius (also enforced in the database).
    if (serviceArea && dropoff) {
      const km = kmBetween(serviceArea, dropoff);
      if (km > serviceArea.radiusKm) {
        setError(`That drop-off is about ${km.toFixed(1)} km away, outside our ${serviceArea.radiusKm} km delivery area. Please pin a location we serve.`);
        return;
      }
    }
    if (custName.trim().length < 2) {
      setError('Please enter your name so the rider knows who to hand it to.');
      return;
    }
    setSubmitting(true);
    try {
      // Riders come and go while a form is being filled in — ask again now.
      if (await riders.recheck() === 0) { setError(NO_RIDERS_MESSAGE); return; }
      if (supabase && isSupabaseConfigured) {
        const customerId = await ensureContact(form.customerContact, custName.trim());
        setCreatedId(await createPabiliOrder(supabase, toInput(customerId), { ...DEFAULT_FEE_CONFIG, perStoreFee }));
      } else {
        buildPabiliOrderRow(toInput('preview-customer'));
        setCreatedId('preview-only');
      }
    } catch (err) {
      setError(errMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  if (createdId) {
    return (
      <div className="rounded-xl bg-white p-6 text-center shadow-sm ring-1 ring-black/5">
        <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-brand-green/15 text-2xl">✓</div>
        <h2 className="text-lg font-bold">Pabili request sent</h2>
        <p className="mt-1 text-sm text-black/60">
          {createdId === 'preview-only'
            ? 'Preview only — connect Supabase to notify riders.'
            : 'A rider will buy your items and deliver them.'}
        </p>
        <p className="mt-2 font-mono text-xs text-black/40">{createdId}</p>
        <button onClick={() => { setForm(initial); setBuyAt(null); setDropoff(null); setArea(null); setCreatedId(null); }}
          className="mt-5 rounded-lg border border-brand-purple px-4 py-2 text-sm font-medium text-brand-purple hover:bg-brand-purple/5">
          Send another
        </button>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} className="space-y-5">
      <NoRidersNotice availability={riders} />
      <div>
        <span className="mb-1 block text-sm font-medium text-black/70">What should we buy?</span>
        <div className="space-y-2">
          {form.items.map((it, i) => (
            <div key={i} className="space-y-1">
              <div className="flex gap-2">
                <input type="number" min={1} value={it.qty} aria-label={`Quantity for item ${i + 1}`}
                  onChange={(e) => setItem(i, { qty: Math.max(1, Number(e.target.value) || 1) })}
                  className="w-16 shrink-0 rounded-lg border border-black/10 bg-white px-2 py-2 text-sm outline-none focus:border-brand-green focus:ring-2 focus:ring-brand-green/30 text-center" />
                <input value={it.name} aria-label={`Item ${i + 1}`}
                  onChange={(e) => setItem(i, { name: e.target.value })}
                  placeholder={i === 0 ? 'e.g. paracetamol 500mg' : 'Another item'}
                  className="min-w-0 flex-1 rounded-lg border border-black/10 bg-white px-3 py-2 text-sm outline-none focus:border-brand-green focus:ring-2 focus:ring-brand-green/30" />
                <button type="button" onClick={() => removeItem(i)} aria-label={`Remove item ${i + 1}`}
                  disabled={form.items.length === 1}
                  className="shrink-0 rounded-lg border border-black/10 px-3 text-sm text-black/40 disabled:opacity-30">✕</button>
              </div>
              {/* Only worth asking once there's more than one store to pick from. */}
              {namedStores.length > 1 && (
                <select aria-label={`Store for item ${i + 1}`}
                  value={it.storeIndex ?? ''}
                  onChange={(e) => setItem(i, { storeIndex: e.target.value === '' ? null : Number(e.target.value) })}
                  className="ml-[4.5rem] rounded-lg border border-brand-purple/30 bg-brand-purple/[0.04] px-2 py-1 text-xs text-brand-purple outline-none">
                  <option value="">🛒 Any store</option>
                  {stores.map((st, si) => (st.name.trim() ? <option key={si} value={si}>🛒 {st.name.trim()}</option> : null))}
                </select>
              )}
            </div>
          ))}
        </div>
        <button type="button" onClick={addItem}
          className="mt-2 w-full rounded-lg border border-dashed border-brand-purple/40 py-2 text-sm font-semibold text-brand-purple">
          ＋ Add more item
        </button>
        <p className="mt-1 text-xs text-black/40">
          One line per item so your rider can tick them off as they shop.
        </p>
      </div>
      <div>
        <span className="mb-1 block text-sm font-medium text-black/70">
          Which store? <span className="font-normal text-black/40">(optional — leave blank for the nearest)</span>
        </span>
        <div className="space-y-2">
          {stores.map((st, i) => (
            <div key={i} className="flex gap-2">
              <input value={st.name} aria-label={`Store ${i + 1}`}
                onChange={(e) => setStore(i, { name: e.target.value })}
                placeholder={i === 0 ? 'e.g. Botica Central' : 'Another store'}
                className="min-w-0 flex-1 rounded-lg border border-black/10 bg-white px-3 py-2 text-sm outline-none focus:border-brand-green focus:ring-2 focus:ring-brand-green/30" />
              <button type="button" onClick={() => removeStore(i)} aria-label={`Remove store ${i + 1}`}
                disabled={stores.length === 1}
                className="shrink-0 rounded-lg border border-black/10 px-3 text-sm text-black/40 disabled:opacity-30">✕</button>
            </div>
          ))}
        </div>
        <button type="button" onClick={addStore} disabled={stores.length >= MAX_STORES_PER_ORDER}
          className="mt-2 w-full rounded-lg border border-dashed border-brand-purple/40 py-2 text-sm font-semibold text-brand-purple disabled:opacity-40">
          {stores.length >= MAX_STORES_PER_ORDER ? `${MAX_STORES_PER_ORDER} stores is the limit for one trip` : '＋ Add another store'}
        </button>
        <p className="mt-1 text-xs text-black/40">
          {namedStores.length > 1
            ? `${namedStores.length} stores · extra stops add ${peso(storeFee)} in store fees.`
            : `Each extra store adds a ${peso(perStoreFee)} store fee.`}
        </p>
      </div>
      <AreaPicker value={area} onChange={setArea} onRequired={setAreaRequired} />
      {/* Two maps in a row look identical at a glance, so the buy pin is
          purple and framed while the drop-off stays green. */}
      <div className="rounded-xl bg-brand-purple/[0.05] p-3 ring-1 ring-brand-purple/20">
        <span className="mb-1 block text-sm font-bold text-brand-purple">
          🛒 Where to buy
          {feeCfg.model === 'per_km'
            ? <span className="text-red-600"> *</span>
            : <span className="font-normal text-brand-purple/60"> (optional)</span>}
        </span>
        <LocationPicker value={buyAt} onChange={setBuyAt} kind="store" label="Pin the store" />
        {feeCfg.model === 'per_km' && !buyAt ? (
          <p className="mt-1 rounded-lg bg-brand-yellow/25 px-3 py-2 text-xs font-medium text-yellow-900">
            Drag the pin to the store. Your delivery fee is the distance from here to your address, so
            we can't work it out until this is pinned.
          </p>
        ) : (
          <p className="mt-1 text-xs text-black/45">{feeCfg.model === 'per_km'
            ? 'Your delivery fee is the distance from this store to your address.'
            : 'Pin the store if you have one in mind — otherwise the rider picks the nearest.'}</p>
        )}
      </div>
      <AddressChooser
        addresses={saved.addresses} loaded={saved.loaded}
        value={chosenAddressId} onChoose={chooseAddress} onCustom={pinManually}
        custom={
          <div className="space-y-3">
            <LocationPicker value={dropoff} onChange={setDropoff} label="Pin the drop-off" />
            <p className="text-xs text-black/40">
              Tap or drag the pin to where the rider should deliver. After it arrives we'll offer to save this address.
            </p>
            <DeliveryAddressField value={addressText} onChange={setAddressText} saved={savedAddress} />
          </div>
        } />
      <div className="grid grid-cols-2 gap-4">
        <Field label="Delivery fee (₱)">
          <div className={`${inputCls} flex items-center justify-between bg-black/[0.03]`}>
            <span className={feeBlockerShort ? 'text-xs font-medium text-yellow-800' : 'font-semibold'}>
              {feeBlockerShort ?? peso(deliveryFee)}
            </span>
            <span className="text-xs text-black/40">{feeCfg.model === 'per_km' ? 'by distance' : 'flat rate'}</span>
          </div>
        </Field>
        <Field label="Your name *">
        <input className={inputCls} value={custName} onChange={(e) => setCustName(e.target.value)}
          placeholder="Juan Dela Cruz" required />
        <p className="mt-1 text-xs text-black/40">So the rider knows who to hand it to.</p>
      </Field>
      <Field label="Your mobile number">
          <input className={inputCls} value={form.customerContact}
            onChange={(e) => set('customerContact', e.target.value)}
            placeholder="09xx xxx xxxx" required />
        </Field>
      </div>
      <Field label="Notes for the rider">
        <textarea className={inputCls} rows={2} value={form.notes}
          onChange={(e) => set('notes', e.target.value)} />
      </Field>
      <PaymentChoice value={form.pay} onChange={(v) => set('pay', v)} />

      <div className="rounded-lg bg-white p-4 shadow-sm ring-1 ring-black/5">
        <Row label={feeCfg.model === 'per_km' ? 'Delivery fee (by distance)' : 'Delivery fee'}
          value={feeBlocker ?? peso(deliveryFee)} muted={Boolean(feeBlocker)} />
        {storeFee > 0 && <Row label={`Store fee (${namedStores.length} stores)`} value={peso(storeFee)} />}
        {convenienceFee > 0 && <Row label="Convenience fee" value={peso(convenienceFee)} />}
        <div className="mt-1 flex justify-between border-t border-black/10 pt-2 text-sm font-bold">
          <span>Fees to pay</span>
          <span>{needsPinsForFee ? '—' : peso(feesTotal)}</span>
        </div>
        {feeBlocker && (
          <p className="mt-2 rounded-lg bg-brand-yellow/25 px-3 py-2 text-xs font-medium text-yellow-900">
            {!buyAt
              ? 'Pin the store under “🛒 Where to buy” above and the delivery fee appears here.'
              : 'Choose or pin your delivery address and the delivery fee appears here.'}
          </p>
        )}
        <p className="mt-2 text-xs text-black/50">
          Plus the <b>cost of the goods</b>. Your rider sends you the store receipt total once
          they've bought everything, and that's what you pay on top of the fees above.
        </p>
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}
      <button type="submit" disabled={submitting || !hasItems || !addressText.trim() || !form.pay || !dropoff || needsPinsForFee || (areaRequired && !area)}
        className="w-full rounded-lg bg-brand-green py-3 font-semibold text-white transition hover:brightness-95 disabled:opacity-60">
        {submitting ? 'Sending…'
          : !hasItems ? 'Add what to buy'
          : !addressText.trim() ? 'Add your complete address'
          : areaRequired && !area ? 'Choose your delivery area'
          : !buyAt && feeCfg.model === 'per_km' ? 'Pin where to buy'
          : !dropoff ? 'Pin your delivery address'
          : needsPinsForFee ? 'Pin both locations'
          : !form.pay ? 'Choose a payment method'
          : `Request Pabili · ${peso(feesTotal)} in fees + goods`}
      </button>
    </form>
  );
}
