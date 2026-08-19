import type { EarningRecord, LedgerEntry, OrderStatus } from '@servdgo/shared';
import {
  needsOverBudgetConfirmation, canTransition, generatesSettlementBalance,
  filterEarnings, manilaDay,
} from '@servdgo/shared';
import type { RiderData, RiderOrder } from './types.ts';

/** YYYY-MM-DD helpers for seeding a believable ledger. */
function isoDay(offsetDays: number): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

/** An ISO timestamp N minutes back — seeds a queue with a believable order. */
function minsAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

/** A few weeks of completed deliveries so the earnings calendar has something to filter. */
function seedEarnings(): EarningRecord[] {
  const services: EarningRecord['serviceType'][] = ['food', 'pabili', 'padala'];
  const out: EarningRecord[] = [];
  for (let back = 0; back < 30; back++) {
    // A quiet day here and there, so the per-day breakdown isn't a flat line.
    const runs = [3, 2, 4, 0, 5, 3, 1][back % 7]!;
    for (let i = 0; i < runs; i++) {
      const deliveryFee = 40 + ((back * 7 + i * 13) % 5) * 10;
      const storeFeeTotal = i % 3 === 0 ? 25 : 0;
      out.push({
        orderId: `past-${back}-${i}`,
        businessDay: manilaDay(new Date(Date.now() - back * 86_400_000)),
        serviceType: services[(back + i) % services.length]!,
        deliveryFee,
        storeFeeTotal,
        convenienceFee: i % 2 === 0 ? 15 : 0,
        commission: Math.round((deliveryFee + storeFeeTotal) * 0.15 * 100) / 100,
      });
    }
  }
  return out;
}

/** Food totals follow the live line items, same as the database does. */
function rebill(o: RiderOrder): RiderOrder {
  if (o.service_type !== 'food') return o;
  const goods = o.items
    .filter((i) => i.status === 'ok')
    .reduce((sum, i) => sum + i.qty * i.unitPrice, 0);
  return { ...o, goods_cost: goods };
}

/** Stand-in for a customer-uploaded GCash receipt (preview has no storage). */
const RECEIPT_PLACEHOLDER =
  'data:image/svg+xml;utf8,' + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120">'
    + '<rect width="120" height="120" fill="#f1eaff"/>'
    + '<text x="60" y="52" font-family="sans-serif" font-size="13" fill="#5b3fa8" text-anchor="middle">GCash</text>'
    + '<text x="60" y="74" font-family="sans-serif" font-size="11" fill="#5b3fa8" text-anchor="middle">receipt</text>'
    + '</svg>',
  );

/**
 * In-memory rider data for preview mode (no Supabase). Seeds an unsettled
 * previous-day balance so the settlement lock screen is demonstrable, plus a
 * pool of one order per service type.
 */
