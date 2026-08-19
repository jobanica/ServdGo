import { manilaDay, type EarningRecord, type LedgerEntry, type OrderStatus } from '@servdgo/shared';
import {
  listOpenOrders,
  listRiderActiveOrders,
  listRiderLedger,
  listRiderEarnings,
  acceptOrder,
  releaseOrder,
  advanceOrderStatus,
  updatePabiliActualAmount,
  uploadPabiliReceipt,
  createSettlement,
  riderConfirmPayment,
  riderMarkArrived,
  riderMarkItemSoldOut,
  riderProposeReplacement,
  riderCorrectItemPrice,
  riderSetBuyStoreLocation,
  riderCorrectDeliveryPin,
  listOrderAddons,
  respondToAddon as respondToAddonRpc,
  declineOrder as declineOrderRpc,
  listMyDeclinedOrderIds,
  getRiderOnline,
  setRiderOnline,
  type SupabaseClient,
} from '@servdgo/supabase';
import type { RiderData, RiderOrder } from './types.ts';

function toRiderOrder(row: Record<string, unknown>): RiderOrder {
  return {
    id: row.id as string,
    service_type: row.service_type as RiderOrder['service_type'],
    status: row.status as OrderStatus,
    createdAt: (row.created_at as string) ?? '',
    payment_method: (row.payment_method as RiderOrder['payment_method']) ?? 'cod',
    payment_status: (row.payment_status as RiderOrder['payment_status']) ?? 'unpaid',
    customerName: (row.customer_name as string) ?? null,
    recipientName: (row.recipient_name as string) ?? null,
    recipientContact: (row.recipient_contact as string) ?? null,
    delivery_fee: Number(row.delivery_fee ?? 0),
    store_fee_total: Number(row.store_fee_total ?? 0),
    convenience_fee: Number(row.convenience_fee ?? 0),
    goods_cost: Number(row.goods_cost ?? 0),
    commission_amount: Number(row.commission_amount ?? 0),
    customer_contact: (row.customer_contact as string) ?? '',
    item_description: (row.item_description as string) ?? null,
    estimated_amount: row.estimated_amount == null ? null : Number(row.estimated_amount),
    budget_cap: row.budget_cap == null ? null : Number(row.budget_cap),
    actual_amount: row.actual_amount == null ? null : Number(row.actual_amount),
    goodsReceiptUrl: (row.goods_receipt_url as string) ?? null,
    store_contact: (row.store_contact as string) ?? null,
    // Pabili names its stores ad-hoc on the order; food links registered ones.
    buyStores: Array.isArray(row.buy_stores)
      ? (row.buy_stores as { name: string; lat: number | null; lng: number | null }[])
      : [],
    stores: Array.isArray(row.order_stores)
      ? (row.order_stores as { store: { id: string | null; name: string | null; contact_number: string | null; lat: number | null; lng: number | null } | null }[])
          .map((os) => ({ id: os.store?.id ?? null, name: os.store?.name ?? null, contact: os.store?.contact_number ?? null, lat: os.store?.lat ?? null, lng: os.store?.lng ?? null }))
      : [],
    items: Array.isArray(row.order_items)
      ? (row.order_items as { id: string; store_id: string | null; menu_item_id: string | null; buy_store_index: number | null; name: string; qty: number; unit_price: number; markup_amount: number | null; notes: string | null; status: string | null; replaces_item_id: string | null }[])
          .map((it) => ({
            id: it.id ?? null, store_id: it.store_id ?? null,
            menuItemId: it.menu_item_id ?? null,
            buyStoreIndex: it.buy_store_index == null ? null : Number(it.buy_store_index),
            name: it.name,
            qty: Number(it.qty ?? 1), unitPrice: Number(it.unit_price ?? 0),
            markup: Number(it.markup_amount ?? 0), notes: it.notes ?? null,
            status: (it.status ?? 'ok') as RiderOrder['items'][number]['status'],
            replacesItemId: it.replaces_item_id ?? null,
          }))
      : [],
    pickupLat: row.pickup_lat == null ? null : Number(row.pickup_lat),
    pickupLng: row.pickup_lng == null ? null : Number(row.pickup_lng),
    deliveryLat: row.delivery_lat == null ? null : Number(row.delivery_lat),
    deliveryLng: row.delivery_lng == null ? null : Number(row.delivery_lng),
    deliveryAddress: (row.delivery_address as string) ?? null,
    pickupAddress: (row.pickup_address as string) ?? null,
    arrivedAt: (row.arrived_at as string) ?? null,
    notes: (row.notes as string) ?? null,
    paymentReceiptUrl: (row.payment_receipt_url as string) ?? null,
    paymentReference: (row.payment_reference as string) ?? null,
    paymentConfirmedAt: (row.payment_confirmed_at as string) ?? null,
    isTransfer: Boolean(row.is_transfer),
    transferReason: (row.transfer_reason as string) ?? null,
    transferHadGoods: Boolean(row.transfer_had_goods),
    transferredFromName: (row.transferred_from_name as string) ?? null,
    transferredFromContact: (row.transferred_from_contact as string) ?? null,
  };
}

