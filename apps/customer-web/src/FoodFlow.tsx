import { useEffect, useMemo, useState } from 'react';
import {
  summarizeCart,
  distinctStoreCount,
  collectibleAtDoor,
  resolveDeliveryFee,
  lineUnitPrice,
  DEFAULT_DISTANCE_FEE_CONFIG,
  DEFAULT_FEE_CONFIG,
  MAX_STORES_PER_ORDER,
  isOpenNow,
  scheduleLabel,
  formatHm,
  type CartLine,
  type CartOption,
  type DeliveryFeeModel,
  type DistanceFeeConfig,
  type FeeConfig,
  errMessage,
} from '@servdgo/shared';
import { listAvailableStores, listMenu, buildFoodOrder, createFoodOrder, getAppSettings } from '@servdgo/supabase';
import { useRiderAvailability, NoRidersNotice, NO_RIDERS_MESSAGE } from './RiderAvailability.tsx';
import { AddressChooser, useSavedAddresses, useAreaBackfill } from './AddressChooser.tsx';
import { supabase, isSupabaseConfigured } from './lib/supabase.ts';
import { SAMPLE_STORES, type SampleStore } from './food/sampleData.ts';
import { peso, PaymentChoice, type PayChoice } from './ui.tsx';
import { LocationPicker, type LatLngValue } from './LocationPicker.tsx';
import { useDefaultAddress, useAddressPrefill, DeliveryAddressField } from './DeliveryAddress.tsx';
import { AreaPicker, kmBetween } from './AreaPicker.tsx';
import type { AreaSelection } from '@servdgo/supabase';
import { useAuth } from './auth/AuthContext.tsx';

const DELIVERY_FEE = 50;

interface Choice { name: string; priceDelta: number }
interface CustomGroup { id: string; name: string; required: boolean; multi: boolean; choices: Choice[] }
interface MenuItem { id: string; name: string; price: number; description?: string; image_url?: string | null; category_id: string | null; groups: CustomGroup[] }
interface Category { id: string; title: string }
interface Store { id: string; name: string; category: string; address?: string | null; items: MenuItem[]; categories: Category[]; lat: number | null; lng: number | null; logo_url?: string | null; opens_at?: string | null; closes_at?: string | null; open_days?: number[] | null; loaded: boolean }

/** Build the per-item customization groups from a listMenu() result. */
function buildStoreMenu(menu: Awaited<ReturnType<typeof listMenu>>): { categories: Category[]; items: MenuItem[] } {
  const allOpts = (menu.options ?? []) as { group_id: string | null; option_name: string; price_delta: number }[];
  const groupsByItem = new Map<string, CustomGroup[]>();
  for (const g of (menu.optionGroups ?? []) as { id: string; menu_item_id: string; name: string; required: boolean; multi_select: boolean }[]) {
    const choices = allOpts.filter((o) => o.group_id === g.id).map((o) => ({ name: o.option_name, priceDelta: Number(o.price_delta) }));
    const arr = groupsByItem.get(g.menu_item_id) ?? [];
    arr.push({ id: g.id, name: g.name, required: g.required, multi: g.multi_select, choices });
    groupsByItem.set(g.menu_item_id, arr);
  }
  return {
    categories: ((menu.categories ?? []) as { id: string; title: string }[]).map((c) => ({ id: c.id, title: c.title })),
    // `customer_price` already carries the operator's mark-up; the shelf price
    // behind it is the rider's business, not the customer's.
    items: (menu.items as unknown as { id: string; name: string; price: number; customer_price: number; description?: string; image_url?: string | null; category_id?: string | null }[])
      .map((it) => ({
        ...it,
        price: it.customer_price ?? it.price,
        category_id: it.category_id ?? null,
        groups: groupsByItem.get(it.id) ?? [],
      })),
  };
}

/** Unique cart key for an item + chosen size (different sizes are separate lines). */
const lineKey = (l: CartLine) => `${l.menuItemId ?? l.name}|${(l.options ?? []).map((o) => o.name).join(',')}`;

/** A friendly emoji for a cuisine/category label (used on chips and image fallbacks). */
function cuisineEmoji(cat: string): string {
  const c = cat.toLowerCase();
  if (/burger/.test(c)) return '🍔';
  if (/pizza/.test(c)) return '🍕';
  if (/chicken|fried/.test(c)) return '🍗';
  if (/coffee|caf[eé]|milk\s?tea|tea|drink|beverage/.test(c)) return '☕';
  if (/dessert|cake|sweet|bake|pastr/.test(c)) return '🧁';
  if (/seafood|fish/.test(c)) return '🦐';
  if (/steak|grill|bbq|barbe/.test(c)) return '🥩';
  if (/noodle|ramen|pancit|pasta/.test(c)) return '🍜';
  if (/rice|silog|meal|carinderia|lutong/.test(c)) return '🍚';
  if (/veg|salad|greens|healthy/.test(c)) return '🥗';
  if (/breakfast/.test(c)) return '🍳';
  return '🍽️';
}

interface FeeSettings {
  model: DeliveryFeeModel;
  flatFee: number;
  distance: DistanceFeeConfig;
  config: FeeConfig; // perStoreFee, commissionRate, convenienceFee
}
const DEFAULT_FEE_SETTINGS: FeeSettings = {
  model: 'flat', flatFee: DELIVERY_FEE, distance: DEFAULT_DISTANCE_FEE_CONFIG, config: DEFAULT_FEE_CONFIG,
};

