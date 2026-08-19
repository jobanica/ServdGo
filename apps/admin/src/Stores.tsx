import { useEffect, useState } from 'react';
import {
  listAllStores,
  createStore,
  setStoreAvailability,
  setStoreLocation,
  updateStore,
  listMenu,
  createMenuItem,
  setMenuItemAvailability,
  createMenuCategory,
  deleteMenuCategory,
  uploadStoreLogo,
  uploadMenuItemImage,
  updateMenuItem,
  createMenuItemOption,
  deleteMenuItemOption,
  createOptionGroup,
  deleteOptionGroup,
  copyItemCustomizations,
  deleteStore,
  deleteMenuItem,
  copyStoreMenu,
} from '@servdgo/supabase';
import { isOpenNow, scheduleLabel, WEEKDAYS, ALL_DAYS,
  errMessage,
} from '@servdgo/shared';
import { supabase } from './lib/supabase.ts';
import { ImportMenu } from './ImportMenu.tsx';
import { MapPicker, type MapValue } from './MapPicker.tsx';
import { PriceReports } from './PriceReports.tsx';
import { StoreMarkup, ItemMarkup } from './Markup.tsx';
import { Toggle } from './ui.tsx';

/** Time value normaliser: "" → null, otherwise the HH:MM string. */
const hm = (v: string): string | null => (v.trim() ? v : null);

/** All-days-selected collapses to null ("every day"); otherwise the array. */
const daysOrNull = (days: number[]): number[] | null => (days.length >= 7 ? null : [...days].sort((a, b) => a - b));

/** Seven day chips (Sun…Sat) to pick which weekdays a store is open. */
function DayPicker({ value, onChange }: { value: number[]; onChange: (days: number[]) => void }) {
  function toggle(d: number) {
    onChange(value.includes(d) ? value.filter((x) => x !== d) : [...value, d]);
  }
  return (
    <div className="flex flex-wrap gap-1.5">
      {ALL_DAYS.map((d) => {
        const on = value.includes(d);
        return (
          <button key={d} type="button" onClick={() => toggle(d)}
            className={`rounded-full px-3 py-1 text-xs font-semibold ring-1 transition ${
              on ? 'bg-brand-orange text-white ring-brand-orange' : 'bg-white text-black/50 ring-black/15'
            }`}>
            {WEEKDAYS[d]}
          </button>
        );
      })}
    </div>
  );
}

interface StoreRow {
  id: string;
  name: string;
  category: string | null;
  contact_number: string | null;
  is_available: boolean;
  address: string | null;
  lat: number | null;
  lng: number | null;
  logo_url: string | null;
  opens_at: string | null;
  closes_at: string | null;
  open_days: number[] | null;
  markup_enabled?: boolean | null;
  markup_amount?: number | null;
}
interface ItemRow {
  id: string; name: string; price: number; is_available: boolean;
  category_id: string | null; image_url: string | null; description: string | null;
  /** Mark-up switches; `markup_amount` null means "use the store's". */
  markup_enabled?: boolean | null; markup_amount?: number | null;
  /** What the customer is quoted — shelf price plus the resolved mark-up. */
  markup?: number; customer_price?: number;
}
interface CatRow { id: string; title: string; sort_order: number }
interface GroupRow { id: string; menu_item_id: string; name: string; required: boolean; multi_select: boolean; sort_order: number }
interface OptRow { id: string; menu_item_id: string; group_id: string | null; option_name: string; price_delta: number }

