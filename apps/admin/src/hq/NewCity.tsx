/**
 * Opening a city.
 *
 * createTerritory() has been in the data layer since the franchise model was
 * built and nothing ever called it, so the console could show cities, run them
 * and bill them — but not start one. Which meant it could not issue a second
 * operator account either: an operator account belongs to a city, and there was
 * no way to make another city for one to belong to.
 *
 * A new city opens as a lead, not live. The go-live gate is a deliberate step
 * elsewhere (0090), and a city that took orders the moment it was typed in
 * would be a city trading before anyone agreed terms with it.
 *
 * The pin is not decoration. territory_for_point() routes every order by the
 * pickup's distance from this centre, so a city with no centre and a zero
 * radius accepts nothing and refuses every merchant key with "that restaurant
 * has no territory yet".
 */
import { useState } from 'react';
import { createTerritory, type Territory } from '@servdgo/supabase';
import { errMessage } from '@servdgo/shared';
import { supabase } from '../lib/supabase.ts';
import { Card, ErrorNote } from '../ui.tsx';
import { MapPicker, type MapValue } from '../MapPicker.tsx';

const inp = 'w-full rounded-lg border border-black/10 bg-white px-3 py-2 text-sm outline-none focus:border-brand-orange focus:ring-2 focus:ring-brand-orange/30';

/** "Davao City" → "davao-city". The operator never types this. */
export function slugify(name: string): string {
  return name.toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

export function NewCity({ band, onCreated }: {
  /** The commission floor and ceiling from platform settings. */
  band?: { min: number; max: number };
  onCreated: (id: string, name: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const [pin, setPin] = useState<MapValue | null>(null);
  const [radius, setRadius] = useState('15');
  const [commission, setCommission] = useState('15');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const min = band ? band.min * 100 : 10;
  const max = band ? band.max * 100 : 25;
  const rate = Number(commission);
  const radiusKm = Number(radius);
  const rateOk = Number.isFinite(rate) && rate >= min && rate <= max;
  const ready = name.trim().length > 1 && slug.length > 1 && pin
    && Number.isFinite(radiusKm) && radiusKm > 0 && rateOk;

  function setNameAndSlug(v: string) {
    setName(v);
    if (!slugTouched) setSlug(slugify(v));
  }

  async function create() {
    if (!supabase || !pin) return;
    setBusy(true); setError(null);
    try {
      const id = await createTerritory(supabase, {
        name: name.trim(),
        slug,
        serviceCenterLat: pin.lat,
        serviceCenterLng: pin.lng,
        serviceRadiusKm: radiusKm,
        commissionRate: rate / 100,
      });
      onCreated(id, name.trim());
      setOpen(false);
      setName(''); setSlug(''); setSlugTouched(false); setPin(null);
      setRadius('15'); setCommission('15');
    } catch (e) {
      const msg = errMessage(e);
      // The slug is unique in the database; say which part is the problem
      // rather than handing over a constraint name.
      setError(/duplicate key|unique/i.test(msg)
        ? `There is already a city with the short name "${slug}". Pick another.`
        : msg);
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button onClick={() => setOpen(true)}
        className="rounded-xl bg-brand-orange px-3 py-2 text-sm font-semibold text-white hover:opacity-90">
        Add a city
      </button>
    );
  }

  return (
    <Card title="Open a new city" action={
      <button onClick={() => setOpen(false)} className="text-sm font-semibold text-black/50">Cancel</button>
    }>
      <p className="mb-4 max-w-2xl text-sm text-black/55">
        It opens as a <b>lead</b> — no orders, no riders, nothing trading. Give it an
        operator on the next screen, work through its checklist, then take it live.
      </p>

      <div className="grid gap-4 sm:grid-cols-2">
        <label className="block">
          <span className="text-xs font-semibold uppercase tracking-wide text-black/40">City name</span>
          <input className={`${inp} mt-1`} value={name} placeholder="Davao City"
            onChange={(e) => setNameAndSlug(e.target.value)} />
        </label>
        <label className="block">
          <span className="text-xs font-semibold uppercase tracking-wide text-black/40">Short name</span>
          <input className={`${inp} mt-1`} value={slug} placeholder="davao-city"
            onChange={(e) => { setSlugTouched(true); setSlug(slugify(e.target.value)); }} />
          <span className="mt-1 block text-xs text-black/45">
            Used in links and exports. Letters, numbers and dashes.
          </span>
        </label>
      </div>

      <p className="mt-4 text-sm font-medium">Where it delivers</p>
      <p className="text-xs text-black/50">
        Drop the pin on the city centre. Every order is routed to this city by how far
        its pickup is from here, so a city with no pin takes nothing.
      </p>
      <div className="mt-2">
        <MapPicker value={pin} onChange={setPin}
          radiusKm={Number.isFinite(radiusKm) && radiusKm > 0 ? radiusKm : undefined}
          height={300} />
      </div>

      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <label className="block">
          <span className="mb-1 block text-sm font-medium">Radius — {radius || '0'} km</span>
          <input type="range" min={1} max={60} step={1} className="w-full accent-brand-orange"
            value={radius} onChange={(e) => setRadius(e.target.value)} />
        </label>
        <label className="block">
          <span className="mb-1 block text-sm font-medium">Commission — {commission || '0'}%</span>
          <input type="range" min={min} max={max} step={0.5} className="w-full accent-brand-orange"
            value={commission} onChange={(e) => setCommission(e.target.value)} />
          <span className="mt-1 block text-xs text-black/45">
            The operator's cut of each delivery. The platform band is {min}%–{max}%,
            and they can move inside it later.
          </span>
        </label>
      </div>

      {error && <div className="mt-3"><ErrorNote msg={error} /></div>}

      <button disabled={!ready || busy} onClick={() => void create()}
        className="mt-4 rounded-xl bg-brand-orange px-4 py-2 text-sm font-bold text-white disabled:opacity-50">
        {busy ? 'Opening…' : 'Open the city'}
      </button>
      {!ready && !busy && (
        <p className="mt-2 text-xs text-black/45">
          {!name.trim() ? 'Give it a name.'
            : !pin ? 'Drop the pin on the map.'
            : !rateOk ? `Commission has to be between ${min}% and ${max}%.`
            : 'Set a radius.'}
        </p>
      )}
    </Card>
  );
}

export type { Territory };