/** Live Supabase-backed rider data for an authenticated, approved rider. */
export function createLiveData(db: SupabaseClient, riderId: string): RiderData {
  return {
    live: true,
    async getOnline() {
      return getRiderOnline(db, riderId);
    },
    async setOnline(online) {
      return setRiderOnline(db, online);
    },
    async getOpenOrders() {
      return (await listOpenOrders(db)).map((r) => toRiderOrder(r as Record<string, unknown>));
    },
    async getActiveOrders() {
      return (await listRiderActiveOrders(db, riderId)).map((r) => toRiderOrder(r as Record<string, unknown>));
    },
    async getLedger() {
      return (await listRiderLedger(db, riderId)).map((r): LedgerEntry => {
        const row = r as Record<string, unknown>;
        return {
          amount: Number(row.amount ?? 0),
          businessDay: row.business_day as string,
          settled: Boolean(row.settled),
          kind: (row.kind as LedgerEntry['kind']) ?? 'commission',
        };
      });
    },
    async getEarnings(fromDay, toDay) {
      const rows = await listRiderEarnings(db, riderId, fromDay, toDay);
      return (rows as Record<string, unknown>[]).map((row): EarningRecord => ({
        orderId: row.id as string,
        // The business day the ledger books against: the delivery moment in Manila.
        businessDay: manilaDay(new Date(row.delivered_at as string)),
        serviceType: row.service_type as EarningRecord['serviceType'],
        deliveryFee: Number(row.delivery_fee ?? 0),
        storeFeeTotal: Number(row.store_fee_total ?? 0),
        convenienceFee: Number(row.convenience_fee ?? 0),
        commission: Number(row.commission_amount ?? 0),
      }));
    },
    async accept(orderId) {
      await acceptOrder(db, orderId, riderId);
    },
    async declineOrder(orderId) {
      await declineOrderRpc(db, orderId);
    },
    async getDeclinedOrderIds() {
      return listMyDeclinedOrderIds(db, riderId);
    },
    async releaseOrder(orderId, reason) {
      await releaseOrder(db, orderId, reason);
    },
    async markArrived(orderId) {
      await riderMarkArrived(db, orderId);
    },
    async confirmPayment(orderId, note) {
      await riderConfirmPayment(db, orderId, note);
    },
    async markSoldOut(itemId) {
      await riderMarkItemSoldOut(db, itemId);
    },
    async setBuyStoreLocation(orderId, index, at) {
      return riderSetBuyStoreLocation(db, orderId, index, at);
    },
    async correctItemPrice(itemId, unitPrice) {
      await riderCorrectItemPrice(db, itemId, unitPrice);
    },
    async correctDeliveryPin(orderId, at, address) {
      return riderCorrectDeliveryPin(db, orderId, at, address);
    },
    async proposeReplacement(itemId, name, qty, unitPrice) {
      await riderProposeReplacement(db, itemId, name, qty, unitPrice);
    },
    async getAddons(orderId) {
      return listOrderAddons(db, orderId);
    },
    async respondToAddon(addonId, accept) {
      await respondToAddonRpc(db, addonId, accept);
    },
    async advance(order, next) {
      await advanceOrderStatus(db, order, next);
    },
    async setActual(order, amount, receiptUrl) {
      return updatePabiliActualAmount(
        db,
        { id: order.id, estimated_amount: order.estimated_amount, budget_cap: order.budget_cap },
        amount,
        receiptUrl,
      );
    },
    async uploadGoodsReceipt(orderId, file) {
      return uploadPabiliReceipt(db, orderId, file);
    },
    async settle(businessDay, amount, extra) {
      await createSettlement(db, {
        riderId, businessDay, amountDue: amount,
        method: 'gcash', reference: extra?.reference, receiptUrl: extra?.receiptUrl,
      });
    },
  };
}