export function Stores() {
  const [rows, setRows] = useState<StoreRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  const [importing, setImporting] = useState(false);

  // New-store form
  const [name, setName] = useState('');
  const [category, setCategory] = useState('');
  const [contact, setContact] = useState('');
  const [address, setAddress] = useState('');
  const [opensAt, setOpensAt] = useState('');
  const [closesAt, setClosesAt] = useState('');
  const [days, setDays] = useState<number[]>([...ALL_DAYS]);
  const [pin, setPin] = useState<MapValue | null>(null);

  async function load() {
    if (!supabase) { setLoading(false); return; }
    setLoading(true);
    try {
      setRows((await listAllStores(supabase)) as StoreRow[]);
      setError(null);
    } catch (e) {
      setError(errMessage(e));
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { void load(); }, []);

  async function addStore(e: React.FormEvent) {
    e.preventDefault();
    if (!supabase || !name.trim()) return;
    try {
      await createStore(supabase, {
        name: name.trim(),
        category: category.trim() || undefined,
        contactNumber: contact.trim() || undefined,
        address: address.trim() || undefined,
        lat: pin?.lat,
        lng: pin?.lng,
        opensAt: hm(opensAt),
        closesAt: hm(closesAt),
        openDays: daysOrNull(days),
      });
      setName(''); setCategory(''); setContact(''); setAddress(''); setOpensAt(''); setClosesAt(''); setDays([...ALL_DAYS]); setPin(null); setError(null);
      await load();
    } catch (e) {
      const msg = errMessage(e);
      setError(/row-level security|42501/.test(msg)
        ? 'Not authorized — sign in with an admin account to add stores.'
        : msg);
    }
  }

  async function toggle(id: string, available: boolean) {
    if (!supabase) return;
    await setStoreAvailability(supabase, id, available);
    await load();
  }

  async function removeStore(s: StoreRow) {
    if (!supabase) return;
    if (!window.confirm(`Delete “${s.name}” and its whole menu? This can’t be undone.`)) return;
    setError(null);
    try { await deleteStore(supabase, s.id); setOpenId(null); await load(); }
    catch (e) { setError(errMessage(e)); }
  }

  if (loading) return <Muted>Loading…</Muted>;

  return (
    <div className="space-y-5">
      <PriceReports />
      <div className="flex justify-end">
        <button onClick={() => setImporting((v) => !v)}
          className="rounded-lg px-3 py-1.5 text-sm font-medium ring-1 ring-black/10 hover:bg-black/[0.03]">
          {importing ? '← Add manually' : '⇪ Bulk import CSV'}
        </button>
      </div>

      {importing ? (
        <ImportMenu onDone={load} />
      ) : (
      <>
      <form onSubmit={addStore} className="rounded-xl bg-white p-4 shadow-sm ring-1 ring-black/5">
        <h3 className="mb-3 font-semibold">Add a store</h3>
        <div className="grid grid-cols-3 gap-3">
          <input className={inp} placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} required />
          <input className={inp} placeholder="Category" value={category} onChange={(e) => setCategory(e.target.value)} />
          <input className={inp} placeholder="Contact #" value={contact} onChange={(e) => setContact(e.target.value)} />
        </div>
        <input className={inp + ' mt-3 w-full'} placeholder="Address (optional)" value={address} onChange={(e) => setAddress(e.target.value)} />
        <div className="mt-3 grid grid-cols-2 gap-3">
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-black/70">Opens at</span>
            <input type="time" className={inp} value={opensAt} onChange={(e) => setOpensAt(e.target.value)} />
          </label>
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-black/70">Closes at</span>
            <input type="time" className={inp} value={closesAt} onChange={(e) => setClosesAt(e.target.value)} />
          </label>
        </div>
        <div className="mt-3">
          <p className="mb-1.5 text-sm font-medium text-black/70">Open days</p>
          <DayPicker value={days} onChange={setDays} />
        </div>
        <p className="mt-1 text-xs text-black/40">Leave times blank for always-open. Un-highlight a day (e.g. Sun) to close on that day. The store auto-opens and auto-closes on this schedule (Philippine time).</p>
        <div className="mt-3">
          <p className="mb-1.5 text-sm font-medium text-black/70">Store location</p>
          <MapPicker value={pin} onChange={setPin} />
        </div>
        <button className="mt-3 rounded-lg bg-brand-orange px-4 py-2 text-sm font-semibold text-white" disabled={!supabase}>
          Add store
        </button>
        {!supabase && <span className="ml-3 text-xs text-black/40">Connect Supabase to add stores.</span>}
      </form>

      {error && <ErrorNote msg={error} />}
      {rows.length === 0 && !error && <Muted>No stores yet.</Muted>}

      <div className="space-y-3">
        {rows.map((s) => (
          <div key={s.id} className="rounded-xl bg-white shadow-sm ring-1 ring-black/5">
            <div className="flex items-center justify-between p-4">
              <button className="flex items-center gap-3 text-left" onClick={() => setOpenId(openId === s.id ? null : s.id)}>
                <span className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-black/[0.04] ring-1 ring-black/10">
                  {s.logo_url ? <img src={s.logo_url} alt="" className="h-full w-full object-cover" /> : <span className="text-base text-black/25">🏪</span>}
                </span>
                <span>
                  <span className="font-medium">{s.name}</span>
                  <span className="ml-2 text-xs text-black/40">{s.category ?? '—'}</span>
                  <span className={`ml-2 rounded-full px-2 py-0.5 text-[11px] font-medium ${
                    s.lat != null && s.lng != null ? 'bg-brand-orange/15 text-green-800' : 'bg-brand-yellow/30 text-yellow-800'
                  }`}>
                    {s.lat != null && s.lng != null ? '📍 Pinned' : 'No location'}
                  </span>
                </span>
              </button>
              <div className="flex items-center gap-2 text-sm">
                <StoreStatus store={s} />
                <Toggle on={s.is_available} onChange={(v) => toggle(s.id, v)} />
              </div>
            </div>
            {openId === s.id && (
              <>
                <StoreDetailsEditor store={s} onSaved={load} />
                <div className="border-t border-black/5 p-4">
                  <h4 className="mb-2 text-sm font-semibold">Store logo</h4>
                  <ImageUpload url={s.logo_url}
                    onUpload={async (file) => { if (supabase) { await uploadStoreLogo(supabase, s.id, file); await load(); } }} />
                </div>
                <LocationEditor store={s} onSaved={load} />
                <div className="px-4 pb-4"><StoreMarkup store={s} onSaved={load} /></div>
                <MenuEditor storeId={s.id} key={`${s.id}:${s.markup_enabled}:${s.markup_amount}`} />
                <CopyMenuPanel store={s} stores={rows} />
                <div className="border-t border-black/5 p-4">
                  <button onClick={() => removeStore(s)}
                    className="rounded-lg border border-red-300 px-3 py-1.5 text-xs font-medium text-red-600 hover:bg-red-50">
                    Delete this store
                  </button>
                  <span className="ml-2 text-xs text-black/40">Removes the store and its whole menu.</span>
                </div>
              </>
            )}
          </div>
        ))}
      </div>
      </>
      )}
    </div>
  );
}

