import { useEffect, useMemo, useState } from 'react';
import { commission, type FeePayer,
  errMessage,
} from '@servdgo/shared';
import { buildPadalaOrderRow, createPadalaOrder, type PadalaRequestInput } from '@servdgo/supabase';
import { resolveDeliveryFee, DEFAULT_DISTANCE_FEE_CONFIG, type DeliveryFeeModel, type DistanceFeeConfig } from '@servdgo/shared';
import { getAppSettings } from '@servdgo/supabase';
import { supabase, isSupabaseConfigured } from './lib/supabase.ts';
import { Field, Row, inputCls, peso, PaymentChoice, type PayChoice } from './ui.tsx';
import { LocationPicker, type LatLngValue } from './LocationPicker.tsx';
import { AreaPicker, kmBetween } from './AreaPicker.tsx';
import { useDefaultAddress, useAddressPrefill, DeliveryAddressField } from './DeliveryAddress.tsx';
import { AddressChooser, useSavedAddresses, useAreaBackfill } from './AddressChooser.tsx';
import { useRiderAvailability, NoRidersNotice, NO_RIDERS_MESSAGE } from './RiderAvailability.tsx';
import type { AreaSelection } from '@servdgo/supabase';
import { useAuth } from './auth/AuthContext.tsx';

const DEFAULT_DELIVERY_FEE = 50;

interface FormState {
  itemDescription: string;
  feePayer: FeePayer;
  pickupContact: string;
  dropoffContact: string;
  /** Full name of whoever receives it — the rider needs someone to ask for. */
  receiverName: string;
  pickupAddress: string;
  dropoffAddress: string;
  customerContact: string;
  notes: string;
  pay: PayChoice | null;
}

const initial: FormState = {
  itemDescription: '', feePayer: 'sender',
  pickupContact: '', dropoffContact: '', receiverName: '', pickupAddress: '', dropoffAddress: '',
  customerContact: '', notes: '', pay: null,
};

