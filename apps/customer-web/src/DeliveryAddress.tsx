import { useCallback, useEffect, useRef, useState } from 'react';
import { getMyCustomer, listAddresses, type CustomerAddress } from '@servdgo/supabase';
import { supabase, isSupabaseConfigured } from './lib/supabase.ts';
import type { LatLngValue } from './LocationPicker.tsx';
import type { AreaSelection } from '@servdgo/supabase';

/**
 * The customer's saved default address, loaded once per form.
 *
 * They already typed all of this when they made the account — asking again on
 * every order is just a chance to get it wrong.
 */
export function useDefaultAddress() {
  const [address, setAddress] = useState<CustomerAddress | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!supabase || !isSupabaseConfigured) { setLoaded(true); return; }
    let cancelled = false;
    (async () => {
      try {
        const c = await getMyCustomer(supabase!);
        if (!c || cancelled) { if (!cancelled) setLoaded(true); return; }
        const list = await listAddresses(supabase!, c.id);
        if (cancelled) return;
        setAddress(list.find((a) => a.is_default) ?? list[0] ?? null);
      } catch { /* ignore — the customer can still type one */ }
      finally { if (!cancelled) setLoaded(true); }
    })();
    return () => { cancelled = true; };
  }, []);

  return { address, loaded };
}

/**
 * Applies the saved default once it arrives — the pin, the written address and
 * the serviceable area — without stamping over anything the customer has
 * already touched on this form.
 */
export function useAddressPrefill(opts: {
  address: CustomerAddress | null;
  loaded: boolean;
  dropoff: LatLngValue | null;
  text: string;
  setDropoff: (v: LatLngValue) => void;
  setText: (v: string) => void;
  setArea?: (v: AreaSelection) => void;
}) {
  const applied = useRef(false);
  const { address, loaded, dropoff, text, setDropoff, setText, setArea } = opts;

  useEffect(() => {
    if (!loaded || !address || applied.current) return;
    applied.current = true;
    if (!dropoff && address.lat != null && address.lng != null) {
      setDropoff({ lat: address.lat, lng: address.lng });
    }
    if (address.address && !text.trim()) setText(address.address);
    if (setArea && address.province && address.city && address.barangay) {
      setArea({ province: address.province, city: address.city, barangay: address.barangay });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, address]);
}

/**
 * Written drop-off address. The pin gets the rider to the street; this gets
 * them to the door — and gives them something to ask a neighbour about when the
 * pin is off.
 */
export function DeliveryAddressField({ value, onChange, saved, label = 'Complete delivery address' }: {
  value: string;
  onChange: (v: string) => void;
  saved?: CustomerAddress | null;
  label?: string;
}) {
  const useSaved = useCallback(() => { if (saved?.address) onChange(saved.address); }, [saved, onChange]);
  return (
    <div>
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="text-sm font-medium text-black/70">
          {label} <span className="text-red-600">*</span>
        </span>
        {saved?.address && saved.address !== value && (
          <button type="button" onClick={useSaved}
            className="shrink-0 text-xs font-medium text-brand-charcoal underline">
            Use saved address
          </button>
        )}
      </div>
      <textarea rows={2} value={value} onChange={(e) => onChange(e.target.value)}
        placeholder="House/unit no., street, subdivision, landmark"
        className="w-full rounded-lg border border-black/10 bg-white px-3 py-2 text-sm outline-none focus:border-brand-orange focus:ring-2 focus:ring-brand-orange/30" />
      <p className="mt-1 text-xs text-black/40">
        Your rider sees this next to the map pin — it helps when the pin lands on the wrong house.
      </p>
    </div>
  );
}