/** Current open/closed status for a store: manual toggle × schedule. */
function StoreStatus({ store }: { store: StoreRow }) {
  const openByHours = isOpenNow(store.opens_at, store.closes_at, store.open_days);
  const label = scheduleLabel(store.opens_at, store.closes_at, store.open_days);
  const hasSchedule = !!(store.opens_at || store.closes_at || (store.open_days && store.open_days.length < 7));
  if (!store.is_available) return <span className="text-xs font-medium text-black/40">Closed</span>;
  if (!openByHours) {
    return (
      <span className="text-right text-xs font-medium text-yellow-700" title={label}>
        Closed now
        <span className="block font-normal text-black/40">{label}</span>
      </span>
    );
  }
  return (
    <span className="text-right text-xs font-medium text-green-700">
      Open
      {hasSchedule && <span className="block font-normal text-black/40">{label}</span>}
    </span>
  );
}

function StoreDetailsEditor({ store, onSaved }: { store: StoreRow; onSaved: () => void }) {
  const [name, setName] = useState(store.name);
  const [category, setCategory] = useState(store.category ?? '');
  const [contact, setContact] = useState(store.contact_number ?? '');
  const [address, setAddress] = useState(store.address ?? '');
  const [opensAt, setOpensAt] = useState(store.opens_at?.slice(0, 5) ?? '');
  const [closesAt, setClosesAt] = useState(store.closes_at?.slice(0, 5) ?? '');
  const [days, setDays] = useState<number[]>(store.open_days ?? [...ALL_DAYS]);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const daysKey = (d: number[]) => [...d].sort((a, b) => a - b).join(',');
  const dirty = name.trim() !== store.name || category !== (store.category ?? '')
    || contact !== (store.contact_number ?? '') || address !== (store.address ?? '')
    || opensAt !== (store.opens_at?.slice(0, 5) ?? '') || closesAt !== (store.closes_at?.slice(0, 5) ?? '')
    || daysKey(days) !== daysKey(store.open_days ?? [...ALL_DAYS]);

  async function save() {
    if (!supabase || !name.trim()) return;
    setSaving(true); setSaved(false); setErr(null);
    try {
      await updateStore(supabase, store.id, {
        name: name.trim(),
        category: category.trim() || null,
        contactNumber: contact.trim() || null,
        address: address.trim() || null,
        opensAt: hm(opensAt),
        closesAt: hm(closesAt),
        openDays: daysOrNull(days),
      });
      setSaved(true); onSaved();
    } catch (e) { setErr(errMessage(e)); }
    finally { setSaving(false); }
  }

  return (
    <div className="border-t border-black/5 p-4">
      <div className="mb-2 flex items-center justify-between">
        <h4 className="text-sm font-semibold">Store details</h4>
        <button onClick={save} disabled={!supabase || !name.trim() || !dirty || saving}
          className="rounded-lg bg-brand-orange px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50">
          {saving ? 'Saving…' : dirty ? 'Save details' : saved ? '✓ Saved' : 'Saved'}
        </button>
      </div>
      <div className="grid gap-2 sm:grid-cols-3">
        <input className={inp} placeholder="Name" value={name} onChange={(e) => { setName(e.target.value); setSaved(false); }} />
        <input className={inp} placeholder="Category" value={category} onChange={(e) => { setCategory(e.target.value); setSaved(false); }} />
        <input className={inp} placeholder="Contact #" value={contact} onChange={(e) => { setContact(e.target.value); setSaved(false); }} />
      </div>
      <input className={inp + ' mt-2 w-full'} placeholder="Address (optional)" value={address} onChange={(e) => { setAddress(e.target.value); setSaved(false); }} />
      <div className="mt-2 grid grid-cols-2 gap-2">
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-black/60">Opens at</span>
          <input type="time" className={inp} value={opensAt} onChange={(e) => { setOpensAt(e.target.value); setSaved(false); }} />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-black/60">Closes at</span>
          <input type="time" className={inp} value={closesAt} onChange={(e) => { setClosesAt(e.target.value); setSaved(false); }} />
        </label>
      </div>
      <div className="mt-2">
        <span className="mb-1 block text-xs font-medium text-black/60">Open days</span>
        <DayPicker value={days} onChange={(d) => { setDays(d); setSaved(false); }} />
      </div>
      <p className="mt-1 text-xs text-black/40">Blank times = always open. Un-highlight a day (e.g. Sun) to close then. Auto-opens/closes on schedule (Philippine time).</p>
      {err && <p className="mt-1 text-xs text-red-600">{err}</p>}
    </div>
  );
}

