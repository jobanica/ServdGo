import { useEffect, useState } from 'react';
import {
  getMyOrderDetail, getOrderRiderInfo, orderGoodsAmount, orderGoodsIsFinal,
  type MyOrderDetail, type OrderRiderInfo,
} from '@ebd/supabase';
import { errMessage } from '@ebd/shared';
import { supabase } from './lib/supabase.ts';
import { peso } from './ui.tsx';

const when = (iso: string) => new Intl.DateTimeFormat('en-PH', {
  timeZone: 'Asia/Manila', weekday: 'short', day: 'numeric', month: 'short',
  hour: 'numeric', minute: '2-digit', hour12: true,
}).format(new Date(iso));

const payLabel: Record<string, string> = {
  cod: 'Cash on delivery',
  rider_qr: 'GCash to rider',
  online: 'Pay online (collected at the door)',
};

function Line({ label, value, strong, muted }: {
  label: string; value: string; strong?: boolean; muted?: boolean;
}) {
  return (
    <div className={`flex justify-between gap-3 py-0.5 text-sm ${muted ? 'text-black/45' : ''}`}>
      <span>{label}</span>
      <span className={`shrink-0 tabular-nums ${strong ? 'font-bold' : ''}`}>{value}</span>
    </div>
  );
}

/**
 * The whole of one past order, opened from the history list.
 *
 * A history row can only fit a date and a total — and the total is the thing
 * people question weeks later. "Why was that ₱943?" has an answer, and this is
 * where it lives: every item, every fee, the address it went to, and who
 * brought it.
 *
 * Loaded only when opened, because most rows are never asked about.
 */
export function OrderDetails({ orderId }: { orderId: string }) {
  const [open, setOpen] = useState(false);
  const [order, setOrder] = useState<MyOrderDetail | null>(null);
  const [rider, setRider] = useState<OrderRiderInfo | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !supabase || order) return;
    getMyOrderDetail(supabase, orderId)
      .then((d) => { setOrder(d); setErr(d ? null : 'That order could not be loaded.'); })
      .catch((e) => setErr(errMessage(e)));
    getOrderRiderInfo(supabase, orderId).then(setRider).catch(() => { /* no rider yet */ });
  }, [open, orderId, order]);

  if (!open) {
    return (
      <button onClick={() => setOpen(true)}
        className="mt-2 rounded-lg border border-black/10 px-2.5 py-1 text-xs font-semibold text-black/60">
        🧾 View details
      </button>
    );
  }

  const goods = order ? orderGoodsAmount(order) : 0;
  const total = order ? goods + order.delivery_fee + order.store_fee_total + order.convenience_fee : 0;
  // A sold-out item is on the receipt as history, but not on the bill.
  const billed = (order?.items ?? []).filter((i) => i.status === 'ok');
  const dropped = (order?.items ?? []).filter((i) => i.status === 'sold_out' || i.status === 'removed');

  return (
    <div className="mt-2 rounded-xl bg-black/[0.02] p-3 ring-1 ring-black/10">
      {err && <p className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{err}</p>}
      {!order && !err && <p className="py-2 text-center text-xs text-black/40">Loading…</p>}

      {order && (
        <>
          <p className="text-[11px] uppercase tracking-wide text-black/40">Ordered</p>
          <p className="text-sm font-medium">{when(order.created_at)}</p>
          {order.delivered_at && (
            <p className="mt-0.5 text-xs text-black/50">Delivered {when(order.delivered_at)}</p>
          )}

          {order.stores.length > 0 && (
            <p className="mt-2 text-xs text-black/60">
              <span className="text-black/40">From </span>{order.stores.join(' · ')}
            </p>
          )}

          {billed.length > 0 && (
            <div className="mt-2.5 border-t border-black/5 pt-2">
              {billed.map((i) => (
                <div key={i.id} className="flex justify-between gap-3 py-0.5 text-sm">
                  <span className="min-w-0">
                    <span className="font-medium">{i.qty}×</span> {i.name}
                    {order.stores.length > 1 && i.storeName && (
                      <span className="block text-[11px] text-black/40">{i.storeName}</span>
                    )}
                    {i.notes && <span className="block text-[11px] text-black/40">— {i.notes}</span>}
                  </span>
                  <span className="shrink-0 tabular-nums text-black/70">{peso(i.qty * i.unitPrice)}</span>
                </div>
              ))}
            </div>
          )}

          {dropped.length > 0 && (
            <div className="mt-1.5 text-[11px] text-black/40">
              {dropped.map((i) => (
                <div key={i.id}>
                  <span className="line-through">{i.qty}× {i.name}</span>
                  {' '}— {i.status === 'sold_out' ? 'sold out, not charged' : 'removed'}
                </div>
              ))}
            </div>
          )}

          {/* Pabili has no line items — the request is one description. */}
          {billed.length === 0 && order.item_description && (
            <p className="mt-2.5 border-t border-black/5 pt-2 text-sm">{order.item_description}</p>
          )}

          <div className="mt-2.5 border-t border-black/5 pt-2">
            {goods > 0 && (
              <Line
                label={orderGoodsIsFinal(order)
                  ? (order.service_type === 'food' ? 'Food subtotal' : 'Goods')
                  : 'Goods (your estimate)'}
                value={peso(goods)} />
            )}
            <Line label="Delivery fee" value={peso(order.delivery_fee)} />
            {order.store_fee_total > 0 && <Line label="Store fee" value={peso(order.store_fee_total)} />}
            {order.convenience_fee > 0 && <Line label="Convenience fee" value={peso(order.convenience_fee)} />}
            <div className="mt-1 border-t border-black/10 pt-1.5">
              <Line label="Total" value={peso(total)} strong />
            </div>
            {!orderGoodsIsFinal(order) && (
              <p className="mt-1 text-[11px] text-black/40">
                The goods figure was your estimate — the rider's receipt total is what you paid.
              </p>
            )}
            {order.goods_receipt_url && (
              <a href={order.goods_receipt_url} target="_blank" rel="noreferrer"
                className="mt-1.5 inline-block text-xs font-medium text-brand-purple underline">
                🧾 Store receipt
              </a>
            )}
          </div>

          <div className="mt-2.5 space-y-1.5 border-t border-black/5 pt-2 text-xs text-black/60">
            <p>
              <span className="text-black/40">Payment · </span>
              {payLabel[order.payment_method ?? ''] ?? order.payment_method ?? '—'}
              {order.payment_status === 'paid' && <span className="text-green-700"> ✓ paid</span>}
            </p>
            {order.delivery_address && (
              <p>
                <span className="text-black/40">Delivered to · </span>{order.delivery_address}
                {order.area_barangay && (
                  <span className="block text-black/40">
                    {[order.area_barangay, order.area_city, order.area_province].filter(Boolean).join(', ')}
                  </span>
                )}
              </p>
            )}
            {order.recipient_name && (
              <p><span className="text-black/40">🎁 For · </span>{order.recipient_name}
                {order.recipient_contact ? ` · ${order.recipient_contact}` : ''}</p>
            )}
            {rider?.name && (
              <p><span className="text-black/40">Rider · </span>{rider.name}</p>
            )}
            {order.notes && (
              <p><span className="text-black/40">Your note · </span>{order.notes}</p>
            )}
            <p className="pt-0.5 font-mono text-[10px] text-black/30">Ref {order.id.slice(0, 8)}</p>
          </div>
        </>
      )}

      <button onClick={() => setOpen(false)}
        className="mt-2.5 w-full rounded-lg border border-black/10 bg-white py-2 text-xs font-semibold text-black/60">
        Close
      </button>
    </div>
  );
}
