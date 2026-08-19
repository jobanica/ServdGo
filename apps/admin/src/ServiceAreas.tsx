import { useEffect, useState } from 'react';
import {
  listServiceAreas, addServiceArea, setServiceAreaActive, setCityAreasActive, deleteServiceArea,
  groupAreas, type ServiceArea,
} from '@ebd/supabase';
import { supabase } from './lib/supabase.ts';
import { Card, Muted, ErrorNote, Toggle } from './ui.tsx';
import { errMessage } from '@ebd/shared';

const inp = 'w-full rounded-lg border border-black/10 bg-white px-3 py-2 text-sm outline-none focus:border-brand-green focus:ring-2 focus:ring-brand-green/30';

const SAMPLE: ServiceArea[] = [
  { id: '1', province: 'Laguna', city: 'Santa Cruz', barangay: 'Poblacion I', is_active: true },
  { id: '2', province: 'Laguna', city: 'Santa Cruz', barangay: 'Bagumbayan', is_active: true },
  { id: '3', province: 'Laguna', city: 'Pagsanjan', barangay: 'Sabang', is_active: false },
];

/**
 * Serviceable areas — Province → City/Municipality → Barangay. Tick a barangay
 * to serve it; customers outside the ticked areas can't place an order.
 */
export function ServiceAreas() {
  const [rows, setRows] = useState<ServiceArea[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({ province: '', city: '', barangay: '' });
  const [busy, setBusy] = useState(false);

  async function load() {
    if (!supabase) { setRows(SAMPLE); setLoading(false); return; }
    try { setRows(await listServiceAreas(supabase)); setError(null); }
    catch (e) { setError(errMessage(e)); }
    finally { setLoading(false); }
  }
  useEffect(() => { void load(); }, []);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    if (!supabase) return;
    const { province, city, barangay } = form;
    if (!province.trim() || !city.trim() || !barangay.trim()) return;
    setBusy(true); setError(null);
    try {
      await addServiceArea(supabase, form);
      setForm({ province: province.trim(), city: city.trim(), barangay: '' }); // keep province/city for fast entry
      await load();
    } catch (e) {
      const msg = errMessage(e);
      setError(/duplicate key/i.test(msg) ? 'That barangay is already on the list.' : msg);
    } finally { setBusy(false); }
  }

  async function toggle(a: ServiceArea, active: boolean) {
    if (!supabase) { setRows((rs) => rs.map((x) => x.id === a.id ? { ...x, is_active: active } : x)); return; }
    await setServiceAreaActive(supabase, a.id, active);
    await load();
  }

  async function toggleCity(province: string, city: string, active: boolean) {
    if (!supabase) return;
    await setCityAreasActive(supabase, province, city, active);
    await load();
  }

  async function remove(a: ServiceArea) {
    if (!supabase) return;
    if (!window.confirm(`Remove ${a.barangay}, ${a.city} from the list?`)) return;
    await deleteServiceArea(supabase, a.id);
    await load();
  }

  if (loading) return <Muted>Loading…</Muted>;

  const grouped = groupAreas(rows);
  const activeCount = rows.filter((r) => r.is_active).length;

  return (
    <div className="space-y-4">
      <Card title="Add a serviceable barangay">
        <form onSubmit={add} className="grid gap-3 sm:grid-cols-4">
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-black/60">Province</span>
            <input className={inp} value={form.province} placeholder="e.g. Laguna"
              onChange={(e) => setForm((f) => ({ ...f, province: e.target.value }))} />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-black/60">City / Municipality</span>
            <input className={inp} value={form.city} placeholder="e.g. Santa Cruz"
              onChange={(e) => setForm((f) => ({ ...f, city: e.target.value }))} />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-black/60">Barangay</span>
            <input className={inp} value={form.barangay} placeholder="e.g. Poblacion I"
              onChange={(e) => setForm((f) => ({ ...f, barangay: e.target.value }))} />
          </label>
          <div className="flex items-end">
            <button disabled={busy || !supabase}
              className="w-full rounded-lg bg-brand-green py-2 text-sm font-semibold text-white disabled:opacity-50">
              {busy ? 'Adding…' : 'Add barangay'}
            </button>
          </div>
        </form>
        {error && <div className="mt-3"><ErrorNote msg={error} /></div>}
        <p className="mt-2 text-xs text-black/40">
          Province and city stay filled in so you can add barangays one after another.
        </p>
      </Card>

      <Card title={`Serviceable areas (${activeCount} of ${rows.length} active)`}>
        {rows.length === 0 ? (
          <Muted>No areas yet. Add the barangays you deliver to — customers outside them can't order.</Muted>
        ) : (
          <div className="space-y-5">
            {[...grouped.entries()].map(([province, cities]) => (
              <div key={province}>
                <h3 className="mb-2 text-sm font-bold text-brand-ink">{province}</h3>
                <div className="space-y-3">
                  {[...cities.entries()].map(([city, list]) => {
                    const allOn = list.every((a) => a.is_active);
                    return (
                      <div key={city} className="rounded-xl ring-1 ring-black/5">
                        <div className="flex items-center justify-between border-b border-black/5 px-3 py-2">
                          <span className="text-sm font-semibold">
                            {city}
                            <span className="ml-2 text-xs font-normal text-black/40">
                              {list.filter((a) => a.is_active).length}/{list.length} barangays
                            </span>
                          </span>
                          <button onClick={() => toggleCity(province, city, !allOn)}
                            className="rounded-lg border border-black/15 px-2.5 py-1 text-xs font-medium text-black/60">
                            {allOn ? 'Untick all' : 'Tick all'}
                          </button>
                        </div>
                        <ul className="divide-y divide-black/5">
                          {list.map((a) => (
                            <li key={a.id} className="flex items-center justify-between gap-2 px-3 py-2">
                              <span className={`text-sm ${a.is_active ? '' : 'text-black/35 line-through'}`}>{a.barangay}</span>
                              <span className="flex items-center gap-3">
                                <Toggle on={a.is_active} onChange={(v) => toggle(a, v)} />
                                <button onClick={() => remove(a)} className="text-xs text-red-600">Remove</button>
                              </span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