function LocationEditor({ store, onSaved }: { store: StoreRow; onSaved: () => void }) {
  const initial: MapValue | null =
    store.lat != null && store.lng != null ? { lat: store.lat, lng: store.lng } : null;
  const [pin, setPin] = useState<MapValue | null>(initial);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const dirty = pin?.lat !== initial?.lat || pin?.lng !== initial?.lng;

  async function save() {
    if (!supabase || !pin) return;
    setSaving(true); setSaved(false);
    try {
      await setStoreLocation(supabase, store.id, pin);
      setSaved(true);
      onSaved();
    } finally { setSaving(false); }
  }

  return (
    <div className="border-t border-black/5 p-4">
      <div className="mb-2 flex items-center justify-between">
        <h4 className="text-sm font-semibold">Store location</h4>
        <button onClick={save} disabled={!supabase || !pin || !dirty || saving}
          className="rounded-lg bg-brand-orange px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50">
          {saving ? 'Saving…' : dirty ? 'Save location' : saved ? '✓ Saved' : 'Saved'}
        </button>
      </div>
      <MapPicker value={pin} onChange={(v) => { setPin(v); setSaved(false); }} height={220} />
      <p className="mt-1 text-xs text-black/40">
        The delivery fee is computed from this pin to the customer’s drop-off, so place it precisely.
      </p>
    </div>
  );
}

