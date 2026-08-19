import { useCallback, useEffect, useRef, useState } from 'react';
import {
  getMyCustomer, listAddresses, addAddress, setDefaultAddress, setAddressArea,
  type CustomerAddress, type AreaSelection,
} from '@ebd/supabase';
import {
  sortAddresses, addressTitle, availableLabels, nextAddressLabel, findSavedAddress,
} from '@ebd/shared';
import { supabase, isSupabaseConfigured } from './lib/supabase.ts';
import { LocationPicker, type LatLngValue } from './LocationPicker.tsx';
import { AreaPicker } from './AreaPicker.tsx';

/** An icon per label, so a saved address is recognisable at a glance. */
export const addressIcon = (label: string | null): string => {
  const l = (label ?? '').trim().toLowerCase();
  if (l === 'home') return '🏠';
  if (l === 'office' || l === 'work') return '🏢';
  return '📍';
};

/** The customer's saved addresses, kept in one place so every form agrees. */
export function useSavedAddresses() {
  const [addresses, setAddresses] = useState<CustomerAddress[]>([]);
  const [customerId, setCustomerId] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const reload = useCallback(async () => {
    if (!supabase || !isSupabaseConfigured) { setLoaded(true); return; }
    try {
      const c = await getMyCustomer(supabase);
      if (!c) { setLoaded(true); return; }
      setCustomerId(c.id);
      setAddresses(sortAddresses(await listAddresses(supabase, c.id)));
    } catch { /* the customer can still pin manually */ }
    finally { setLoaded(true); }
  }, []);

  useEffect(() => { void reload(); }, [reload]);
  return { addresses, customerId, loaded, reload };
}

/** True when a saved address can't prefill the area picker. */
export const hasArea = (a: Pick<CustomerAddress, 'province' | 'city' | 'barangay'>): boolean =>
  Boolean(a.province && a.city && a.barangay);

/**
 * Teaches an old address its area, once.
 *
 * Addresses saved before the area picker existed have a pin and a written
 * address but no province/city/barangay, so choosing one still left "Choose
 * your delivery area" blocking checkout — every single order. The moment the
 * customer picks the area, it's written back, and that address never asks
 * again.
 */
export function useAreaBackfill(opts: {
  addresses: CustomerAddress[];
  /** The saved address this order is going to, or null when pinning manually. */
  chosenId: string | null;
  area: AreaSelection | null;
  reload: () => void | Promise<void>;
}) {
  const { addresses, chosenId, area, reload } = opts;
  const done = useRef<string | null>(null);

  useEffect(() => {
    if (!supabase || !chosenId || !area || done.current === chosenId) return;
    const target = addresses.find((a) => a.id === chosenId);
    if (!target || hasArea(target)) return;
    done.current = chosenId;
    setAddressArea(supabase, chosenId, area)
      .then(() => reload())
      .catch(() => { done.current = null; });  // the order itself still goes through
  }, [chosenId, area, addresses, reload]);
}

export interface ChosenAddress {
  pin: LatLngValue | null;
  text: string;
  area: AreaSelection | null;
}

/**
 * Pick where this order goes.
 *
 * Saved addresses come first as one-tap cards — choosing one drops the pin, so
 * the common case never touches a map. Delivering somewhere else opens the
 * picker; that pin is offered for saving once the order actually arrives, not
 * here, because at checkout nobody wants a second decision.
 */