export function FoodFlow() {
  const { ensureContact, mobile, name: savedName } = useAuth();
  const riders = useRiderAvailability('food');
  const [stores, setStores] = useState<Store[]>([]);
  const [loading, setLoading] = useState(true);
  const [openStoreId, setOpenStoreId] = useState<string | null>(null);
  const [customizingId, setCustomizingId] = useState<string | null>(null);
  const [menuCat, setMenuCat] = useState<string>(''); // '' = all categories
  const [menuSearch, setMenuSearch] = useState('');
  const [storeSearch, setStoreSearch] = useState(''); // filter the restaurant list
  const [cuisine, setCuisine] = useState<string>(''); // '' = all cuisines
  const [cart, setCart] = useState<CartLine[]>([]);
  const [pay, setPay] = useState<PayChoice | null>(null);
  const [createdId, setCreatedId] = useState<string | null>(null);
  const [placing, setPlacing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fees, setFees] = useState<FeeSettings>(DEFAULT_FEE_SETTINGS);
  const [dropoff, setDropoff] = useState<LatLngValue | null>(null);
  const [contact, setContact] = useState('');
  const [custName, setCustName] = useState('');
  // Prefill from the profile once it loads, so returning customers don't retype it.
  useEffect(() => { if (savedName && !custName) setCustName(savedName); }, [savedName]);  // eslint-disable-line react-hooks/exhaustive-deps
  const [note, setNote] = useState('');
  const [gift, setGift] = useState(false);
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
    if (a.contact_phone?.trim()) setContact(a.contact_phone.trim());
  }
  // Clearing the pin matters: "somewhere else" used to open on the address they
  // had just moved away from, and an order sent without touching the map went
  // to that old spot.
  function pinManually() {
    setChosenAddressId(null);
    setDropoff(null); setAddressText('');
  }
  useEffect(() => {
    if (!saved.loaded || chosenAddressId || saved.addresses.length === 0 || gift) return;
    chooseAddress(saved.addresses[0]!);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saved.loaded, gift]);
  const [recipientName, setRecipientName] = useState('');
  const [addressText, setAddressText] = useState('');
  const { address: savedAddress, loaded: addressLoaded } = useDefaultAddress();
  useAddressPrefill({
    address: savedAddress, loaded: addressLoaded, dropoff, text: addressText,
    setDropoff, setText: setAddressText,
  });
  const [recipientContact, setRecipientContact] = useState('');
  const [cutlery, setCutlery] = useState(false);
  const [area, setArea] = useState<AreaSelection | null>(null);
  const [areaRequired, setAreaRequired] = useState(false);
  const [serviceArea, setServiceArea] = useState<{ lat: number; lng: number; radiusKm: number } | null>(null);
  const [cartOpen, setCartOpen] = useState(false); // full-screen cart popup
  // Prefill the delivery contact with the account's verified phone.
  useEffect(() => { if (mobile && !contact) setContact(mobile); }, [mobile]);

  useEffect(() => {
    (async () => {
      try {
        if (supabase && isSupabaseConfigured) {
          const [rows, settings] = await Promise.all([
            listAvailableStores(supabase),
            getAppSettings(supabase).catch(() => null),
          ]);
          if (settings) {
            setFees({
              model: settings.delivery_fee_model,
              flatFee: settings.default_delivery_fee,
              distance: {
                baseFare: settings.delivery_base_fare,
                baseKm: settings.delivery_base_km,
                perKm: settings.delivery_per_km,
              },
              config: {
                perStoreFee: settings.per_store_fee,
                commissionRate: settings.commission_rate,
                convenienceFee: settings.convenience_fee_food ?? settings.convenience_fee,
              },
            });
            if (settings.service_center_lat != null && settings.service_center_lng != null
                && Number(settings.service_radius_km) > 0) {
              setServiceArea({
                lat: settings.service_center_lat, lng: settings.service_center_lng,
                radiusKm: Number(settings.service_radius_km),
              });
            }
          }
          // Only the store list up front — each menu loads lazily when opened.
          setStores((rows as { id: string; name: string; category: string | null; address: string | null; lat: number | null; lng: number | null; logo_url: string | null; opens_at: string | null; closes_at: string | null; open_days: number[] | null }[])
            .map((s) => ({
              id: s.id, name: s.name, category: s.category ?? '', address: s.address,
              lat: s.lat, lng: s.lng, logo_url: s.logo_url,
              opens_at: s.opens_at, closes_at: s.closes_at, open_days: s.open_days,
              categories: [], items: [], loaded: false,
            })));
        } else {
          setStores((SAMPLE_STORES as SampleStore[]).map((s) => ({
            ...s, lat: null, lng: null, categories: [], loaded: true,
            items: s.items.map((it) => ({ ...it, category_id: null, groups: [] })),
          })));
        }
      } catch (e) {
        setError(errMessage(e));
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  // Distinct store locations touched by the cart, for the distance-based fee.
  const cartStoreLocations = useMemo(() => {
    const ids = new Set(cart.map((l) => l.storeId));
    return stores.filter((s) => ids.has(s.id)).map((s) => ({ lat: s.lat, lng: s.lng }));
  }, [cart, stores]);

  const deliveryFee = useMemo(() => resolveDeliveryFee({
    model: fees.model, flatFee: fees.flatFee, distanceConfig: fees.distance,
    storeLocations: cartStoreLocations.map((s) => (s.lat != null && s.lng != null ? { lat: s.lat, lng: s.lng } : null)),
    dropoff,
  }), [fees, cartStoreLocations, dropoff]);

  const summary = useMemo(() => summarizeCart(cart, deliveryFee, fees.config), [cart, deliveryFee, fees.config]);
  const storeCount = distinctStoreCount(cart);
  const cartCount = cart.reduce((n, l) => n + l.qty, 0);
  const openStore = stores.find((s) => s.id === openStoreId) ?? null;
  // Under per-km pricing we need the drop-off pin before we can price/checkout.
  // A drop-off pin is required for distance pricing, and for gift orders so the
  // rider knows where to deliver to the recipient.
  // Every order needs somewhere to go, whatever the fee model says.
  const needsDropoff = !dropoff;
  const needsAddress = addressText.trim().length < 5;
  useAreaBackfill({ addresses: saved.addresses, chosenId: chosenAddressId, area, reload: saved.reload });

  // Reset menu filters whenever the open restaurant changes.
  useEffect(() => { setMenuCat(''); setMenuSearch(''); setCustomizingId(null); }, [openStoreId]);

  // Lazily load a restaurant's menu the first time it's opened.
  const [menuLoading, setMenuLoading] = useState(false);
  useEffect(() => {
    if (!openStoreId || !supabase || !isSupabaseConfigured) return;
    const s = stores.find((x) => x.id === openStoreId);
    if (!s || s.loaded) return;
    let cancelled = false;
    setMenuLoading(true);
    listMenu(supabase, openStoreId)
      .then((menu) => {
        if (cancelled) return;
        const built = buildStoreMenu(menu);
        setStores((prev) => prev.map((x) => x.id === openStoreId ? { ...x, ...built, loaded: true } : x));
      })
      .catch((e) => !cancelled && setError(errMessage(e)))
      .finally(() => !cancelled && setMenuLoading(false));
    return () => { cancelled = true; };
  }, [openStoreId, stores]);

  // Distinct cuisines across all stores, for the category chip row.
  const cuisines = useMemo(() => {
    const set = new Set<string>();
    for (const s of stores) if (s.category.trim()) set.add(s.category.trim());
    return [...set].sort();
  }, [stores]);

  // Restaurants filtered by search box (name or category) + selected cuisine
  // chip, with currently-open stores sorted ahead of closed ones.
  const shownStores = stores.filter((s) => {
    if (cuisine && s.category.trim() !== cuisine) return false;
    const q = storeSearch.trim().toLowerCase();
    if (!q) return true;
    return s.name.toLowerCase().includes(q) || s.category.toLowerCase().includes(q);
  }).sort((a, b) => Number(isOpenNow(b.opens_at, b.closes_at, b.open_days)) - Number(isOpenNow(a.opens_at, a.closes_at, a.open_days)));

  // Menu items filtered by the selected category + search box.
  const menuItems = (openStore?.items ?? []).filter((it) => {
    if (menuCat && it.category_id !== menuCat) return false;
    if (menuSearch.trim() && !it.name.toLowerCase().includes(menuSearch.trim().toLowerCase())) return false;
    return true;
  });
  const customizingItem = (openStore?.items ?? []).find((it) => it.id === customizingId) ?? null;

  // Cart grouped by store (one order → one rider visits each store).
  const cartByStore = useMemo(() => {
    const map = new Map<string, { name: string; lines: CartLine[] }>();
    for (const l of cart) {
      if (!map.has(l.storeId)) map.set(l.storeId, { name: stores.find((s) => s.id === l.storeId)?.name ?? 'Store', lines: [] });
      map.get(l.storeId)!.lines.push(l);
    }
    return [...map.values()];
  }, [cart, stores]);
  const canAddStore = storeCount < MAX_STORES_PER_ORDER;

  function addToCart(store: Store, item: MenuItem, options?: CartOption[]) {
    setError(null);
    const opts = options && options.length ? options : undefined;
    const newLine: CartLine = {
      storeId: store.id, menuItemId: item.id,
      name: opts ? `${item.name} — ${opts.map((o) => o.name).join(', ')}` : item.name,
      unitPrice: item.price, qty: 1, options: opts,
    };
    const key = lineKey(newLine);
    const existing = cart.find((l) => lineKey(l) === key);
    const next = existing
      ? cart.map((l) => (lineKey(l) === key ? { ...l, qty: l.qty + 1 } : l))
      : [...cart, newLine];
    if (new Set(next.map((l) => l.storeId)).size > MAX_STORES_PER_ORDER) {
      setError(`An order can span at most ${MAX_STORES_PER_ORDER} stores.`);
      return;
    }
    setCart(next);
  }

  function changeQty(key: string, delta: number) {
    setCart((c) =>
      c.map((l) => (lineKey(l) === key ? { ...l, qty: l.qty + delta } : l))
        .filter((l) => l.qty > 0),
    );
  }

  async function checkout() {
    if (placing) return; // guard against double/triple taps creating duplicate orders
    setError(null);
    if (needsDropoff) { setError('Please pin your delivery location first.'); return; }
    if (needsAddress) {
      setError('Please give your complete delivery address — the pin gets your rider to the street, the address gets them to your door.');
      return;
    }
    if (custName.trim().length < 2) { setError('Please enter your name so the rider knows who to hand the order to.'); return; }
    if (!contact.trim()) { setError('Please enter your mobile number so the rider can reach you.'); return; }
    if (!pay) { setError('Please choose a payment method.'); return; }
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
    const fullNote = [cutlery ? '🍴 Include cutlery' : '', note.trim()].filter(Boolean).join(' — ') || undefined;
    setPlacing(true);
    try {
      // Riders come and go while a basket is being filled — ask again now.
      if (await riders.recheck() === 0) { setError(NO_RIDERS_MESSAGE); return; }
      if (supabase && isSupabaseConfigured) {
        const customerId = await ensureContact(contact.trim(), custName.trim() || undefined);
        setCreatedId(await createFoodOrder(supabase, {
          customerId,
          customerContact: contact.trim(),
          customerName: custName.trim() || undefined,
          areaProvince: area?.province,
          areaCity: area?.city,
          areaBarangay: area?.barangay,
          recipientName: gift ? recipientName.trim() || undefined : undefined,
          deliveryAddress: addressText,
          recipientContact: gift ? recipientContact.trim() || undefined : undefined,
          deliveryFee,
          lines: cart,
          notes: fullNote,
          deliveryLat: dropoff?.lat,
          deliveryLng: dropoff?.lng,
          paymentMethod: pay,
          // No order arrives paid. "Pay online" used to set this true without a
          // gateway behind it, so orders were marked settled while no money had
          // moved. It is paid when someone actually hands it over.
          paid: false,
        }, fees.config));
      } else {
        buildFoodOrder({
          customerId: 'preview-customer', customerContact: contact.trim() || '09171234567',
          deliveryFee, lines: cart, paymentMethod: pay, paid: false,
        }, fees.config);
        setCreatedId('preview-only');
      }
    } catch (e) {
      setError(errMessage(e));
    } finally {
      setPlacing(false);
    }
  }

  if (loading) return <p className="text-sm text-black/50">Loading stores…</p>;

  if (createdId) {
    return (
      <div className="rounded-2xl bg-white p-6 text-center shadow-sm ring-1 ring-black/5">
        <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-brand-orange/15 text-2xl">✓</div>
        <h2 className="text-lg font-bold">Order placed</h2>
        <p className="mt-1 text-sm text-black/60">
          {createdId === 'preview-only' ? 'Preview only — connect Supabase to notify riders.' : 'Riders have been notified.'}
        </p>
        <p className="mt-2 font-mono text-xs text-black/40">{createdId}</p>
        <button onClick={() => { setCart([]); setCreatedId(null); setOpenStoreId(null); setDropoff(null); setContact(''); setCustName(''); setNote(''); setCutlery(false); setGift(false); setRecipientName(''); setAddressText(''); setRecipientContact(''); setPay(null); setCartOpen(false); }}
          className="mt-5 rounded-lg border border-brand-charcoal px-4 py-2 text-sm font-medium text-brand-charcoal hover:bg-brand-charcoal/5">
          Order again
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

      {openStore ? (
        <StoreDetail
          store={openStore}
          fees={fees}
          menuLoading={menuLoading}
          menuItems={menuItems}
          menuCat={menuCat} setMenuCat={setMenuCat}
          menuSearch={menuSearch} setMenuSearch={setMenuSearch}
          onBack={() => setOpenStoreId(null)}
          onAdd={(it) => addToCart(openStore, it)}
          onCustomize={(id) => setCustomizingId(id)}
        />
      ) : (
        <section className="space-y-4">
          {/* Promo hero */}
          <div className="relative overflow-hidden rounded-3xl bg-gradient-to-br from-brand-orange to-[#c4451f] p-5 text-white shadow-md">
            <div className="absolute -right-6 -top-8 h-32 w-32 rounded-full bg-white/25 blur-2xl" />
            <p className="text-xs font-semibold uppercase tracking-wide text-white/80">ServdGo</p>
            <h2 className="mt-1 max-w-[15rem] text-2xl font-black leading-tight">Your favorite local spots, delivered</h2>
            <p className="mt-1 text-sm text-white/85">Food, Pabili &amp; Padala — one rider, one order.</p>
          </div>

          {/* Search */}
          <div className="flex items-center gap-2 rounded-2xl bg-white px-4 py-3 shadow-sm ring-1 ring-black/5">
            <SearchIcon />
            <input value={storeSearch} onChange={(e) => setStoreSearch(e.target.value)}
              placeholder="Search by name & restaurant"
              className="w-full bg-transparent text-sm outline-none placeholder-black/40" />
            {storeSearch && (
              <button onClick={() => setStoreSearch('')} className="text-black/30 hover:text-black/60">✕</button>
            )}
          </div>

          {cart.length > 0 && (
            <p className="rounded-xl bg-brand-orange/10 px-3 py-2 text-xs text-green-800">
              Pick another store to add to your order — one rider will buy from all of them.
            </p>
          )}

          {/* Cuisine chips */}
          {cuisines.length > 0 && (
            <div className="-mx-1 flex gap-3 overflow-x-auto px-1 pb-1">
              <CuisineChip emoji="🍽️" label="All" active={cuisine === ''} onClick={() => setCuisine('')} />
              {cuisines.map((c) => (
                <CuisineChip key={c} emoji={cuisineEmoji(c)} label={c} active={cuisine === c} onClick={() => setCuisine(cuisine === c ? '' : c)} />
              ))}
            </div>
          )}

          {/* Restaurants */}
          <div className="flex items-center justify-between">
            <h3 className="text-lg font-extrabold">{cuisine || 'Popular Restaurants'}</h3>
            <span className="text-xs text-black/40">{shownStores.length} places</span>
          </div>

          <div className="space-y-4">
            {shownStores.map((s) => {
              const open = isOpenNow(s.opens_at, s.closes_at, s.open_days);
              return (
              <button key={s.id} onClick={() => open && setOpenStoreId(s.id)} disabled={!open}
                className={`block w-full overflow-hidden rounded-2xl bg-white text-left shadow-sm ring-1 ring-black/5 transition ${open ? 'hover:shadow-md' : 'cursor-not-allowed'}`}>
                <div className="relative h-36 w-full">
                  {s.logo_url ? (
                    <img src={s.logo_url} alt="" className={`h-full w-full object-cover ${open ? '' : 'grayscale'}`} />
                  ) : (
                    <div className={`flex h-full w-full items-center justify-center bg-gradient-to-br from-brand-orange/15 to-brand-orange/5 text-5xl ${open ? '' : 'grayscale'}`}>
                      {cuisineEmoji(s.category)}
                    </div>
                  )}
                  {!open && <div className="absolute inset-0 bg-white/50" />}
                  {open ? (
                    <span className="absolute left-3 top-3 rounded-full bg-brand-orange px-2.5 py-1 text-[11px] font-bold text-white shadow">● Open now</span>
                  ) : (
                    <span className="absolute left-3 top-3 rounded-full bg-black/70 px-2.5 py-1 text-[11px] font-bold text-white shadow">
                      {!isOpenNow(null, null, s.open_days) ? 'Closed today'
                        : s.opens_at ? `Closed · opens ${formatHm(s.opens_at)}` : 'Closed'}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-3 p-3.5">
                  <span className="flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-full bg-white text-lg shadow ring-1 ring-black/5">
                    {s.logo_url ? <img src={s.logo_url} alt="" className={`h-full w-full object-cover ${open ? '' : 'grayscale'}`} /> : cuisineEmoji(s.category)}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className={`block truncate font-bold ${open ? '' : 'text-black/50'}`}>{s.name}</span>
                    <span className="text-xs text-black/50">
                      {s.category || 'Restaurant'}
                      {(s.opens_at || s.closes_at || (s.open_days && s.open_days.length < 7)) &&
                        <span className="text-black/35"> · {scheduleLabel(s.opens_at, s.closes_at, s.open_days)}</span>}
                    </span>
                    {s.address && <span className="block truncate text-xs text-black/40">📍 {s.address}</span>}
                  </span>
                  <span className={open ? 'text-brand-charcoal' : 'text-black/25'}>→</span>
                </div>
              </button>
            ); })}
            {shownStores.length === 0 && (
              <p className="rounded-2xl bg-white p-6 text-center text-sm text-black/40 shadow-sm ring-1 ring-black/5">
                {storeSearch ? `No restaurants match “${storeSearch}”.`
                  : cuisine ? `No ${cuisine} restaurants yet.` : 'No restaurants available yet.'}
              </p>
            )}
          </div>
        </section>
      )}

      {/* Customizer bottom-sheet */}
      {openStore && customizingItem && (
        <div className="fixed inset-0 z-50 flex flex-col justify-end bg-black/40 sm:items-center sm:justify-center sm:p-4" onClick={() => setCustomizingId(null)}>
          <div className="max-h-[85vh] w-full overflow-y-auto rounded-t-3xl bg-white sm:max-w-md sm:rounded-3xl" onClick={(e) => e.stopPropagation()}>
            <div className="relative h-40 w-full">
              {customizingItem.image_url
                ? <img src={customizingItem.image_url} alt="" className="h-full w-full object-cover" />
                : <div className="flex h-full w-full items-center justify-center bg-black/[0.04] text-5xl">🍽️</div>}
              <button onClick={() => setCustomizingId(null)} aria-label="Close"
                className="absolute right-3 top-3 flex h-9 w-9 items-center justify-center rounded-full bg-white/90 text-lg text-black/60 shadow">✕</button>
            </div>
            <div className="p-4">
              <h3 className="text-lg font-extrabold">{customizingItem.name}</h3>
              {customizingItem.description && <p className="mt-0.5 text-sm text-black/50">{customizingItem.description}</p>}
              <Customizer item={customizingItem} onAdd={(options) => { addToCart(openStore, customizingItem, options); setCustomizingId(null); }} />
            </div>
          </div>
        </div>
      )}

      {/* Cart popup — full-screen on phones, a centered app-width panel on desktop */}
      {cartOpen && cart.length > 0 && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 sm:p-4"
          onClick={() => setCartOpen(false)}>
          <div className="flex h-full w-full max-w-xl flex-col overflow-hidden bg-[#f7f5f3] shadow-2xl sm:h-auto sm:max-h-[calc(100vh-2rem)] sm:rounded-2xl"
            onClick={(e) => e.stopPropagation()}>
          <header className="flex items-center justify-between border-b border-black/10 bg-white px-4 py-3">
            <h3 className="font-bold">Your cart {storeCount > 1 && <span className="text-xs font-normal text-black/50">· {storeCount} stores</span>}</h3>
            <button onClick={() => setCartOpen(false)} aria-label="Close cart"
              className="flex h-9 w-9 items-center justify-center rounded-full bg-black/5 text-lg text-black/60 hover:bg-black/10">✕</button>
          </header>

          <div className="min-h-0 flex-1 overflow-y-auto p-4">
            {/* Items grouped by store — one order, one rider visits each store. */}
            <div className="mb-3 space-y-3 rounded-2xl bg-white p-4 shadow-sm ring-1 ring-black/5">
              {cartByStore.map((grp) => (
                <div key={grp.name}>
                  {storeCount > 1 && <p className="mb-1 text-xs font-semibold text-brand-charcoal">🏪 {grp.name}</p>}
                  <ul className="divide-y divide-black/5">
                    {grp.lines.map((l) => (
                      <li key={lineKey(l)} className="flex items-center justify-between py-2 text-sm">
                        <span>{l.name}</span>
                        <span className="flex items-center gap-2">
                          <button onClick={() => changeQty(lineKey(l), -1)} className="h-6 w-6 rounded bg-black/5">−</button>
                          <span className="w-4 text-center">{l.qty}</span>
                          <button onClick={() => changeQty(lineKey(l), +1)} className="h-6 w-6 rounded bg-black/5">+</button>
                          <span className="w-16 text-right font-medium">{peso(lineUnitPrice(l) * l.qty)}</span>
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
              {canAddStore ? (
                <button onClick={() => { setCartOpen(false); setOpenStoreId(null); window.scrollTo({ top: 0 }); }}
                  className="w-full rounded-lg border border-dashed border-brand-charcoal/50 py-2.5 text-sm font-semibold text-brand-charcoal hover:bg-brand-charcoal/5">
                  ＋ Add items from another store
                </button>
              ) : (
                <p className="text-center text-xs text-black/40">Up to {MAX_STORES_PER_ORDER} stores per order.</p>
              )}
              {storeCount > 1 && (
                <p className="rounded-lg bg-brand-charcoal/5 px-3 py-2 text-xs text-brand-charcoal">
                  One rider will buy from all {storeCount} stores. The delivery fee is charged for the farthest store only.
                </p>
              )}
            </div>

            <div className="mb-3 space-y-3 rounded-2xl bg-white p-4 shadow-sm ring-1 ring-black/5">
              {/* A gift goes to the recipient's place, which is nobody's saved
                  address — that branch keeps its own pin further down. */}
              {fees.model === 'per_km' && gift && (
                <div>
                  <label className="mb-1 block text-sm font-medium">📍 Recipient's delivery location</label>
                  <LocationPicker value={dropoff} onChange={setDropoff} label="Pin the drop-off" />
                  <div className="mt-2">
                    <DeliveryAddressField value={addressText} onChange={setAddressText} saved={savedAddress} />
                  </div>
                </div>
              )}
              {!gift && (
                <AddressChooser
                  addresses={saved.addresses} loaded={saved.loaded}
                  value={chosenAddressId} onChoose={chooseAddress} onCustom={pinManually}
                  custom={
                    <div className="space-y-3">
                      <LocationPicker value={dropoff} onChange={setDropoff} label="Pin the drop-off" />
                      <DeliveryAddressField value={addressText} onChange={setAddressText} saved={savedAddress} />
                      <p className="text-xs text-black/40">
                        After it arrives we'll offer to save this address for next time.
                      </p>
                    </div>
                  } />
              )}
              <AreaPicker value={area} onChange={setArea} onRequired={setAreaRequired} />
              <div>
                <label className="mb-1 block text-sm font-medium">Your name <span className="text-red-500">*</span></label>
                <input value={custName} onChange={(e) => setCustName(e.target.value)}
                  placeholder="Juan Dela Cruz"
                  className="w-full rounded-lg border border-black/10 bg-white px-3 py-2 text-sm outline-none focus:border-brand-orange" />
                <p className="mt-1 text-xs text-black/40">So the rider knows who to hand the order to.</p>
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium">Your mobile number <span className="text-red-500">*</span></label>
                <input value={contact} onChange={(e) => setContact(e.target.value)}
                  inputMode="tel" placeholder="0917 123 4567"
                  className="w-full rounded-lg border border-black/10 bg-white px-3 py-2 text-sm outline-none focus:border-brand-orange" />
                <p className="mt-1 text-xs text-black/40">So the rider can reach you.</p>
              </div>
              <label className="flex items-center gap-2 text-sm font-medium">
                <input type="checkbox" checked={gift} onChange={(e) => setGift(e.target.checked)} className="h-4 w-4 accent-[#E8552F]" />
                🎁 Deliver to someone else
              </label>
              {gift && (
                <div className="space-y-3 rounded-xl bg-black/[0.03] p-3">
                  <div>
                    <label className="mb-1 block text-sm font-medium">
                      Recipient&apos;s complete name <span className="text-red-600">*</span>
                    </label>
                    <input value={recipientName} onChange={(e) => setRecipientName(e.target.value)}
                      placeholder="Juan Dela Cruz"
                      className="w-full rounded-lg border border-black/10 bg-white px-3 py-2 text-sm outline-none focus:border-brand-orange" />
                    <p className="mt-1 text-xs text-black/45">
                      Full name, so your rider can ask for them if the call isn&apos;t answered.
                    </p>
                  </div>
                  <div>
                    <label className="mb-1 block text-sm font-medium">Recipient mobile number</label>
                    <input value={recipientContact} onChange={(e) => setRecipientContact(e.target.value)}
                      inputMode="tel" placeholder="0917 123 4567"
                      className="w-full rounded-lg border border-black/10 bg-white px-3 py-2 text-sm outline-none focus:border-brand-orange" />
                  </div>
                  {/* Pin the recipient's location. Under distance pricing the top map
                      already captures this drop-off, so only add one here otherwise. */}
                  {fees.model !== 'per_km' && (
                    <div>
                      <label className="mb-1 block text-sm font-medium">📍 Recipient's delivery location</label>
                      <LocationPicker value={dropoff} onChange={setDropoff} label="Pin the drop-off" />
                      <div className="mt-2">
                        <DeliveryAddressField value={addressText} onChange={setAddressText} saved={savedAddress} />
                      </div>
                      <p className="mt-1 text-xs text-black/40">Tap or drag the pin to where the order should be delivered.</p>
                    </div>
                  )}
                  <p className="text-xs text-black/50">The rider delivers to the recipient. You (the sender) still pay — use <b>GCash to rider</b> below and pay from your Orders once a rider accepts.</p>
                </div>
              )}
              <label className="flex items-center gap-2 text-sm font-medium">
                <input type="checkbox" checked={cutlery} onChange={(e) => setCutlery(e.target.checked)} className="h-4 w-4 accent-[#E8552F]" />
                🍴 Include cutlery
              </label>
              <div>
                <label className="mb-1 block text-sm font-medium">Note to the rider <span className="font-normal text-black/40">(optional)</span></label>
                <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2}
                  placeholder="e.g. Extra spicy, leave at the gate, call when outside…"
                  className="w-full rounded-lg border border-black/10 bg-white px-3 py-2 text-sm outline-none focus:border-brand-orange" />
              </div>
            </div>

            <div className="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-black/5">
              <Row label="Goods" value={peso(summary.goodsCost)} />
              <Row label={fees.model === 'per_km' ? 'Delivery fee (by distance)' : 'Delivery fee'}
                value={needsDropoff ? '—' : peso(summary.deliveryFee)} />
              {summary.storeFeeTotal > 0 && <Row label={`Store fee (${storeCount - 1} added)`} value={peso(summary.storeFeeTotal)} />}
              {summary.convenienceFee > 0 && <Row label="Convenience fee" value={peso(summary.convenienceFee)} />}
              <div className="mt-1 flex justify-between border-t border-black/5 pt-2 text-sm font-bold">
                <span>Total</span><span>{needsDropoff ? '—' : peso(summary.customerTotal)}</span>
              </div>
              {pay === 'online' && !needsDropoff && (
                <div className="mt-1 flex justify-between text-xs text-black/50">
                  <span>Pay the rider at the door</span><span>{peso(collectibleAtDoor(summary, 'online'))}</span>
                </div>
              )}
              {pay === 'rider_qr' && !needsDropoff && (
                <div className="mt-1 flex justify-between text-xs text-black/50">
                  <span>Scan rider's GCash QR on delivery</span><span>{peso(summary.customerTotal)}</span>
                </div>
              )}
              <div className="mt-3"><PaymentChoice value={pay} onChange={setPay} /></div>
            </div>
          </div>

          <div className="border-t border-black/10 bg-white p-4">
            <NoRidersNotice availability={riders} />
            {error && <p className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
            <button onClick={checkout} disabled={placing || needsDropoff || needsAddress || custName.trim().length < 2 || !contact.trim() || !pay || (areaRequired && !area)}
              className="w-full rounded-xl bg-brand-orange py-3 font-semibold text-white transition hover:brightness-95 disabled:opacity-50">
              {placing ? 'Placing your order…'
                : areaRequired && !area ? 'Choose your delivery area'
                : needsDropoff ? 'Pin your delivery location'
                : needsAddress ? 'Add your complete delivery address'
                : custName.trim().length < 2 ? 'Enter your name'
                : !contact.trim() ? 'Enter your mobile number'
                : !pay ? 'Choose a payment method'
                : pay === 'online' ? `Place order (pay at door) · ${peso(summary.customerTotal)}`
                : pay === 'rider_qr' ? `Place order (GCash to rider) · ${peso(summary.customerTotal)}`
                : `Place order (COD) · ${peso(summary.customerTotal)}`}
            </button>
          </div>
          </div>
        </div>
      )}

      {/* Floating cart button (sits above the bottom tab bar) */}
      {cart.length > 0 && !cartOpen && !customizingItem && (
        <button onClick={() => setCartOpen(true)}
          className="fixed bottom-24 right-5 z-40 flex items-center gap-2 rounded-full bg-brand-orange px-4 py-3 text-white shadow-lg ring-2 ring-white transition hover:brightness-95">
          <span className="relative">
            <CartIcon />
            <span className="absolute -right-2 -top-2 flex h-5 min-w-[1.25rem] items-center justify-center rounded-full bg-brand-charcoal px-1 text-[11px] font-bold">
              {cartCount}
            </span>
          </span>
          {!needsDropoff && <span className="text-sm font-bold">{peso(summary.customerTotal)}</span>}
        </button>
      )}
    </div>
  );
}

/** Restaurant detail: hero, info card, category tabs, 2-column menu grid. */
function StoreDetail({ store, fees, menuLoading, menuItems, menuCat, setMenuCat, menuSearch, setMenuSearch, onBack, onAdd, onCustomize }: {
  store: Store;
  fees: FeeSettings;
  menuLoading: boolean;
  menuItems: MenuItem[];
  menuCat: string; setMenuCat: (c: string) => void;
  menuSearch: string; setMenuSearch: (s: string) => void;
  onBack: () => void;
  onAdd: (it: MenuItem) => void;
  onCustomize: (id: string) => void;
}) {
  return (
    <section className="space-y-4">
      {/* Hero */}
      <div className="relative -mx-5 -mt-4">
        <div className="h-44 w-full overflow-hidden">
          {store.logo_url
            ? <img src={store.logo_url} alt="" className="h-full w-full object-cover" />
            : <div className="flex h-full w-full items-center justify-center bg-gradient-to-br from-brand-orange to-[#c4451f] text-6xl">{cuisineEmoji(store.category)}</div>}
        </div>
        <div className="absolute inset-x-0 top-0 flex items-center justify-between p-4">
          <button onClick={onBack} aria-label="Back"
            className="flex h-10 w-10 items-center justify-center rounded-full bg-white/90 text-lg text-black/70 shadow">←</button>
        </div>
        {/* Overlapping logo + title card */}
        <div className="relative mx-5 -mt-10 rounded-2xl bg-white p-4 shadow-sm ring-1 ring-black/5">
          <div className="flex items-center gap-3">
            <span className="flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-2xl bg-white text-2xl shadow ring-1 ring-black/5">
              {store.logo_url ? <img src={store.logo_url} alt="" className="h-full w-full object-cover" /> : cuisineEmoji(store.category)}
            </span>
            <div className="min-w-0">
              <h2 className="truncate text-xl font-black">{store.name}</h2>
              <p className="text-sm text-black/50">
                {store.category || 'Restaurant'} · {isOpenNow(store.opens_at, store.closes_at, store.open_days)
                  ? <span className="font-semibold text-brand-orange">Open now</span>
                  : <span className="font-semibold text-black/50">Closed</span>}
              </p>
              {(store.opens_at || store.closes_at || (store.open_days && store.open_days.length < 7)) && (
                <p className="text-xs text-black/40">🕒 {scheduleLabel(store.opens_at, store.closes_at, store.open_days)}</p>
              )}
              {store.address && (
                store.lat != null && store.lng != null ? (
                  <a href={`https://www.google.com/maps/search/?api=1&query=${store.lat},${store.lng}`}
                    target="_blank" rel="noreferrer"
                    className="mt-0.5 block text-xs text-brand-charcoal underline">📍 {store.address}</a>
                ) : <p className="mt-0.5 text-xs text-black/40">📍 {store.address}</p>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Search this menu */}
      <div className="flex items-center gap-2 rounded-2xl bg-white px-4 py-3 shadow-sm ring-1 ring-black/5">
        <SearchIcon />
        <input value={menuSearch} onChange={(e) => setMenuSearch(e.target.value)}
          placeholder="Search this menu"
          className="w-full bg-transparent text-sm outline-none placeholder-black/40" />
      </div>

      {/* Category tabs */}
      {store.categories.length > 0 && (
        <div className="-mx-1 flex gap-4 overflow-x-auto border-b border-black/10 px-1">
          <CatTab active={menuCat === ''} onClick={() => setMenuCat('')}>Popular</CatTab>
          {store.categories.map((c) => (
            <CatTab key={c.id} active={menuCat === c.id} onClick={() => setMenuCat(c.id)}>{c.title}</CatTab>
          ))}
        </div>
      )}

      {/* Menu grid */}
      <div className="grid grid-cols-2 gap-3">
        {menuItems.map((it) => (
          <div key={it.id} className="flex flex-col overflow-hidden rounded-2xl bg-white shadow-sm ring-1 ring-black/5">
            <div className="relative">
              <div className="aspect-[4/3] w-full overflow-hidden bg-black/[0.04]">
                {it.image_url
                  ? <img src={it.image_url} alt="" className="h-full w-full object-cover" />
                  : <div className="flex h-full w-full items-center justify-center text-4xl">🍽️</div>}
              </div>
              <button
                onClick={() => (it.groups.length === 0 ? onAdd(it) : onCustomize(it.id))}
                aria-label={it.groups.length === 0 ? `Add ${it.name}` : `Customize ${it.name}`}
                className="absolute -bottom-3 right-2 flex h-9 w-9 items-center justify-center rounded-full bg-brand-orange text-lg font-bold text-white shadow-md ring-2 ring-white transition hover:brightness-95">
                +
              </button>
            </div>
            <div className="flex flex-1 flex-col p-3 pt-4">
              <p className="text-sm font-semibold leading-tight">{it.name}</p>
              {it.description && <p className="mt-0.5 line-clamp-2 text-xs text-black/45">{it.description}</p>}
              <div className="mt-auto flex items-baseline gap-1 pt-2">
                <span className="font-bold text-brand-ink">{peso(it.price)}</span>
                {it.groups.length > 0 && <span className="text-[11px] text-black/40">+ options</span>}
              </div>
            </div>
          </div>
        ))}
      </div>
      {menuItems.length === 0 && (
        <p className="rounded-2xl bg-white p-6 text-center text-sm text-black/40 shadow-sm ring-1 ring-black/5">
          {!store.loaded || menuLoading ? 'Loading menu…'
            : menuSearch || menuCat ? 'No items match your filter.' : 'No items on this menu yet.'}
        </p>
      )}
    </section>
  );
}

function CartIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
      strokeLinecap="round" strokeLinejoin="round">
      <circle cx="9" cy="21" r="1" /><circle cx="20" cy="21" r="1" />
      <path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6" />
    </svg>
  );
}

function BikeIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
      strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-brand-orange">
      <circle cx="5.5" cy="17.5" r="3.5" /><circle cx="18.5" cy="17.5" r="3.5" />
      <path d="M15 17.5 12 8h3l1.5 4.5M12 8 9.5 17.5M9 8h3" />
    </svg>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return <div className="flex justify-between py-0.5 text-sm text-black/70"><span>{label}</span><span>{value}</span></div>;
}

function SearchIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
      className="shrink-0 text-black/30"><circle cx="11" cy="11" r="7" /><path d="M21 21l-4-4" strokeLinecap="round" /></svg>
  );
}

function CuisineChip({ emoji, label, active, onClick }: { emoji: string; label: string; active: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick} className="flex shrink-0 flex-col items-center gap-1.5">
      <span className={`flex h-14 w-14 items-center justify-center rounded-2xl text-2xl shadow-sm ring-1 transition ${
        active ? 'bg-brand-orange text-white ring-brand-orange' : 'bg-white ring-black/5'
      }`}>{emoji}</span>
      <span className={`max-w-[4.5rem] truncate text-[11px] font-semibold ${active ? 'text-brand-orange' : 'text-black/60'}`}>{label}</span>
    </button>
  );
}

function CatTab({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick}
      className={`shrink-0 whitespace-nowrap border-b-2 px-1 pb-2 text-sm font-semibold transition ${
        active ? 'border-brand-orange text-brand-ink' : 'border-transparent text-black/40 hover:text-black/70'
      }`}>
      {children}
    </button>
  );
}

/** Inline panel to pick a customized item (one/many choices per group). */
function Customizer({ item, onAdd }: { item: MenuItem; onAdd: (options: CartOption[]) => void }) {
  // selected choice names per group id — nothing pre-selected; the customer picks.
  const [sel, setSel] = useState<Record<string, string[]>>({});

  function pick(g: CustomGroup, name: string) {
    setSel((s) => {
      const cur = s[g.id] ?? [];
      if (g.multi) return { ...s, [g.id]: cur.includes(name) ? cur.filter((n) => n !== name) : [...cur, name] };
      return { ...s, [g.id]: [name] };
    });
  }

  const chosen: CartOption[] = item.groups.flatMap((g) =>
    (sel[g.id] ?? []).map((n) => ({ name: n, priceDelta: g.choices.find((c) => c.name === n)?.priceDelta ?? 0 })),
  );
  const missing = item.groups.some((g) => g.required && (sel[g.id] ?? []).length === 0);
  const total = item.price + chosen.reduce((s, o) => s + o.priceDelta, 0);

  return (
    <div className="mt-3">
      {item.groups.map((g) => (
        <div key={g.id} className="mb-3">
          <p className="mb-1.5 text-xs font-semibold text-black/70">
            {g.name}
            <span className="ml-1 font-normal text-black/40">{g.required ? '(required)' : '(optional)'}{g.multi ? ' · pick any' : ''}</span>
          </p>
          <div className="flex flex-wrap gap-1.5">
            {g.choices.map((c) => {
              const on = (sel[g.id] ?? []).includes(c.name);
              return (
                <button key={c.name} type="button" onClick={() => pick(g, c.name)}
                  className={`rounded-full px-3 py-1.5 text-xs font-medium ring-1 transition ${
                    on ? 'bg-brand-orange text-white ring-brand-orange' : 'bg-white text-black/60 ring-black/10'
                  }`}>
                  {c.name}{c.priceDelta !== 0 && <span className={on ? 'opacity-80' : 'text-black/40'}> {c.priceDelta > 0 ? '+' : ''}{peso(c.priceDelta)}</span>}
                </button>
              );
            })}
            {g.choices.length === 0 && <span className="text-xs text-black/30">No choices set.</span>}
          </div>
        </div>
      ))}
      <button onClick={() => onAdd(chosen)} disabled={missing}
        className="mt-1 w-full rounded-xl bg-brand-orange py-3 text-sm font-semibold text-white disabled:opacity-50">
        {missing ? 'Choose required options' : `Add to cart · ${peso(total)}`}
      </button>
    </div>
  );
}