function MenuEditor({ storeId }: { storeId: string }) {
  const [cats, setCats] = useState<CatRow[]>([]);
  const [items, setItems] = useState<ItemRow[]>([]);
  const [opts, setOpts] = useState<OptRow[]>([]);
  const [groups, setGroups] = useState<GroupRow[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [catTitle, setCatTitle] = useState('');
  const [name, setName] = useState('');
  const [price, setPrice] = useState('');
  const [catId, setCatId] = useState(''); // category for the new item ('' = uncategorised)
  const [markup, setMarkup] = useState({ enabled: false, amount: 0 });

  async function load() {
    if (!supabase) return;
    const menu = await listMenu(supabase, storeId, false);
    setMarkup(menu.markup ?? { enabled: false, amount: 0 });
    setCats((menu.categories as CatRow[]).sort((a, b) => a.sort_order - b.sort_order));
    setItems(menu.items as unknown as ItemRow[]);
    setOpts((menu.options as OptRow[]) ?? []);
    setGroups((menu.optionGroups as GroupRow[]) ?? []);
  }
  useEffect(() => { void load(); }, [storeId]);

  async function addCategory(e: React.FormEvent) {
    e.preventDefault();
    if (!supabase || !catTitle.trim()) return;
    await createMenuCategory(supabase, { storeId, title: catTitle.trim(), sortOrder: cats.length });
    setCatTitle('');
    await load();
  }

  async function removeCategory(id: string) {
    if (!supabase) return;
    await deleteMenuCategory(supabase, id);
    if (catId === id) setCatId('');
    await load();
  }

  async function add(e: React.FormEvent) {
    e.preventDefault();
    if (!supabase || !name.trim()) return;
    await createMenuItem(supabase, { storeId, name: name.trim(), price: Number(price) || 0, categoryId: catId || undefined });
    setName(''); setPrice('');
    await load();
  }

  // Group items under their category, with an "Uncategorised" bucket last.
  const knownCat = new Set(cats.map((c) => c.id));
  const sections: { cat: CatRow | null; rows: ItemRow[] }[] = [
    ...cats.map((c) => ({ cat: c, rows: items.filter((i) => i.category_id === c.id) })),
    { cat: null, rows: items.filter((i) => !i.category_id || !knownCat.has(i.category_id)) },
  ];

  return (
    <div className="border-t border-black/5 bg-black/[0.015] p-4">
      {/* Categories */}
      <div className="mb-4">
        <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-black/40">Categories</p>
        <div className="mb-2 flex flex-wrap gap-2">
          {cats.map((c) => (
            <span key={c.id} className="inline-flex items-center gap-1 rounded-full bg-brand-orange/15 px-2.5 py-1 text-xs font-medium text-green-800">
              {c.title}
              <button onClick={() => removeCategory(c.id)} title="Delete category"
                className="text-green-800/60 hover:text-red-600">×</button>
            </span>
          ))}
          {cats.length === 0 && <span className="text-xs text-black/40">No categories yet.</span>}
        </div>
        <form onSubmit={addCategory} className="flex gap-2">
          <input className={inp + ' flex-1'} placeholder="New category (e.g. Rice Meals, Drinks)"
            value={catTitle} onChange={(e) => setCatTitle(e.target.value)} />
          <button className="rounded-lg bg-brand-orange px-3 py-2 text-sm font-medium text-white">Add category</button>
        </form>
      </div>

      {/* Items grouped by category */}
      <div className="mb-3 space-y-3">
        {sections.map(({ cat, rows }) => (
          (cat || rows.length > 0) && (
            <div key={cat?.id ?? 'uncat'}>
              <p className="mb-1 text-xs font-semibold text-black/50">{cat ? cat.title : 'Uncategorised'}</p>
              <ul className="divide-y divide-black/5">
                {rows.map((it) => (
                  <li key={it.id} className="py-2">
                    <div className="flex items-center justify-between gap-3 text-sm">
                      <span className="flex min-w-0 items-center gap-2">
                        <span className="relative flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-md bg-black/[0.04] ring-1 ring-black/10">
                          {it.image_url ? <img src={it.image_url} alt="" className={`h-full w-full object-cover ${it.is_available ? '' : 'opacity-40'}`} /> : <span className="text-black/25">🍽️</span>}
                        </span>
                        <span className="min-w-0">
                          <span className={`block truncate ${it.is_available ? '' : 'text-black/40'}`}>
                            {it.name} · ₱{Number(it.price).toFixed(2)}
                            {Number(it.markup ?? 0) > 0 && (
                              <span className="text-brand-charcoal"> → ₱{Number(it.customer_price ?? it.price).toFixed(2)}</span>
                            )}
                          </span>
                          {!it.is_available && <span className="text-[11px] font-semibold text-red-600">SOLD OUT</span>}
                          {groups.some((g) => g.menu_item_id === it.id) && (
                            <span className="ml-0 block text-[11px] text-black/40">
                              {groups.filter((g) => g.menu_item_id === it.id).map((g) => g.name).join(' · ')}
                            </span>
                          )}
                        </span>
                      </span>
                      <span className="flex shrink-0 items-center gap-2">
                        <button onClick={() => setEditingId(editingId === it.id ? null : it.id)}
                          className="rounded-lg px-2.5 py-1 text-xs font-medium text-brand-charcoal ring-1 ring-brand-charcoal/40 hover:bg-brand-charcoal/5">
                          {editingId === it.id ? 'Close' : 'Edit'}
                        </button>
                        <button onClick={async () => { if (supabase) { await setMenuItemAvailability(supabase, it.id, !it.is_available); await load(); } }}
                          className={`rounded-lg px-2.5 py-1 text-xs font-medium ring-1 ${
                            it.is_available ? 'text-red-600 ring-red-300 hover:bg-red-50' : 'text-green-700 ring-green-300 hover:bg-green-50'
                          }`}>
                          {it.is_available ? 'Mark as Out' : 'Mark In'}
                        </button>
                      </span>
                    </div>
                    {/* Only meaningful once the store itself is marked up. */}
                    {editingId === it.id && markup.enabled && (
                      <ItemMarkup item={it} storeAmount={markup.amount} onSaved={load} />
                    )}
                    {editingId === it.id && (
                      <ItemEditor item={it} cats={cats} onSaved={load}
                        groups={groups.filter((g) => g.menu_item_id === it.id)}
                        options={opts.filter((o) => o.menu_item_id === it.id)}
                        sources={items
                          .filter((i) => i.id !== it.id && groups.some((g) => g.menu_item_id === i.id))
                          .map((i) => ({ id: i.id, name: i.name }))} />
                    )}
                  </li>
                ))}
                {rows.length === 0 && <li className="py-1.5 text-xs text-black/30">No items in this category.</li>}
              </ul>
            </div>
          )
        ))}
        {items.length === 0 && <p className="text-xs text-black/40">No items yet.</p>}
      </div>

      {/* Add item */}
      <form onSubmit={add} className="flex flex-wrap gap-2">
        <input className={inp + ' min-w-[8rem] flex-1'} placeholder="Item name" value={name} onChange={(e) => setName(e.target.value)} />
        <input className={inp + ' w-24'} placeholder="Price" type="number" min={0} value={price} onChange={(e) => setPrice(e.target.value)} />
        <select className={inp} value={catId} onChange={(e) => setCatId(e.target.value)}>
          <option value="">No category</option>
          {cats.map((c) => <option key={c.id} value={c.id}>{c.title}</option>)}
        </select>
        <button className="rounded-lg bg-brand-charcoal px-3 py-2 text-sm font-medium text-white">Add item</button>
      </form>
    </div>
  );
}

/** Expanded editor for a single menu item: photo, price, category, customizations. */
function ItemEditor({ item, groups, options, cats, onSaved, sources }:
  { item: ItemRow; groups: GroupRow[]; options: OptRow[]; cats: CatRow[]; onSaved: () => void; sources: { id: string; name: string }[] }) {
  const [name, setName] = useState(item.name);
  const [price, setPrice] = useState(String(item.price));
  const [desc, setDesc] = useState(item.description ?? '');
  const [cat, setCat] = useState(item.category_id ?? '');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [delErr, setDelErr] = useState<string | null>(null);
  // new-group form
  const [showNewGroup, setShowNewGroup] = useState(false);
  const [gName, setGName] = useState('');
  const [gRequired, setGRequired] = useState(true);
  const [gMulti, setGMulti] = useState(false);
  // copy add-ons from another dish
  const [copyFrom, setCopyFrom] = useState('');
  const [copyBusy, setCopyBusy] = useState(false);
  const [copyMsg, setCopyMsg] = useState<string | null>(null);
  const base = Number(price) || 0;

  async function copyAddons() {
    if (!supabase || !copyFrom) return;
    setCopyBusy(true); setCopyMsg(null);
    try {
      const res = await copyItemCustomizations(supabase, copyFrom, item.id);
      setCopyMsg(`Copied ${res.groups} customization${res.groups === 1 ? '' : 's'} · ${res.options} option${res.options === 1 ? '' : 's'}. Edit any prices below.`);
      setCopyFrom('');
      onSaved();
    } catch (e) { setCopyMsg(errMessage(e)); }
    finally { setCopyBusy(false); }
  }

  async function removeItem() {
    if (!supabase) return;
    if (!window.confirm(`Delete “${item.name}”? This can’t be undone.`)) return;
    setDelErr(null);
    try { await deleteMenuItem(supabase, item.id); onSaved(); }
    catch (e) { setDelErr(errMessage(e)); }
  }

  async function saveMeta() {
    if (!supabase) return;
    setSaving(true); setSaved(false);
    try {
      await updateMenuItem(supabase, item.id, {
        name: name.trim() || item.name,
        price: Number(price) || 0,
        description: desc.trim() || null,
        categoryId: cat || null,
      });
      setSaved(true); onSaved();
    } finally { setSaving(false); }
  }
  async function addGroup(e: React.FormEvent) {
    e.preventDefault();
    if (!supabase || !gName.trim()) return;
    await createOptionGroup(supabase, { itemId: item.id, name: gName.trim(), required: gRequired, multiSelect: gMulti, sortOrder: groups.length });
    setGName(''); setGRequired(true); setGMulti(false); setShowNewGroup(false);
    onSaved();
  }

  return (
    <div className="mt-2 space-y-3 rounded-lg bg-white p-3 ring-1 ring-black/10">
      <div>
        <p className="mb-1 text-xs font-medium text-black/60">Photo</p>
        <ImageUpload url={item.image_url} rounded="rounded-md"
          onUpload={async (f) => { if (supabase) { await uploadMenuItemImage(supabase, item.id, f); onSaved(); } }} />
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="text-xs font-medium text-black/60">Name
          <input className={inp + ' mt-1 w-full'} value={name} onChange={(e) => setName(e.target.value)} /></label>
        <label className="text-xs font-medium text-black/60">Price (₱)
          <input className={inp + ' mt-1 w-full'} type="number" min={0} value={price} onChange={(e) => setPrice(e.target.value)} /></label>
        <label className="text-xs font-medium text-black/60 sm:col-span-2">Description
          <input className={inp + ' mt-1 w-full'} value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="Optional" /></label>
        <label className="text-xs font-medium text-black/60">Category
          <select className={inp + ' mt-1 w-full'} value={cat} onChange={(e) => setCat(e.target.value)}>
            <option value="">No category</option>
            {cats.map((c) => <option key={c.id} value={c.id}>{c.title}</option>)}
          </select></label>
      </div>
      <div className="flex items-center gap-3">
        <button onClick={saveMeta} disabled={saving || !supabase}
          className="rounded-lg bg-brand-orange px-4 py-1.5 text-sm font-semibold text-white disabled:opacity-50">
          {saving ? 'Saving…' : saved ? '✓ Saved' : 'Save'}
        </button>
        <button onClick={removeItem}
          className="rounded-lg border border-red-300 px-3 py-1.5 text-sm font-medium text-red-600 hover:bg-red-50">
          Delete item
        </button>
      </div>
      {delErr && <p className="text-xs text-red-600">{delErr}</p>}

      {/* Customizations */}
      <div className="border-t border-black/5 pt-3">
        <div className="mb-2 flex items-center justify-between">
          <p className="text-xs font-semibold text-black/60">Customizations</p>
          <button onClick={() => setShowNewGroup((v) => !v)}
            className="rounded-lg px-2.5 py-1 text-xs font-medium text-brand-charcoal ring-1 ring-brand-charcoal/40 hover:bg-brand-charcoal/5">
            ＋ Add customization
          </button>
        </div>

        {/* Reuse add-ons from another dish, then just edit prices. */}
        {sources.length > 0 && (
          <div className="mb-2 flex flex-wrap items-center gap-2 rounded-lg bg-brand-orange/[0.06] p-2.5">
            <span className="text-xs font-medium text-black/60">Copy add-ons from</span>
            <select className={inp + ' min-w-[10rem] flex-1'} value={copyFrom} onChange={(e) => { setCopyFrom(e.target.value); setCopyMsg(null); }}>
              <option value="">Choose a dish…</option>
              {sources.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
            <button onClick={copyAddons} disabled={!copyFrom || copyBusy}
              className="rounded-lg bg-brand-orange px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50">
              {copyBusy ? 'Copying…' : 'Copy'}
            </button>
          </div>
        )}
        {copyMsg && <p className="mb-2 text-xs text-green-700">{copyMsg}</p>}

        {showNewGroup && (
          <form onSubmit={addGroup} className="mb-3 space-y-2 rounded-lg bg-black/[0.02] p-3">
            <input className={inp + ' w-full'} placeholder="Customization name (e.g. Size, Temperature, Sugar level)"
              value={gName} onChange={(e) => setGName(e.target.value)} autoFocus />
            <div className="flex flex-wrap gap-4 text-xs">
              <label className="flex items-center gap-1.5"><input type="checkbox" checked={gRequired} onChange={(e) => setGRequired(e.target.checked)} /> Required</label>
              <label className="flex items-center gap-1.5"><input type="checkbox" checked={gMulti} onChange={(e) => setGMulti(e.target.checked)} /> Allow multiple choices</label>
            </div>
            <button className="rounded-lg bg-brand-charcoal px-3 py-1.5 text-xs font-semibold text-white">Create</button>
          </form>
        )}

        {groups.length === 0 && !showNewGroup && (
          <p className="text-xs text-black/40">No customizations. Add “Size”, “Sugar level”, “Hot or Cold”, etc.</p>
        )}

        <div className="space-y-3">
          {groups.map((g) => (
            <OptionGroupEditor key={g.id} group={g} base={base}
              options={options.filter((o) => o.group_id === g.id)} onChanged={onSaved} />
          ))}
        </div>
      </div>
    </div>
  );
}

/** One customization group: its header, its options, and an add-option form. */
function OptionGroupEditor({ group, base, options, onChanged }:
  { group: GroupRow; base: number; options: OptRow[]; onChanged: () => void }) {
  const [optName, setOptName] = useState('');
  const [optExtra, setOptExtra] = useState('');
  const [err, setErr] = useState<string | null>(null);

  async function addOption(e: React.FormEvent) {
    e.preventDefault();
    if (!supabase || !optName.trim()) return;
    setErr(null);
    try {
      await createMenuItemOption(supabase, {
        itemId: group.menu_item_id, groupId: group.id, groupName: group.name,
        optionName: optName.trim(), priceDelta: Number(optExtra) || 0,
      });
      setOptName(''); setOptExtra(''); onChanged();
    } catch (e2) { setErr(errMessage(e2)); }
  }
  async function removeOption(id: string) { if (supabase) { await deleteMenuItemOption(supabase, id); onChanged(); } }
  async function removeGroup() { if (supabase) { await deleteOptionGroup(supabase, group.id); onChanged(); } }

  return (
    <div className="rounded-lg bg-black/[0.02] p-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-sm font-medium">
          {group.name}
          <span className="ml-2 text-[11px] font-normal text-black/40">
            {group.required ? 'required' : 'optional'} · {group.multi_select ? 'pick many' : 'pick one'}
          </span>
        </span>
        <button onClick={removeGroup} className="text-xs text-red-600 hover:underline">Delete</button>
      </div>
      <div className="mb-2 flex flex-wrap gap-2">
        {options.map((o) => (
          <span key={o.id} className="inline-flex items-center gap-1 rounded-full bg-brand-charcoal/10 px-2.5 py-1 text-xs text-brand-charcoal">
            {o.option_name}
            {Number(o.price_delta) !== 0 && <span className="text-black/40">{Number(o.price_delta) > 0 ? '+' : ''}₱{Number(o.price_delta)}</span>}
            <button onClick={() => removeOption(o.id)} title="Remove" className="text-brand-charcoal/60 hover:text-red-600">×</button>
          </span>
        ))}
        {options.length === 0 && <span className="text-xs text-black/40">No choices yet.</span>}
      </div>
      <form onSubmit={addOption} className="flex flex-wrap gap-2">
        <input className={inp + ' w-36'} placeholder="Choice (e.g. Large, Hot)" value={optName} onChange={(e) => setOptName(e.target.value)} />
        <input className={inp + ' w-24'} type="number" placeholder="Extra ₱" value={optExtra} onChange={(e) => setOptExtra(e.target.value)} />
        <button className="rounded-lg bg-brand-charcoal/80 px-3 py-2 text-xs font-medium text-white">Add choice</button>
      </form>
      {err && <p className="mt-1 text-xs text-red-600">{err}</p>}
      {base >= 0 && options.length > 0 && Number(options[0]!.price_delta) !== 0 && (
        <p className="mt-1 text-[11px] text-black/40">Extra ₱ is added to the base price (₱{base.toFixed(2)}).</p>
      )}
    </div>
  );
}

/** Thumbnail + file picker that uploads an image and reports the new URL. */
function ImageUpload({ url, onUpload, rounded = 'rounded-lg', size = 'h-14 w-14' }:
  { url: string | null; onUpload: (file: File) => Promise<void>; rounded?: string; size?: string }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function pick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file || !supabase) return;
    setBusy(true); setErr(null);
    try { await onUpload(file); }
    catch (ex) { setErr(errMessage(ex)); }
    finally { setBusy(false); }
  }
  return (
    <div className="flex items-center gap-3">
      <div className={`flex ${size} shrink-0 items-center justify-center overflow-hidden ${rounded} bg-black/[0.04] ring-1 ring-black/10`}>
        {url ? <img src={url} alt="" className="h-full w-full object-cover" /> : <span className="text-lg text-black/25">🖼️</span>}
      </div>
      <label className="cursor-pointer rounded-lg px-3 py-1.5 text-xs font-medium text-brand-charcoal ring-1 ring-brand-charcoal/40 hover:bg-brand-charcoal/5">
        {busy ? 'Uploading…' : url ? 'Change' : 'Upload'}
        <input type="file" accept="image/*" className="hidden" onChange={pick} disabled={busy || !supabase} />
      </label>
      {err && <span className="text-xs text-red-600">{err}</span>}
    </div>
  );
}

