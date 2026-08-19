import { useEffect, useState } from 'react';
import { listOrders, getOrderDetail } from '@servdgo/supabase';
import type { ServiceType, OrderStatus } from '@servdgo/shared';
import { errMessage } from '@servdgo/shared';
import { supabase } from './lib/supabase.ts';
import { useDayRange } from './DateRange.tsx';
import { Card, Th, Td, Muted, ErrorNote, peso } from './ui.tsx';

interface OrderRow {
  id: string;
  created_at: string;
  service_type: string;
  status: string;
  customer_contact: string;
  goods_cost: number;
  delivery_fee: number;
  commission_amount: number;
  payment_method: string;
  payment_status: string;
}

const SAMPLE: OrderRow[] = [
  { id: 'h1', created_at: '2026-07-19T09:12:00Z', service_type: 'food', status: 'delivered', customer_contact: '0917 111 2222', goods_cost: 280, delivery_fee: 50, commission_amount: 7.5, payment_method: 'cod', payment_status: 'paid' },
  { id: 'h2', created_at: '2026-07-19T08:40:00Z', service_type: 'pabili', status: 'delivered', customer_contact: '0917 333 4444', goods_cost: 540, delivery_fee: 60, commission_amount: 9, payment_method: 'cod', payment_status: 'paid' },
  { id: 'h3', created_at: '2026-07-19T08:05:00Z', service_type: 'padala', status: 'cancelled', customer_contact: '0917 555 6666', goods_cost: 0, delivery_fee: 40, commission_amount: 6, payment_method: 'online', payment_status: 'paid' },
  { id: 'h4', created_at: '2026-07-18T19:20:00Z', service_type: 'food', status: 'delivered', customer_contact: '0917 777 8888', goods_cost: 190, delivery_fee: 50, commission_amount: 7.5, payment_method: 'cod', payment_status: 'paid' },
];

const SERVICES: (ServiceType | 'all')[] = ['all', 'food', 'pabili', 'padala'];
const STATUSES: (OrderStatus | 'all')[] = ['all', 'pending', 'accepted', 'preparing', 'picked_up', 'on_the_way', 'delivered', 'cancelled'];
const PAGE = 20;

const serviceChip: Record<string, string> = {
  food: 'bg-brand-orange/15 text-green-800',
  pabili: 'bg-brand-charcoal/15 text-brand-charcoal',
  padala: 'bg-brand-yellow/30 text-yellow-800',
};
const statusChip = (s: string) =>
  s === 'delivered' ? 'bg-brand-orange/15 text-green-800'
  : s === 'cancelled' ? 'bg-red-100 text-red-700'
  : 'bg-black/5 text-black/60';

const fmtDate = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