export function AddressChooser({ addresses, loaded, value, onChoose, onCustom, custom }: {
  addresses: CustomerAddress[];
  loaded: boolean;
  /** Currently selected saved address id, or null when pinning manually. */
  value: string | null;
  onChoose: (a: CustomerAddress) => void;
  onCustom: () => void;
  /** The manual-pin controls, rendered when "somewhere else" is chosen. */
  custom: React.ReactNode;
}) {
  if (!loaded) return <p className="text-sm text-black/40">Loading your addresses…</p>;
  if (addresses.length === 0) return <>{custom}</>;

  return (
    <div className="space-y-2">
      <span className="block text-sm font-medium text-black/70">Deliver to</span>
      <div className="space-y-2">
        {addresses.map((a) => {
          const on = value === a.id;
          return (
            <button key={a.id} type="button" onClick={() => onChoose(a)}
              className={`flex w-full items-start gap-3 rounded-xl border p-3 text-left transition ${
                on ? 'border-brand-green bg-brand-green/[0.07] ring-1 ring-brand-green'
                   : 'border-black/10 bg-white hover:border-brand-green/40'}`}>
              <span className="text-lg leading-none">{addressIcon(a.label)}</span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2">
                  <span className="text-sm font-semibold text-brand-ink">{addressTitle(a)}</span>
                  {a.is_default && (
                    <span className="rounded-full bg-brand-green/15 px-2 py-0.5 text-[10px] font-semibold text-green-800">Default</span>
                  )}
                  {a.lat == null && (
                    <span className="rounded-full bg-brand-yellow/30 px-2 py-0.5 text-[10px] font-semibold text-yellow-800">No pin</span>
                  )}
                  {/* Saved before we asked for the area — so the picker below
                      still needs one answer, this once. */}
                  {!hasArea(a) && (
                    <span className="rounded-full bg-brand-yellow/30 px-2 py-0.5 text-[10px] font-semibold text-yellow-800">Area not set</span>
                  )}
                </span>
                <span className="mt-0.5 block text-xs text-black/50">{a.address}</span>
              </span>
              <span className={`mt-0.5 h-4 w-4 shrink-0 rounded-full border-2 ${
                on ? 'border-brand-green bg-brand-green' : 'border-black/20'}`} />
            </button>
          );
        })}

        <button type="button" onClick={onCustom}
          className={`w-full rounded-xl border border-dashed p-3 text-sm font-semibold transition ${
            value === null ? 'border-brand-purple bg-brand-purple/[0.06] text-brand-purple'
                           : 'border-black/15 text-black/55 hover:border-brand-purple/50'}`}>
          📍 Deliver somewhere else
        </button>
      </div>

      {value === null && <div className="pt-1">{custom}</div>}
    </div>
  );
}

/**
 * "Save this address?" — offered after a delivery lands, never during one.
 *
 * Asking at checkout adds a decision to a form someone is trying to finish;
 * asking once it has arrived is the moment they know the pin was right.
 */