export function createPreviewData(): RiderData {
  let open: RiderOrder[] = [
    {
      id: 'ord-transfer-1', createdAt: minsAgo(42), service_type: 'food', status: 'pending',
      payment_method: 'cod', payment_status: 'unpaid', customerName: 'Rico Tan', recipientName: null, recipientContact: null,
      delivery_fee: 55, store_fee_total: 0, convenience_fee: 20, goods_cost: 320, commission_amount: 8.25,
      customer_contact: '0917 777 1010', item_description: null,
      estimated_amount: null, budget_cap: null, actual_amount: null, goodsReceiptUrl: null,
      buyStores: [],
      store_contact: '0918 555 0200', stores: [{ id: 's2', name: 'Kowloon House', contact: '0918 555 0200', lat: 14.18, lng: 121.246 }],
      items: [{ id: 'it-1', store_id: 's2', menuItemId: 'mi-s2', buyStoreIndex: null, status: 'ok' as const, replacesItemId: null, name: 'Chicken Mami', qty: 2, unitPrice: 115, markup: 0, notes: null }, { id: 'it-2', store_id: 's2', menuItemId: 'mi-s2', buyStoreIndex: null, status: 'ok' as const, replacesItemId: null, name: 'Siopao', qty: 2, unitPrice: 45, markup: 0, notes: null }],
      pickupLat: null, pickupLng: null, deliveryAddress: '12 Sampaguita St., Brgy. San Jose (blue gate beside the sari-sari store)', pickupAddress: null, arrivedAt: null, deliveryLat: 14.192, deliveryLng: 121.258, notes: null,
      paymentReceiptUrl: null, paymentReference: null, paymentConfirmedAt: null,
      isTransfer: true, transferReason: 'Flat tire', transferHadGoods: true,
      transferredFromName: 'Ben Cruz', transferredFromContact: '0918 555 2000',
    },
    {
      id: 'ord-food-1', createdAt: minsAgo(26), service_type: 'food', status: 'pending',
      payment_method: 'cod', payment_status: 'unpaid', customerName: 'Maria Santos', recipientName: 'Lola Nena', recipientContact: '0917 999 8888',
      delivery_fee: 50, store_fee_total: 0, convenience_fee: 0, goods_cost: 280, commission_amount: 7.5,
      customer_contact: '0917 111 2222', item_description: null,
      estimated_amount: null, budget_cap: null, actual_amount: null, goodsReceiptUrl: null,
      buyStores: [],
      store_contact: '0918 555 0100', stores: [{ id: 's1', name: 'Barrio Diner', contact: '0918 555 0100', lat: 14.176, lng: 121.244 }],
      items: [{ id: 'it-3', store_id: 's1', menuItemId: 'mi-s1', buyStoreIndex: null, status: 'ok' as const, replacesItemId: null, name: 'Chicken Adobo', qty: 2, unitPrice: 95, markup: 0, notes: null }, { id: 'it-4', store_id: 's1', menuItemId: 'mi-s1', buyStoreIndex: null, status: 'ok' as const, replacesItemId: null, name: 'Extra Rice', qty: 2, unitPrice: 20, markup: 0, notes: null }, { id: 'it-5', store_id: 's1', menuItemId: 'mi-s1', buyStoreIndex: null, status: 'ok' as const, replacesItemId: null, name: 'Softdrink', qty: 1, unitPrice: 50, markup: 0, notes: 'Cold' }],
      pickupLat: null, pickupLng: null, deliveryAddress: '12 Sampaguita St., Brgy. San Jose (blue gate beside the sari-sari store)', pickupAddress: null, arrivedAt: null, deliveryLat: 14.186, deliveryLng: 121.256, notes: 'Extra spicy, leave at the gate.',
      paymentReceiptUrl: null, paymentReference: null, paymentConfirmedAt: null,
      isTransfer: false, transferReason: null, transferHadGoods: false, transferredFromName: null, transferredFromContact: null,
    },
    {
      id: 'ord-pabili-1', createdAt: minsAgo(18), service_type: 'pabili', status: 'pending',
      payment_method: 'cod', payment_status: 'unpaid', customerName: 'Ben Cruz', recipientName: null, recipientContact: null,
      delivery_fee: 60, store_fee_total: 0, convenience_fee: 0, goods_cost: 0, commission_amount: 9,
      customer_contact: '0917 333 4444',
      item_description: '2x paracetamol, 1L milk', estimated_amount: null,
      buyStores: [{ name: 'Botica Central', lat: null, lng: null }, { name: 'Aling Nena Store', lat: null, lng: null }],
      budget_cap: null, actual_amount: null, goodsReceiptUrl: null, store_contact: null, stores: [],
      items: [{ id: 'it-6', store_id: null, menuItemId: null, buyStoreIndex: 0, status: 'ok' as const, replacesItemId: null, name: '2x paracetamol', qty: 1, unitPrice: 0, markup: 0, notes: null }, { id: 'it-7', store_id: null, menuItemId: null, buyStoreIndex: 1, status: 'ok' as const, replacesItemId: null, name: '1L milk', qty: 1, unitPrice: 0, markup: 0, notes: null }],
      pickupLat: null, pickupLng: null, deliveryAddress: '12 Sampaguita St., Brgy. San Jose (blue gate beside the sari-sari store)', pickupAddress: null, arrivedAt: null, deliveryLat: 14.19, deliveryLng: 121.25, notes: null,
      paymentReceiptUrl: null, paymentReference: null, paymentConfirmedAt: null,
      isTransfer: false, transferReason: null, transferHadGoods: false, transferredFromName: null, transferredFromContact: null,
    },
    {
      id: 'ord-padala-1', createdAt: minsAgo(11), service_type: 'padala', status: 'pending',
      payment_method: 'online', payment_status: 'paid', customerName: 'Ana Reyes', recipientName: null, recipientContact: null,
      delivery_fee: 40, store_fee_total: 0, convenience_fee: 0, goods_cost: 0, commission_amount: 6,
      customer_contact: '0917 555 6666', item_description: 'Documents envelope (paid online)',
      estimated_amount: null, budget_cap: null, actual_amount: null, goodsReceiptUrl: null,
      buyStores: [],
      store_contact: null, stores: [],
      items: [{ id: 'it-8', store_id: null, menuItemId: null, buyStoreIndex: null, status: 'ok' as const, replacesItemId: null, name: 'Documents envelope', qty: 1, unitPrice: 0, markup: 0, notes: null }],
      pickupLat: null, pickupLng: null, deliveryAddress: '12 Sampaguita St., Brgy. San Jose (blue gate beside the sari-sari store)', pickupAddress: null, arrivedAt: null, deliveryLat: 14.2, deliveryLng: 121.26, notes: null,
      paymentReceiptUrl: null, paymentReference: null, paymentConfirmedAt: null,
      isTransfer: false, transferReason: null, transferHadGoods: false, transferredFromName: null, transferredFromContact: null,
    },
    {
      id: 'ord-gcash-1', createdAt: minsAgo(4), service_type: 'food', status: 'pending',
      payment_method: 'rider_qr', payment_status: 'unpaid', customerName: 'Josie Lim', recipientName: null, recipientContact: null,
      delivery_fee: 50, store_fee_total: 0, convenience_fee: 15, goods_cost: 245, commission_amount: 7.5,
      customer_contact: '0917 444 3030', item_description: null,
      estimated_amount: null, budget_cap: null, actual_amount: null, goodsReceiptUrl: null,
      buyStores: [],
      store_contact: '0918 555 0100', stores: [{ id: 's1', name: 'Barrio Diner', contact: '0918 555 0100', lat: 14.176, lng: 121.244 }],
      items: [{ id: 'it-9', store_id: 's1', menuItemId: 'mi-s1', buyStoreIndex: null, status: 'ok' as const, replacesItemId: null, name: 'Pork Sisig', qty: 1, unitPrice: 165, markup: 0, notes: null }, { id: 'it-10', store_id: 's1', menuItemId: 'mi-s1', buyStoreIndex: null, status: 'ok' as const, replacesItemId: null, name: 'Rice', qty: 4, unitPrice: 20, markup: 0, notes: null }],
      pickupLat: null, pickupLng: null, deliveryAddress: '12 Sampaguita St., Brgy. San Jose (blue gate beside the sari-sari store)', pickupAddress: null, arrivedAt: null, deliveryLat: 14.19, deliveryLng: 121.25, notes: null,
      paymentReceiptUrl: RECEIPT_PLACEHOLDER, paymentReference: '9012 3456 7890', paymentConfirmedAt: null,
      isTransfer: false, transferReason: null, transferHadGoods: false, transferredFromName: null, transferredFromContact: null,
    },
  ];
  let active: RiderOrder[] = [];
  let online = true;
  const ledger: LedgerEntry[] = [
    // Yesterday, unsettled -> triggers the lock screen.
    { amount: 22.5, businessDay: isoDay(-1), settled: false },
  ];
  const earnings: EarningRecord[] = seedEarnings();
  const declined = new Set<string>();

  return {
    live: false,
    async getOnline() { return online; },
    async setOnline(v) { online = v; return online; },
    async getOpenOrders() { return [...open]; },
    async getActiveOrders() { return [...active]; },
    async getLedger() { return [...ledger]; },
    async getEarnings(fromDay, toDay) { return filterEarnings(earnings, { from: fromDay, to: toDay }); },
    async declineOrder(orderId) { declined.add(orderId); },
    async getDeclinedOrderIds() { return [...declined]; },
    async accept(orderId) {
      const o = open.find((x) => x.id === orderId);
      if (!o) return;
      open = open.filter((x) => x.id !== orderId);
      active = [...active, { ...o, status: 'accepted' }];
    },
    async markSoldOut(itemId) {
      active = active.map((o) => rebill({
        ...o,
        items: o.items.map((i) => (i.id === itemId ? { ...i, status: 'sold_out' as const } : i)),
      }));
    },
    async setBuyStoreLocation(orderId, index, at) {
      // The first store is the order's pickup, so correcting it moves that pin
      // too — that is the one the fee is measured from.
      active = active.map((o) => (o.id === orderId
        ? {
            ...o,
            buyStores: o.buyStores.map((st, i) => (i === index ? { ...st, ...at } : st)),
            ...(index === 0 ? { pickupLat: at.lat, pickupLng: at.lng } : {}),
          }
        : o));
      return { updated: true, repriced: index === 0, moved_m: 0, old_fee: 60, new_fee: 60 };
    },
    async correctDeliveryPin(orderId, at) {
      active = active.map((o) => (o.id === orderId
        ? { ...o, deliveryLat: at.lat, deliveryLng: at.lng } : o));
      return { updated: true, moved_m: 0, old_fee: 50, new_fee: 50 };
    },
    async correctItemPrice(itemId, unitPrice) {
      active = active.map((o) => rebill({
        ...o,
        items: o.items.map((i) => (i.id === itemId ? { ...i, unitPrice } : i)),
      }));
    },
    async proposeReplacement(itemId, name, qty, unitPrice) {
      active = active.map((o) => (o.items.some((i) => i.id === itemId)
        ? {
            ...o,
            items: [
              ...o.items.map((i) => (i.id === itemId ? { ...i, status: 'sold_out' as const } : i)),
              { id: `it-new-${Date.now()}`, store_id: o.items.find((i) => i.id === itemId)?.store_id ?? null,
                menuItemId: null,
                buyStoreIndex: o.items.find((i) => i.id === itemId)?.buyStoreIndex ?? null,
                status: 'proposed' as const, replacesItemId: itemId, name, qty, unitPrice, markup: 0, notes: null },
            ],
          }
        : o)).map(rebill);
    },
    async getAddons() { return []; },
    async respondToAddon() { /* preview: nothing to persist */ },
    async markArrived(orderId) {
      active = active.map((o) => (o.id === orderId ? { ...o, arrivedAt: new Date().toISOString() } : o));
    },
    async confirmPayment(orderId) {
      active = active.map((o) => o.id === orderId
        ? { ...o, payment_status: 'paid' as const, paymentConfirmedAt: new Date().toISOString() }
        : o);
    },
    async releaseOrder(orderId) {
      const o = active.find((x) => x.id === orderId);
      if (!o) return;
      active = active.filter((x) => x.id !== orderId);
      open = [...open, { ...o, status: 'pending' }];
    },
    async advance(order, next: OrderStatus) {
      if (!canTransition(order.service_type, order.status, next)) {
        throw new Error(`Illegal transition ${order.status} → ${next}`);
      }
      if (next === 'delivered') {
        active = active.filter((x) => x.id !== order.id);
        earnings.push({
          orderId: order.id, businessDay: manilaDay(), serviceType: order.service_type,
          deliveryFee: order.delivery_fee, storeFeeTotal: order.store_fee_total,
          convenienceFee: order.convenience_fee, commission: order.commission_amount,
        });
        // Online-paid orders don't add to the rider's books — the operator
        // already holds its commission.
        if (generatesSettlementBalance(order.payment_method)) {
          ledger.push({ amount: order.commission_amount, businessDay: isoDay(0), settled: false });
        }
      } else {
        active = active.map((x) => (x.id === order.id ? { ...x, status: next } : x));
      }
    },
    async setActual(order, amount, receiptUrl) {
      active = active.map((x) =>
        x.id === order.id
          ? { ...x, actual_amount: amount, goods_cost: amount, goodsReceiptUrl: receiptUrl ?? x.goodsReceiptUrl }
          : x);
      return {
        overCap: order.budget_cap == null ? false : needsOverBudgetConfirmation(amount, {
          estimate: order.estimated_amount ?? 0,
          cap: order.budget_cap,
        }),
      };
    },
    async uploadGoodsReceipt(_orderId, file) {
      // Preview has no storage — show the picked file straight from memory.
      return URL.createObjectURL(file);
    },
    async settle(businessDay) {
      // Preview: clear everything up to and including the paid day.
      for (const e of ledger) if (e.businessDay <= businessDay) e.settled = true;
    },
  };
}