export function OrderHistory() {
  const [rows, setRows] = useState<OrderRow[]>([]);
  const [count, setCount] = useState(0);
  const [service, setService] = useState<ServiceType | 'all'>('all');
  const [status, setStatus] = useState<OrderStatus | 'all'>('all');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  const dates = useDayRange(30);
  // A new span is a new list; page 5 of the old one means nothing in it.
  useEffect(() => { setPage(0); }, [dates.key]);

  useEffect(() => {
    (async () => {
      setLoading(true); setError(null);
      if (!supabase) {
        let r = SAMPLE;
        if (service !== 'all') r = r.filter((o) => o.service_type === service);
        if (status !== 'all') r = r.filter((o) => o.status === status);
        if (search.trim()) r = r.filter((o) => o.customer_contact.includes(search.trim()));
        setRows(r); setCount(r.length); setLoading(false); return;
      }
      try {
        const res = await listOrders(supabase, {
          serviceType: service === 'all' ? undefined : service,
          status: status === 'all' ? undefined : status,
          search: search || undefined,
          fromDay: dates.range.from, toDay: dates.range.to,
          limit: PAGE, offset: page * PAGE,
        });
        setRows(res.rows as unknown as OrderRow[]); setCount(res.count);
      } catch (e) { setError(errMessage(e)); }
      finally { setLoading(false); }
    })();
  }, [service, status, search, page, dates.key]);

  const pages = Math.max(1, Math.ceil(count / PAGE));

  return (
    <div className="space-y-4">
      <Card title="Filter">
        <div className="mb-3">{dates.controls}</div>
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex gap-1.5">
            {SERVICES.map((s) => (
              <button key={s} onClick={() => { setService(s); setPage(0); }}
                className={`rounded-lg px-3 py-1.5 text-xs font-medium capitalize ring-1 transition ${
                  service === s ? 'bg-brand-orange text-white ring-brand-orange' : 'bg-white text-black/60 ring-black/10'
                }`}>{s}</button>
            ))}
          </div>
          <select value={status} onChange={(e) => { setStatus(e.target.value as OrderStatus | 'all'); setPage(0); }}
            className="rounded-lg border border-black/10 px-3 py-1.5 text-sm capitalize outline-none focus:border-brand-orange">
            {STATUSES.map((s) => <option key={s} value={s}>{s === 'all' ? 'All statuses' : s.replaceAll('_', ' ')}</option>)}
          </select>
          <input value={search} onChange={(e) => { setSearch(e.target.value); setPage(0); }}
            placeholder="Search customer #"
            className="min-w-[10rem] flex-1 rounded-lg border border-black/10 px-3 py-1.5 text-sm outline-none focus:border-brand-orange" />
        </div>
      </Card>

      {loading ? <Muted>Loading…</Muted>
        : error ? <ErrorNote msg={error} />
        : rows.length === 0 ? <Muted>No orders in this period match these filters.</Muted>
        : (
        <Card title={`Orders (${count})`}>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-black/50">
                <tr className="border-b border-black/5">
                  <Th>When</Th><Th>Service</Th><Th>Status</Th><Th>Customer</Th>
                  <Th>Goods</Th><Th>Fee</Th><Th>Commission</Th><Th>Payment</Th>
                </tr>
              </thead>
              <tbody>
                {rows.map((o) => (
                  <tr key={o.id} onClick={() => setDetailId(o.id)}
                    className="cursor-pointer border-b border-black/[0.04] hover:bg-black/[0.02]">
                    <Td className="whitespace-nowrap text-black/60">{fmtDate(o.created_at)}</Td>
                    <Td><span className={`rounded-full px-2.5 py-0.5 text-xs font-medium capitalize ${serviceChip[o.service_type] ?? 'bg-black/5'}`}>{o.service_type}</span></Td>
                    <Td><span className={`rounded-full px-2.5 py-0.5 text-xs font-medium capitalize ${statusChip(o.status)}`}>{o.status.replaceAll('_', ' ')}</span></Td>
                    <Td>{o.customer_contact}</Td>
                    <Td>{peso(o.goods_cost)}</Td>
                    <Td>{peso(o.delivery_fee)}</Td>
                    <Td className="font-medium">{peso(o.commission_amount)}</Td>
                    <Td className="capitalize">
                      {o.payment_method.replaceAll('_', ' ')}
                      {o.payment_status === 'paid' && <span className="ml-1 text-green-700">✓</span>}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {pages > 1 && (
            <div className="mt-3 flex items-center justify-between text-sm">
              <button disabled={page === 0} onClick={() => setPage((p) => p - 1)}
                className="rounded-lg px-3 py-1.5 ring-1 ring-black/10 disabled:opacity-40">← Prev</button>
              <span className="text-black/50">Page {page + 1} of {pages}</span>
              <button disabled={page + 1 >= pages} onClick={() => setPage((p) => p + 1)}
                className="rounded-lg px-3 py-1.5 ring-1 ring-black/10 disabled:opacity-40">Next →</button>
            </div>
          )}
        </Card>
      )}

      {detailId && <OrderDetailModal id={detailId} onClose={() => setDetailId(null)} />}
    </div>
  );
}

function OrderDetailModal({ id, onClose }: { id: string; onClose: () => void }) {
  const [detail, setDetail] = useState<{ order: any; items: any[]; events: any[] } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!supabase) {
      const o = SAMPLE.find((x) => x.id === id);
      setDetail({ order: o ?? {}, items: [
        { name: 'Chicken Adobo', qty: 2, unit_price: 95 }, { name: 'Extra Rice', qty: 1, unit_price: 20 },
      ], events: [] });
      return;
    }
    getOrderDetail(supabase, id).then(setDetail).catch((e) => setError(errMessage(e)));
  }, [id]);

  return (
    <div onClick={onClose} className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4">
      <div onClick={(e) => e.stopPropagation()} className="max-h-[85vh] w-full max-w-md overflow-y-auto rounded-2xl bg-white p-6 shadow-xl">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="font-bold">Order detail</h3>
          <button onClick={onClose} className="text-sm text-brand-charcoal">Close</button>
        </div>
        {error && <ErrorNote msg={error} />}
        {!detail ? <Muted>Loading…</Muted> : (
          <div className="space-y-4 text-sm">
            <div className="flex flex-wrap gap-x-6 gap-y-1 text-black/70">
              <span className="capitalize"><b className="text-brand-ink">{detail.order.service_type}</b></span>
              <span className="capitalize">Status: {String(detail.order.status ?? '').replaceAll('_', ' ')}</span>
              <span>Contact: {detail.order.customer_contact}</span>
            </div>
            {detail.items.length > 0 && (
              <div>
                <p className="mb-1 font-medium">Items</p>
                <ul className="divide-y divide-black/5 rounded-lg ring-1 ring-black/5">
                  {detail.items.map((it, i) => (
                    <li key={i} className="flex justify-between px-3 py-2">
                      <span>{it.qty}× {it.name}</span>
                      <span>{peso((it.unit_price ?? 0) * (it.qty ?? 1))}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <div className="rounded-lg bg-black/[0.02] p-3">
              <Line label="Goods" value={peso(detail.order.goods_cost ?? 0)} />
              <Line label="Delivery fee" value={peso(detail.order.delivery_fee ?? 0)} />
              {Number(detail.order.store_fee_total ?? 0) > 0 &&
                <Line label="Store fee" value={peso(detail.order.store_fee_total ?? 0)} />}
              {Number(detail.order.convenience_fee ?? 0) > 0 &&
                <Line label="Convenience fee" value={peso(detail.order.convenience_fee ?? 0)} />}
              <div className="mt-1 flex justify-between border-t border-black/10 pt-1 font-bold">
                <span>Total</span>
                <span>{peso(
                  Number(detail.order.goods_cost ?? 0) + Number(detail.order.delivery_fee ?? 0)
                  + Number(detail.order.store_fee_total ?? 0) + Number(detail.order.convenience_fee ?? 0),
                )}</span>
              </div>
              <Line label="Commission" value={peso(detail.order.commission_amount ?? 0)} />
              <Line label="Payment" value={`${String(detail.order.payment_method ?? '').replaceAll('_', ' ')}${detail.order.payment_status === 'paid' ? ' ✓' : ''}`} />
            </div>
            {detail.events.length > 0 && (
              <div>
                <p className="mb-1 font-medium">Timeline</p>
                <ul className="space-y-1 text-black/60">
                  {detail.events.map((e, i) => (
                    <li key={i} className="capitalize">• {String(e.status).replaceAll('_', ' ')} — {fmtDate(e.created_at)}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

const Line = ({ label, value }: { label: string; value: string }) => (
  <div className="flex justify-between py-0.5"><span className="text-black/60">{label}</span><span className="font-medium capitalize">{value}</span></div>
);
