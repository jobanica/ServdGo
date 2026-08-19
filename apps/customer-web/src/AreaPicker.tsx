import { useEffect, useMemo, useState } from 'react';
import { listServiceAreas, groupAreas, type ServiceArea, type AreaSelection } from '@servdgo/supabase';
import { supabase } from './lib/supabase.ts';

const sel = 'w-full rounded-lg border border-black/10 bg-white px-3 py-2 text-sm outline-none focus:border-brand-green';

/** Great-circle distance in km. */
export function kmBetween(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6371, toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat), dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Delivery-area picker: Province → City/Municipality → Barangay, listing only
 * the areas the operator serves. `onRequired` tells the form whether a choice
 * must be made — false only when no areas are configured at all, so the app
 * still works before setup.
 */
export function AreaPicker({ value, onChange, onRequired, onAreasLoaded }: {
  value: AreaSelection | null;
  onChange: (v: AreaSelection | null) => void;
  onRequired: (required: boolean) => void;
  onAreasLoaded?: (areas: ServiceArea[]) => void;
}) {
  const [areas, setAreas] = useState<ServiceArea[] | null>(null);
  const [province, setProvince] = useState(value?.province ?? '');
  const [city, setCity] = useState(value?.city ?? '');

  // A saved address arrives with its area already on it, after this picker has
  // mounted. Without this the form knew the area but the three dropdowns sat
  // blank, which reads as "you still have to choose" — and touching one to
  // check would clear the area that was already right.
  useEffect(() => {
    if (!value) return;
    setProvince(value.province);
    setCity(value.city);
  }, [value?.province, value?.city]);  // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!supabase) { setAreas([]); onRequired(false); return; }
    listServiceAreas(supabase)
      .then((a) => {
        const active = a.filter((x) => x.is_active);
        setAreas(active);
        // Report on load — not only when the user touches a dropdown — so the
        // form actually enforces the choice.
        onRequired(active.length > 0);
        onAreasLoaded?.(active);
      })
      .catch(() => { setAreas([]); onRequired(false); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const grouped = useMemo(() => groupAreas(areas ?? []), [areas]);
  const provinces = [...grouped.keys()];
  const cities = province ? [...(grouped.get(province)?.keys() ?? [])] : [];
  const barangays = province && city ? (grouped.get(province)?.get(city) ?? []) : [];

  if (areas === null) return <p className="text-xs text-black/40">Loading delivery areas…</p>;
  if (areas.length === 0) return null; // no areas configured — nothing to choose

  return (
    <div>
      <span className="mb-1 block text-sm font-medium text-black/70">Delivery area</span>
      <div className="grid gap-2 sm:grid-cols-3">
        <select className={sel} value={province}
          onChange={(e) => { setProvince(e.target.value); setCity(''); onChange(null); }}>
          <option value="">Province…</option>
          {provinces.map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
        <select className={sel} value={city} disabled={!province}
          onChange={(e) => { setCity(e.target.value); onChange(null); }}>
          <option value="">City / Municipality…</option>
          {cities.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <select className={sel} value={value?.barangay ?? ''} disabled={!city}
          onChange={(e) => {
            const b = e.target.value;
            onChange(b ? { province, city, barangay: b } : null);
          }}>
          <option value="">Barangay…</option>
          {barangays.map((b) => <option key={b.id} value={b.barangay}>{b.barangay}</option>)}
        </select>
      </div>
      <p className="mt-1 text-xs text-black/40">
        Only the areas we currently deliver to are listed. Don't see yours? We don't serve it yet.
      </p>
    </div>
  );
}
