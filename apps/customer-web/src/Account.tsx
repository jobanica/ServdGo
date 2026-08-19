import { useEffect, useState, useCallback } from 'react';
import {
  getMyCustomer, listCustomerOrders, listAddresses, addAddress, deleteAddress, setDefaultAddress, cancelOrder,
  orderGoodsAmount, orderGoodsIsFinal,
  type MyCustomer, type CustomerOrder, type CustomerAddress,
} from '@servdgo/supabase';
import { supabase, isSupabaseConfigured } from './lib/supabase.ts';
import { useAuth } from './auth/AuthContext.tsx';
import { LocationPicker, type LatLngValue } from './LocationPicker.tsx';
import { AreaPicker } from './AreaPicker.tsx';
import type { AreaSelection } from '@servdgo/supabase';
import { PayRider } from './PayRider.tsx';
import { peso } from './ui.tsx';
import { REQUIRE_ACCOUNT, APP_VERSION } from './config.ts';
import { SUPPORT_EMAIL, SUPPORT_PHONE, PRIVACY_URL, TERMS_URL } from '@servdgo/shared';
import { DeleteAccount } from './DeleteAccount.tsx';
import { FixPin } from './FixPin.tsx';
import { SaveDeliveredAddress } from './SaveDeliveredAddress.tsx';
import { AddToOrder } from './AddToOrder.tsx';
import { OrderDetails } from './OrderDetails.tsx';
import { errMessage } from '@servdgo/shared';

const inp = 'w-full rounded-lg border border-black/10 bg-white px-3 py-2 text-sm outline-none focus:border-brand-green focus:ring-2 focus:ring-brand-green/30';

const serviceTint: Record<string, string> = {
  food: 'bg-brand-green/15 text-green-800',
  pabili: 'bg-brand-purple/15 text-brand-purple',
  padala: 'bg-brand-yellow/30 text-yellow-800',
};