const inp = 'rounded-lg border border-black/10 bg-white px-3 py-2 text-sm outline-none focus:border-brand-orange';
const Muted = ({ children }: { children: React.ReactNode }) =>
  <p className="rounded-xl bg-white p-6 text-sm text-black/50 shadow-sm ring-1 ring-black/5">{children}</p>;
const ErrorNote = ({ msg }: { msg: string }) =>
  <p className="rounded-xl bg-red-50 p-4 text-sm text-red-700 ring-1 ring-red-200">{msg}</p>;

/**
 * Copy this store's whole menu to another branch — categories, items, and
 * option groups. Useful when a chain opens a new branch with the same menu.
 */
function CopyMenuPanel({ store, stores }: { store: StoreRow; stores: StoreRow[] }) {
  const [target, setTarget] = useState('');
  const [replace, setReplace] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const others = stores.filter((x) => x.id !== store.id);

  async function copy() {
    if (!supabase || !target) return;
    const to = others.find((x) => x.id === target);
    const warn = replace
      ? `Replace ${to?.name}'s entire menu with ${store.name}'s? Existing items there will be deleted.`
      : `Copy ${store.name}'s menu into ${to?.name}?`;
    if (!window.confirm(warn)) return;
    setBusy(true); setMsg(null); setErr(null);
    try {
      const res = await copyStoreMenu(supabase, store.id, target, replace);
      setMsg(`Copied ${res.items} item(s) and ${res.categories} new category(ies) to ${to?.name}.`);
    } catch (e) { setErr(errMessage(e)); }
    finally { setBusy(false); }
  }

  return (
    <div className="border-t border-black/5 p-4">
      <h4 className="mb-2 text-sm font-semibold">Copy menu to another branch</h4>
      {others.length === 0 ? (
        <p className="text-xs text-black/40">Add another store first.</p>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <select value={target} onChange={(e) => { setTarget(e.target.value); setMsg(null); }}
              className="rounded-lg border border-black/10 px-3 py-1.5 text-sm">
              <option value="">Choose target branch…</option>
              {others.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
            </select>
            <label className="flex items-center gap-1.5 text-xs text-black/60">
              <input type="checkbox" checked={replace} onChange={(e) => setReplace(e.target.checked)} className="h-4 w-4" />
              Replace the target's existing menu
            </label>
            <button onClick={copy} disabled={busy || !target}
              className="rounded-lg bg-brand-orange px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50">
              {busy ? 'Copying…' : 'Copy menu'}
            </button>
          </div>
          <p className="mt-1 text-xs text-black/40">
            Copies categories, items, and their option groups. Without “replace”, items are added alongside what's already there.
          </p>
          {msg && <p className="mt-2 text-xs font-medium text-green-700">{msg}</p>}
          {err && <p className="mt-2 text-xs text-red-600">{err}</p>}
        </>
      )}
    </div>
  );
}