export function PadalaForm() {
  const { ensureContact, name: savedName, mobile } = useAuth();
  const [custName, setCustName] = useState('');
  // Prefill from the saved profile so returning customers don't retype it.
  useEffect(() => { if (savedName && !custName) setCustName(savedName); }, [savedName]);  // eslint-disable-line react-hooks/exhaustive-deps
  // The number was never prefilled here, so customers retyped it every order.
  useEffect(() => { if (mobile && !form.customerContact) set('customerContact', mobile); }, [mobile]);  // eslint-disable-line react-hooks/exhaustive-deps
  const riders = useRiderAvailability('padala');
  const [form, setForm] = useState<FormState>(initial);
  const [submitting, setSubmitting] = useState(false);
  const [pickup, setPickup] = useState<LatLngValue | null>(null);   // where to get it
  const [dropoff, setDropoff] = useState<LatLngValue | null>(null); // deliver to
  const [area, setArea] = useState<AreaSelection | null>(null);
  const { address: savedAddress, loaded: addressLoaded } = useDefaultAddress();
  const saved = useSavedAddresses();
  // Which saved address this order goes to; null means "pinning manually".
  const [chosenAddressId, setChosenAddressId] = useState<string | null>(null);
  function chooseAddress(a: (typeof saved.addresses)[number]) {
    setChosenAddressId(a.id);
    if (a.lat != null && a.lng != null) setDropoff({ lat: a.lat, lng: a.lng });
    set('dropoffAddress', a.address);
    if (a.province && a.city && a.barangay) setArea({ province: a.province, city: a.city, barangay: a.barangay });
    // A padala's drop-off contact is whoever receives it at that address.
    if (a.contact_name?.trim()) set('receiverName', a.contact_name.trim());
    if (a.contact_phone?.trim()) set('dropoffContact', a.contact_phone.trim());
  }
  // Clearing the pin matters: "somewhere else" used to open on the address they
  // had just moved away from, and an order sent without touching the map went
  // to that old spot.
  function pinManually() {
    setChosenAddressId(null);
    setDropoff(null); set('dropoffAddress', '');
  }
  useEffect(() => {
    if (!saved.loaded || chosenAddressId || saved.addresses.length === 0) return;
    chooseAddress(saved.addresses[0]!);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saved.loaded]);
  useAddressPrefill({
    address: savedAddress, loaded: addressLoaded, dropoff: pickup, text: form.pickupAddress,
    setDropoff: setPickup, setText: (v) => set('pickupAddress', v),
  });
  useAreaBackfill({ addresses: saved.addresses, chosenId: chosenAddressId, area, reload: saved.reload });
  const [areaRequired, setAreaRequired] = useState(false);
  const [serviceArea, setServiceArea] = useState<{ lat: number; lng: number; radiusKm: number } | null>(null);
  // Delivery pricing is operator-controlled: recalculated from the pinned
  // pickup -> drop-off distance under per-km pricing.
  const [feeCfg, setFeeCfg] = useState<{ model: DeliveryFeeModel; flatFee: number; distance: DistanceFeeConfig }>(
    { model: 'flat', flatFee: DEFAULT_DELIVERY_FEE, distance: DEFAULT_DISTANCE_FEE_CONFIG });

  useEffect(() => {
    if (!supabase || !isSupabaseConfigured) return;
    getAppSettings(supabase).then((s) => setFeeCfg({
      model: s.delivery_fee_model,
      flatFee: s.default_delivery_fee,
      distance: { baseFare: s.delivery_base_fare, baseKm: s.delivery_base_km, perKm: s.delivery_per_km },
    })).catch(() => {});
  }, []);

  const deliveryFee = useMemo(() => resolveDeliveryFee({
    model: feeCfg.model, flatFee: feeCfg.flatFee, distanceConfig: feeCfg.distance,
    storeLocations: [pickup], dropoff,
  }), [feeCfg, pickup, dropoff]);
  const needsPinsForFee = feeCfg.model === 'per_km' && (!pickup || !dropoff);
  // Naming the missing pin beats a bare "—", which reads as a broken quote.
  const feeBlocker = !needsPinsForFee ? null
    : !pickup ? '📍 Pin the pickup'
    : '📍 Pin the drop-off';
  // The half-width field beside it has room for three words, not four.
  const feeBlockerShort = !needsPinsForFee ? null : !pickup ? 'Pin the pickup' : 'Pin the drop-off';
  const [createdId, setCreatedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const operatorCut = useMemo(
    () => commission({ deliveryFee, storeCount: 0 }),
    [deliveryFee],
  );

  function set<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  function toInput(customerId: string): PadalaRequestInput {
    return {
      customerId,
      customerContact: form.customerContact,
      deliveryFee,
      feePayer: form.feePayer,
      itemDescription: form.itemDescription,
      areaProvince: area?.province,
      areaCity: area?.city,
      areaBarangay: area?.barangay,
      pickup: { contact: form.pickupContact, lat: pickup?.lat, lng: pickup?.lng, address: form.pickupAddress },
      dropoff: { contact: form.dropoffContact, name: form.receiverName, lat: dropoff?.lat, lng: dropoff?.lng, address: form.dropoffAddress },
      notes: form.notes,
      paymentMethod: form.pay ?? 'cod',
      paid: false,
    };
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (submitting) return; // guard against double taps
    setError(null);
    if (!form.receiverName.trim()) { setError("Please give the receiver's complete name."); return; }
    if (!form.dropoffAddress.trim()) { setError('Please give the complete drop-off address.'); return; }
    if (!form.pickupAddress.trim()) { setError('Please give the complete pickup address.'); return; }
    if (!form.pay) { setError('Please choose a payment method.'); return; }
    if (!pickup) { setError('Please pin the pickup location.'); return; }
    if (!dropoff) { setError('Please pin the drop-off location.'); return; }
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
        setCreatedId(await createPadalaOrder(supabase, toInput(customerId)));
      } else {
        buildPadalaOrderRow(toInput('preview-customer'));
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
        <h2 className="text-lg font-bold">Padala request sent</h2>
        <p className="mt-1 text-sm text-black/60">
          {createdId === 'preview-only'
            ? 'Preview only — connect Supabase to notify riders.'
            : 'Available riders have been notified.'}
        </p>
        <p className="mt-2 font-mono text-xs text-black/40">{createdId}</p>
        <button onClick={() => { setForm(initial); setPickup(null); setDropoff(null); setArea(null); setCreatedId(null); }}
          className="mt-5 rounded-lg border border-brand-purple px-4 py-2 text-sm font-medium text-brand-purple hover:bg-brand-purple/5">
          Send another
        </button>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} className="space-y-5">
      <NoRidersNotice availability={riders} />
      <Field label="What are we sending?">
        <input className={inputCls} value={form.itemDescription}
          onChange={(e) => set('itemDescription', e.target.value)}
          placeholder="e.g. Documents, small parcel" required />
      </Field>
      <AreaPicker value={area} onChange={setArea} onRequired={setAreaRequired} />
      <div>
        <span className="mb-1 block text-sm font-medium text-black/70">📦 Pick up from</span>
        <LocationPicker value={pickup} onChange={setPickup} kind="store" label="Pin the pickup" />
        <p className="mt-1 text-xs text-black/40">Where the rider collects the item (e.g. your place).</p>
      </div>
      <AddressChooser
        addresses={saved.addresses} loaded={saved.loaded}
        value={chosenAddressId} onChoose={chooseAddress} onCustom={pinManually}
        custom={
          <div className="space-y-3">
            <LocationPicker value={dropoff} onChange={setDropoff} label="Pin the drop-off" />
            <p className="text-xs text-black/40">
              Where the item should be dropped off. After it arrives we'll offer to save this address.
            </p>
            <DeliveryAddressField value={form.dropoffAddress} onChange={(v) => set('dropoffAddress', v)}
              label="Complete drop-off address" />
          </div>
        } />
      <Field label="Receiver's complete name *">
        <input className={inputCls} value={form.receiverName}
          onChange={(e) => set('receiverName', e.target.value)}
          placeholder="Juan Dela Cruz" required />
      </Field>
      <div className="grid grid-cols-2 gap-4">
        <Field label="Pickup contact #">
          <input className={inputCls} value={form.pickupContact}
            onChange={(e) => set('pickupContact', e.target.value)} required />
        </Field>
        <Field label="Drop-off contact #">
          <input className={inputCls} value={form.dropoffContact}
            onChange={(e) => set('dropoffContact', e.target.value)} required />
        </Field>
      </div>
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
      <div className="grid grid-cols-2 gap-4">
        <Field label="Delivery fee (₱)">
          <div className={`${inputCls} flex items-center justify-between bg-black/[0.03]`}>
            <span className={feeBlockerShort ? 'text-xs font-medium text-yellow-800' : 'font-semibold'}>
              {feeBlockerShort ?? peso(deliveryFee)}
            </span>
            <span className="text-xs text-black/40">{feeCfg.model === 'per_km' ? 'by distance' : 'flat rate'}</span>
          </div>
        </Field>
        <Field label="Who pays the fee?">
          <select className={inputCls} value={form.feePayer}
            onChange={(e) => set('feePayer', e.target.value as FeePayer)}>
            <option value="sender">Sender</option>
            <option value="receiver">Receiver</option>
          </select>
        </Field>
      </div>
      <Field label="Notes (size / weight / fragile)">
        <textarea className={inputCls} rows={2} value={form.notes}
          onChange={(e) => set('notes', e.target.value)} />
      </Field>
      <PaymentChoice value={form.pay} onChange={(v) => set('pay', v)} />
      <div className="rounded-lg bg-white p-4 shadow-sm ring-1 ring-black/5">
        <Row label={feeCfg.model === 'per_km' ? 'Delivery fee (by distance)' : 'Delivery fee'}
          value={feeBlocker ?? peso(deliveryFee)} muted={Boolean(feeBlocker)} />
        <Row label="Operator commission (15%)" value={peso(operatorCut)} muted />
        <p className="mt-2 text-xs text-black/50">Padala is delivery-fee only — no goods are purchased.</p>
      </div>
      {error && <p className="text-sm text-red-600">{error}</p>}
      <button type="submit" disabled={submitting || !form.pay || !pickup || !dropoff || !form.receiverName.trim() || !form.dropoffAddress.trim() || !form.pickupAddress.trim() || (areaRequired && !area)}
        className="w-full rounded-lg bg-brand-green py-3 font-semibold text-white transition hover:brightness-95 disabled:opacity-60">
        {submitting ? 'Sending…' : areaRequired && !area ? 'Choose your delivery area' : !pickup || !dropoff ? 'Pin pickup and drop-off' : !form.pay ? 'Choose a payment method' : 'Request a rider'}
      </button>
    </form>
  );
}