function orderTotal(o: CustomerOrder): number {
  return orderGoodsAmount(o) + o.delivery_fee + o.store_fee_total + o.convenience_fee;
}
/** Cancel a still-pending order (before any rider accepts). */
function CancelOrderButton({ orderId, onCancelled }: { orderId: string; onCancelled: () => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function cancel() {
    if (!supabase) return;
    if (!window.confirm('Cancel this order?')) return;
    setBusy(true); setErr(null);
    try {
      const ok = await cancelOrder(supabase, orderId);
      if (ok) onCancelled();
      else setErr('This order can no longer be cancelled — a rider has accepted it.');
    } catch (e) { setErr(errMessage(e)); }
    finally { setBusy(false); }
  }
  return (
    <div className="mt-2">
      <button onClick={cancel} disabled={busy}
        className="rounded-lg border border-red-300 px-3 py-1.5 text-xs font-medium text-red-600 disabled:opacity-50">
        {busy ? 'Cancelling…' : 'Cancel order'}
      </button>
      {err && <p className="mt-1 text-xs text-red-600">{err}</p>}
    </div>
  );
}

function fmtDate(iso: string): string {
  return new Intl.DateTimeFormat('en-PH', { timeZone: 'Asia/Manila', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true }).format(new Date(iso));
}

export function Account() {
  const { ensureContact, signOut, live } = useAuth();
  const [customer, setCustomer] = useState<MyCustomer | null>(null);
  const [orders, setOrders] = useState<CustomerOrder[]>([]);
  const [addresses, setAddresses] = useState<CustomerAddress[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!supabase || !isSupabaseConfigured) { setLoading(false); return; }
    try {
      const c = await getMyCustomer(supabase);
      setCustomer(c);
      if (c) {
        const [o, a] = await Promise.all([listCustomerOrders(supabase, c.id), listAddresses(supabase, c.id)]);
        setOrders(o); setAddresses(a);
      }
    } catch { /* ignore */ } finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  if (!isSupabaseConfigured) {
    return <Card title="Account"><p className="text-sm text-black/50">Connect the app to manage your account.</p></Card>;
  }
  if (loading) return <p className="text-sm text-black/50">Loading…</p>;

  return (
    <div className="space-y-4">
      <h2 className="text-xl font-extrabold">My account</h2>

      <ProfileSection customer={customer} ensureContact={ensureContact} onSaved={load} />

      {customer && <AddressesSection customerId={customer.id} addresses={addresses} onChange={load} />}

      {customer && (
        <Card title="Order history">
          {orders.length === 0 ? (
            <p className="text-sm text-black/40">No orders yet.</p>
          ) : (
            <ul className="divide-y divide-black/5">
              {orders.map((o) => (
                <li key={o.id} className="py-2.5">
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <span className="flex items-center gap-2">
                        <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold capitalize ${serviceTint[o.service_type] ?? 'bg-black/5'}`}>{o.service_type}</span>
                        <span className="text-xs capitalize text-black/50">{o.status.replaceAll('_', ' ')}</span>
                      </span>
                      <span className="mt-0.5 block truncate text-xs text-black/45">
                        {fmtDate(o.created_at)}
                        {o.order_stores?.[0]?.store?.name ? ` · ${o.order_stores[0].store!.name}` : ''}
                        {o.recipient_name ? ` · 🎁 to ${o.recipient_name}` : ''}
                      </span>
                    </div>
                    <span className="shrink-0 text-right">
                      <span className="block text-sm font-bold">{peso(orderTotal(o))}</span>
                      {!orderGoodsIsFinal(o) && <span className="block text-[10px] text-black/40">estimated</span>}
                    </span>
                  </div>
                  {o.service_type === 'pabili' && (
                    <div className="mt-1.5 flex items-center gap-2 text-[11px] text-black/50">
                      <span>
                        Goods {peso(orderGoodsAmount(o))}
                        {orderGoodsIsFinal(o) ? ' (receipt)' : ' (your estimate)'}
                        {' · '}delivery {peso(o.delivery_fee)}
                        {o.convenience_fee > 0 ? ` · convenience ${peso(o.convenience_fee)}` : ''}
                      </span>
                      {o.goods_receipt_url && (
                        <a href={o.goods_receipt_url} target="_blank" rel="noreferrer"
                          className="shrink-0 font-medium text-brand-purple underline">🧾 Receipt</a>
                      )}
                    </div>
                  )}
                  {o.payment_method === 'rider_qr' && !['delivered', 'cancelled'].includes(o.status) && (
                    <PayRider orderId={o.id} />
                  )}
                  <OrderDetails orderId={o.id} />
                  {['pending', 'accepted', 'preparing'].includes(o.status) && (
                    <>
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        {o.status === 'pending' && <CancelOrderButton orderId={o.id} onCancelled={load} />}
                        <FixPin orderId={o.id} serviceType={o.service_type} onDone={load} />
                        {o.service_type === 'food' && (
                          <AddToOrder orderId={o.id} status={o.status} onAdded={load} />
                        )}
                      </div>
                    </>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}

      <SaveDeliveredAddress orders={orders} onSaved={load} />

      <Card title="Help & support">
        <p className="mb-3 text-sm text-black/55">Questions about an order? Reach the operator.</p>
        <div className="flex gap-2">
          {SUPPORT_PHONE && (
            <>
              <a href={`tel:${SUPPORT_PHONE.replace(/\s/g, '')}`} className="flex-1 rounded-xl bg-brand-green py-2.5 text-center text-sm font-bold text-white">Call</a>
              <a href={`sms:${SUPPORT_PHONE.replace(/\s/g, '')}`} className="flex-1 rounded-xl bg-brand-purple py-2.5 text-center text-sm font-bold text-white">Message</a>
            </>
          )}
          <a href={`mailto:${SUPPORT_EMAIL}`} className="flex-1 rounded-xl bg-brand-purple py-2.5 text-center text-sm font-bold text-white">Email us</a>
        </div>
      </Card>

      <Card title="About">
        <div className="flex justify-between text-sm"><span className="text-black/55">App version</span><span className="font-medium">{APP_VERSION}</span></div>
        <div className="mt-2 flex gap-3 text-sm">
          <a href={PRIVACY_URL} target="_blank" rel="noreferrer" className="text-brand-purple">Privacy Policy</a>
          <a href={TERMS_URL} target="_blank" rel="noreferrer" className="text-brand-purple">Terms</a>
        </div>
      </Card>

      {live && REQUIRE_ACCOUNT && <DeleteAccount />}

      {live && REQUIRE_ACCOUNT && (
        <button onClick={() => void signOut()} className="w-full rounded-2xl bg-white py-3 text-sm font-bold text-red-600 shadow-sm ring-1 ring-black/5">
          Sign out
        </button>
      )}
      <p className="pb-2 text-center text-xs text-black/35">ServdGo · v{APP_VERSION}</p>
    </div>
  );
}

function ProfileSection({ customer, ensureContact, onSaved }: {
  customer: MyCustomer | null; ensureContact: (mobile: string, name?: string) => Promise<string>; onSaved: () => Promise<void>;
}) {
  const [name, setName] = useState(customer?.name ?? '');
  const [mobile, setMobile] = useState(customer?.mobile_number && customer.mobile_number !== 'unknown' ? customer.mobile_number : '');
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function save() {
    if (!mobile.trim()) { setErr('Enter your mobile number.'); return; }
    setBusy(true); setSaved(false); setErr(null);
    try { await ensureContact(mobile.trim(), name.trim() || undefined); await onSaved(); setSaved(true); }
    catch (e) { setErr(errMessage(e)); }
    finally { setBusy(false); }
  }

  return (
    <Card title="Profile">
      <div className="space-y-2">
        <input className={inp} placeholder="Your name" value={name} onChange={(e) => { setName(e.target.value); setSaved(false); }} />
        <input className={inp} placeholder="Mobile number" inputMode="tel" value={mobile} onChange={(e) => { setMobile(e.target.value); setSaved(false); }} />
      </div>
      <button onClick={save} disabled={busy}
        className="mt-3 w-full rounded-lg bg-brand-green py-2.5 text-sm font-bold text-white disabled:opacity-50">
        {busy ? 'Saving…' : saved ? '✓ Saved' : 'Save profile'}
      </button>
      {err && <p className="mt-2 text-xs text-red-600">{err}</p>}
    </Card>
  );
}

function AddressesSection({ customerId, addresses, onChange }: {
  customerId: string; addresses: CustomerAddress[]; onChange: () => Promise<void>;
}) {
  const [adding, setAdding] = useState(false);
  const [label, setLabel] = useState('');
  const [text, setText] = useState('');
  const [pin, setPin] = useState<LatLngValue | null>(null);
  const [area, setArea] = useState<AreaSelection | null>(null);
  const [makeDefault, setMakeDefault] = useState(addresses.length === 0);
  const [busy, setBusy] = useState(false);

  async function add() {
    if (!supabase || !text.trim()) return;
    setBusy(true);
    try {
      await addAddress(supabase, {
        customerId, label, address: text, lat: pin?.lat ?? null, lng: pin?.lng ?? null,
        isDefault: makeDefault,
        province: area?.province ?? null, city: area?.city ?? null, barangay: area?.barangay ?? null,
      });
      setLabel(''); setText(''); setPin(null); setArea(null); setAdding(false);
      await onChange();
    } finally { setBusy(false); }
  }
  async function remove(id: string) { if (supabase) { await deleteAddress(supabase, id); await onChange(); } }
  async function makeDef(id: string) { if (supabase) { await setDefaultAddress(supabase, customerId, id); await onChange(); } }

  return (
    <Card title="Saved addresses">
      {addresses.length === 0 && !adding && <p className="mb-2 text-sm text-black/40">No saved addresses yet.</p>}
      <ul className="space-y-2">
        {addresses.map((a) => (
          <li key={a.id} className="flex items-start justify-between gap-2 rounded-xl bg-black/[0.03] px-3 py-2.5">
            <div className="min-w-0">
              <p className="text-sm font-medium">
                {a.label || 'Address'}
                {a.is_default && <span className="ml-2 rounded-full bg-brand-green/15 px-2 py-0.5 text-[10px] font-semibold text-green-800">Default</span>}
              </p>
              <p className="truncate text-xs text-black/50">{a.address}</p>
            </div>
            <div className="flex shrink-0 flex-col items-end gap-1">
              {!a.is_default && <button onClick={() => makeDef(a.id)} className="text-[11px] font-medium text-brand-purple">Set default</button>}
              <button onClick={() => remove(a.id)} className="text-[11px] font-medium text-red-600">Delete</button>
            </div>
          </li>
        ))}
      </ul>

      {adding ? (
        <div className="mt-3 space-y-2 rounded-xl bg-black/[0.02] p-3">
          <input className={inp} placeholder="Label (e.g. Home, Office)" value={label} onChange={(e) => setLabel(e.target.value)} />
          <input className={inp} placeholder="Address / landmark" value={text} onChange={(e) => setText(e.target.value)} />
          <div className="mb-2"><AreaPicker value={area} onChange={setArea} onRequired={() => {}} /></div>
          <LocationPicker value={pin} onChange={setPin} height={180} />
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={makeDefault} onChange={(e) => setMakeDefault(e.target.checked)} className="h-4 w-4 accent-[#6DBE22]" />
            Set as default
          </label>
          <div className="flex gap-2">
            <button onClick={() => setAdding(false)} className="flex-1 rounded-lg border border-black/10 py-2 text-sm font-semibold text-black/60">Cancel</button>
            <button onClick={add} disabled={busy || !text.trim()} className="flex-1 rounded-lg bg-brand-green py-2 text-sm font-bold text-white disabled:opacity-50">
              {busy ? 'Saving…' : 'Save address'}
            </button>
          </div>
        </div>
      ) : (
        <button onClick={() => setAdding(true)} className="mt-3 w-full rounded-lg border border-dashed border-brand-purple/50 py-2.5 text-sm font-semibold text-brand-purple hover:bg-brand-purple/5">
          ＋ Add an address
        </button>
      )}
    </Card>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-black/5">
      <p className="mb-3 text-sm font-bold">{title}</p>
      {children}
    </div>
  );
}