export function SaveAddressPrompt({ pin, text, area, contactName, contactPhone, addresses, customerId, onSaved, onDismiss }: {
  pin: { lat: number; lng: number } | null;
  text: string;
  area: AreaSelection | null;
  /** Who the order was for — kept with the address so the next one fills in. */
  contactName?: string | null;
  contactPhone?: string | null;
  addresses: CustomerAddress[];
  customerId: string | null;
  onSaved: () => void | Promise<void>;
  onDismiss: () => void;
}) {
  const free = availableLabels(addresses);
  const [label, setLabel] = useState(() => free[0] ?? nextAddressLabel(addresses));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function save() {
    if (!supabase || !customerId) return;
    setBusy(true); setErr(null);
    try {
      await addAddress(supabase, {
        customerId,
        label: label.trim() || nextAddressLabel(addresses),
        address: text.trim(),
        lat: pin?.lat ?? null,
        lng: pin?.lng ?? null,
        // The first address a customer saves becomes the one they order to.
        isDefault: addresses.length === 0,
        province: area?.province ?? null,
        city: area?.city ?? null,
        barangay: area?.barangay ?? null,
        contactName, contactPhone,
      });
      await onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-2xl bg-brand-green/[0.08] p-4 ring-1 ring-brand-green/30">
      <p className="text-sm font-bold text-green-900">📍 Save this address?</p>
      <p className="mt-1 text-sm text-green-900/75">
        We can keep it for next time, so you won't have to pin it again.
      </p>
      <p className="mt-2 rounded-lg bg-white/70 px-3 py-2 text-xs text-black/60">{text || 'Pinned location'}</p>

      <div className="mt-3 flex flex-wrap gap-2">
        {[...free, nextAddressLabel(addresses)].map((l) => (
          <button key={l} type="button" onClick={() => setLabel(l)}
            className={`rounded-lg px-3 py-1.5 text-xs font-semibold ring-1 transition ${
              label === l ? 'bg-brand-green text-white ring-brand-green' : 'bg-white text-black/60 ring-black/10'}`}>
            {addressIcon(l)} {l}
          </button>
        ))}
      </div>
      <input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={24}
        aria-label="Address name"
        className="mt-2 w-full rounded-lg border border-black/10 bg-white px-3 py-2 text-sm" />

      {err && <p className="mt-2 text-xs text-red-600">{err}</p>}

      <div className="mt-3 flex gap-2">
        <button type="button" onClick={onDismiss} disabled={busy}
          className="flex-1 rounded-xl border border-black/10 bg-white py-2.5 text-sm font-semibold text-black/60">
          No thanks
        </button>
        <button type="button" onClick={() => void save()} disabled={busy || !customerId}
          className="flex-1 rounded-xl bg-brand-green py-2.5 text-sm font-bold text-white disabled:opacity-60">
          {busy ? 'Saving…' : 'Save address'}
        </button>
      </div>
    </div>
  );
}

/**
 * The address a new customer sets when they make their account, which becomes
 * the one every order defaults to.
 */
export function FirstAddressForm({ customerId, onSaved, defaultName = '', defaultPhone = '' }: {
  customerId: string;
  onSaved: () => void | Promise<void>;
  /** The customer's own details, which this address starts from. */
  defaultName?: string;
  defaultPhone?: string;
}) {
  const [label, setLabel] = useState('Home');
  const [contactName, setContactName] = useState(defaultName);
  const [contactPhone, setContactPhone] = useState(defaultPhone);
  const [pin, setPin] = useState<LatLngValue | null>(null);
  const [text, setText] = useState('');
  const [area, setArea] = useState<AreaSelection | null>(null);
  const [areaRequired, setAreaRequired] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const ready = text.trim().length >= 5 && Boolean(pin) && (!areaRequired || Boolean(area));

  async function save() {
    if (!supabase || !ready) return;
    setBusy(true); setErr(null);
    try {
      await addAddress(supabase, {
        customerId, label: label.trim() || 'Home', address: text.trim(),
        lat: pin?.lat ?? null, lng: pin?.lng ?? null, isDefault: true,
        province: area?.province ?? null, city: area?.city ?? null, barangay: area?.barangay ?? null,
        contactName, contactPhone,
      });
      await onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3 text-left">
      <div>
        <span className="mb-1 block text-sm font-medium text-black/70">What should we call it?</span>
        <div className="flex flex-wrap gap-2">
          {['Home', 'Office'].map((l) => (
            <button key={l} type="button" onClick={() => setLabel(l)}
              className={`rounded-lg px-3 py-1.5 text-xs font-semibold ring-1 transition ${
                label === l ? 'bg-brand-green text-white ring-brand-green' : 'bg-white text-black/60 ring-black/10'}`}>
              {addressIcon(l)} {l}
            </button>
          ))}
          <input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={24}
            aria-label="Address name"
            className="min-w-0 flex-1 rounded-lg border border-black/10 bg-white px-3 py-1.5 text-xs" />
        </div>
      </div>

      <AreaPicker value={area} onChange={setArea} onRequired={setAreaRequired} />
      <LocationPicker value={pin} onChange={setPin} label="Pin your address" height={200} />

      <div>
        <span className="mb-1 block text-sm font-medium text-black/70">
          Complete address <span className="text-red-500">*</span>
        </span>
        <textarea rows={2} value={text} onChange={(e) => setText(e.target.value)}
          placeholder="House/unit no., street, subdivision, landmark"
          className="w-full rounded-lg border border-black/10 bg-white px-3 py-2 text-sm" />
      </div>

      {/* An address is a place; a delivery needs a person. Usually the customer
          themselves, but "Mama's" wants a different name on the doorbell. */}
      <div className="grid grid-cols-2 gap-2">
        <label className="text-sm font-medium text-black/70">
          Who to ask for
          <input value={contactName} onChange={(e) => setContactName(e.target.value)}
            placeholder="Juan Dela Cruz"
            className="mt-1 w-full rounded-lg border border-black/10 bg-white px-3 py-2 text-sm" />
        </label>
        <label className="text-sm font-medium text-black/70">
          Contact number
          <input value={contactPhone} onChange={(e) => setContactPhone(e.target.value)}
            inputMode="tel" placeholder="0917 123 4567"
            className="mt-1 w-full rounded-lg border border-black/10 bg-white px-3 py-2 text-sm" />
        </label>
      </div>

      {err && <p className="text-xs text-red-600">{err}</p>}

      <button type="button" onClick={() => void save()} disabled={busy || !ready}
        className="w-full rounded-lg bg-brand-green py-3 font-semibold text-white disabled:opacity-60">
        {busy ? 'Saving…'
          : !pin ? 'Pin your address on the map'
          : areaRequired && !area ? 'Choose your area'
          : text.trim().length < 5 ? 'Type your complete address'
          : 'Save and continue'}
      </button>
      <p className="text-center text-xs text-black/45">
        You can add more addresses later, and change which one is your default.
      </p>
    </div>
  );
}

/** Re-export so callers don't need a second import for the default helper. */
export { setDefaultAddress, findSavedAddress };
